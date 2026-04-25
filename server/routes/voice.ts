/**
 * Voice Webhook — iOS Shortcuts integration.
 *
 * Purpose: bring voice to Anchor without building an audio stack. Users
 * create an iOS Shortcut that:
 *   1. Listens for "Hey Siri, ask Anchor..."
 *   2. Captures the dictated text
 *   3. POSTs to this endpoint (over Tailscale/local network to Mac)
 *   4. Siri reads the returned text aloud
 *
 * Why ship this before a full wake-word + TTS stack:
 *   - Zero audio code on Anchor's side (all STT/TTS handled by iOS)
 *   - Zero install friction for user (Shortcuts is pre-installed on iOS)
 *   - Validates whether voice is actually useful BEFORE we invest 2+ weeks
 *     in Picovoice + Realtime API + Porcupine + local Whisper fallback.
 *
 * Reachability: Mac must be accessible from iOS. Two options:
 *   - Same WiFi: use http://<mac-hostname>.local:3001/api/voice/query
 *   - Anywhere: Tailscale → http://<tailscale-name>:3001/...
 *   - Public: ngrok / Cloudflare Tunnel (NOT recommended — auth gap)
 *
 * Response format: JSON with `reply` (Siri reads this) + `data` (structured,
 * iOS can display). Text stays under 500 chars so Siri doesn't butcher it.
 */
import { Router } from "express";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

const router = Router();

/**
 * POST /api/voice/query
 * Body: { text: string, context?: "general"|"recall"|"check" }
 * Returns: { reply: string, data?: any, runId: string }
 *
 * The `context` hint lets the Shortcut route to different agent personas:
 *   - "recall": lookup in memory / graph ("what was that person's name...")
 *   - "check": status check ("any blocked goals")
 *   - "general" (default): full Decision Agent
 */
router.post("/query", async (req, res) => {
  const body = req.body ?? {};
  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  if (!rawText) return res.status(400).json({ error: "text required" });
  if (rawText.length > 2000) return res.status(400).json({ error: "text too long (max 2000 chars)" });

  const context = ["recall", "check", "general"].includes(body.context) ? body.context : "general";
  const runId = nanoid();

  try {
    const reply = await dispatchByContext(context, rawText, runId);
    res.json({ reply, runId, context });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "voice query failed", runId });
  }
});

/**
 * Shortcut: build a rapid graph-lookup reply without going through the full
 * ReAct agent. Useful for "what was that person's name from last Tuesday"
 * type queries — fast, cheap, no LLM cost.
 */
async function dispatchByContext(
  context: "recall" | "check" | "general",
  text: string, runId: string,
): Promise<string> {
  const { serializeForPrompt } = await import("../graph/reader.js");
  const { text: llmText } = await import("../infra/compute/index.js");

  if (context === "recall") {
    // Shortcut path: search memory + graph, synthesize one-liner
    return await recallFastPath(text, runId, llmText);
  }
  if (context === "check") {
    return await statusCheckFastPath();
  }

  // General: run decision agent with full context
  const graphCtx = serializeForPrompt();
  const system = `You are Anchor's voice-mode assistant. Keep replies under 3 sentences — Siri will read them aloud. Answer concretely, no preamble. Do not say "I". If asked something you cannot answer from the user's Human Graph context, say so briefly.

User's Human Graph snapshot:
${graphCtx}`;
  const reply = await llmText({
    task: "decision",
    system,
    messages: [{ role: "user", content: text }],
    maxTokens: 200,
    runId,
    agentName: "Voice",
  });
  return trimForSiri(reply);
}

async function recallFastPath(text: string, runId: string, llmText: any): Promise<string> {
  const { searchMemories } = await import("../memory/retrieval.js");
  const { queryGraph } = await import("../graph/reader.js");

  // Strip wake phrases / filler the Shortcut might include verbatim
  const query = text.replace(/^(ask|tell me about|who is|who was|what was|remind me|recall|what is|what's)\s+/i, "").trim();

  const memoryHits = searchMemories(query, 5);
  const graphHits = queryGraph({ labelContains: query.split(/\s+/)[0], limit: 5 });

  if (memoryHits.length === 0 && graphHits.length === 0) {
    return `No match for "${query}" in memory or graph.`;
  }

  const context = [
    graphHits.length > 0 ? "GRAPH NODES:\n" + graphHits.map((n: any) => `- [${n.type}] ${n.label}: ${n.detail?.slice(0, 120) ?? ""}`).join("\n") : "",
    memoryHits.length > 0 ? "MEMORIES:\n" + memoryHits.map((m: any) => `- [${m.type}] ${m.title}: ${m.content.slice(0, 200)}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");

  try {
    const reply = await llmText({
      task: "morning_digest", // cheap tier
      system: "Answer the user's recall question in ONE sentence using only the provided context. No preamble. If the answer isn't in the context, say 'Not in my records.'",
      messages: [{ role: "user", content: `Question: ${query}\n\nContext:\n${context}` }],
      maxTokens: 100,
      runId,
      agentName: "Voice:recall",
    });
    return trimForSiri(reply);
  } catch {
    // LLM unavailable — fall back to raw best-match
    if (graphHits.length > 0) return `${graphHits[0].label}: ${graphHits[0].detail?.slice(0, 150) ?? "(no detail)"}`;
    return memoryHits[0].title + ": " + memoryHits[0].content.slice(0, 150);
  }
}

async function statusCheckFastPath(): Promise<string> {
  // Pure-query one-liner. No LLM needed.
  const blocked = (db.prepare(
    `SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=? AND status='blocked'`
  ).get(DEFAULT_USER_ID) as any).c;
  const decaying = (db.prepare(
    `SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=? AND status='decaying'`
  ).get(DEFAULT_USER_ID) as any).c;
  const openArbitrations = (db.prepare(
    `SELECT COUNT(*) as c FROM memory_arbitrations WHERE user_id=? AND status='open'`
  ).get(DEFAULT_USER_ID) as any).c;
  const recentCommits = (db.prepare(
    `SELECT COUNT(*) as c FROM timeline_events WHERE user_id=? AND kind='commit' AND datetime(occurred_at) >= datetime('now','-1 day')`
  ).get(DEFAULT_USER_ID) as any).c;

  const parts: string[] = [];
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (decaying > 0) parts.push(`${decaying} decaying`);
  if (openArbitrations > 0) parts.push(`${openArbitrations} memory arbitration${openArbitrations > 1 ? "s" : ""} waiting`);
  parts.push(`${recentCommits} commit${recentCommits === 1 ? "" : "s"} today`);
  return parts.join(", ") + ".";
}

function trimForSiri(s: string): string {
  const cleaned = s.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 500) return cleaned;
  // Cut at last sentence boundary under 500 chars
  const cut = cleaned.slice(0, 500);
  const lastPeriod = cut.lastIndexOf(".");
  return lastPeriod > 200 ? cut.slice(0, lastPeriod + 1) : cut;
}

/**
 * GET /api/voice/shortcut-guide
 * Returns a human-readable setup guide for configuring iOS Shortcut.
 * Displayed in Settings → Voice in the frontend.
 */
router.get("/shortcut-guide", (req, res) => {
  const host = (req.headers.host ?? "localhost:3001");
  res.json({
    endpoint: `http://${host}/api/voice/query`,
    steps: [
      "On iPhone, open the Shortcuts app.",
      "Tap + to create a new Shortcut. Name it 'Ask Anchor'.",
      "Add action: 'Dictate Text'. Language: your preference.",
      "Add action: 'Get Contents of URL'. Method: POST.",
      "    URL: <your Mac's Tailscale or local hostname>:3001/api/voice/query",
      "    Headers: Content-Type = application/json",
      "    Request Body (JSON): { \"text\": <dictated text from prior step> }",
      "Add action: 'Get Dictionary Value' — key: reply",
      "Add action: 'Speak Text' — Input: the value from prior step",
      "Settings → Add to Siri → say 'Hey Siri, Ask Anchor' to trigger.",
      "Test: 'Hey Siri, Ask Anchor, who is Kevin'",
    ],
    notes: [
      "For over-internet access, install Tailscale on Mac + iPhone (free tier) and use your Mac's Tailscale DNS name.",
      "Body param `context` can be 'recall' | 'check' | 'general' — route to different response styles.",
    ],
  });
});

export default router;
