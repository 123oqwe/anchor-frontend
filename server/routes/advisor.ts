/**
 * L7 Transport — Advisor routes.
 * Thin HTTP boundary. All business logic delegated to L3 cognition, L2 memory, L4 orchestration.
 */
import { Router, Request, Response } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { bus, type EditableStep, type StepChange } from "../orchestration/bus.js";
import { text } from "../infra/compute/index.js";
import { decide } from "../cognition/decision.js";
import { extractFromMessage } from "../cognition/extractor.js";
import { createNode } from "../graph/writer.js";
import { writeMemory, flushConversationToMemory, checkPeriodicNudge } from "../memory/retrieval.js";
import { trackPlanDecision } from "../cognition/twin.js";

const router = Router();

/** Extract topic tags from a user message for memory tagging. */
function extractConversationTags(message: string): string[] {
  const tagWords: Record<string, string[]> = {
    investor: ["investor", "fundrais", "sequoia", "a16z", "vc", "series", "round", "pitch"],
    product: ["product", "roadmap", "feature", "ship", "launch", "mvp", "build"],
    team: ["co-founder", "cofounder", "cto", "hire", "team", "standup", "alignment"],
    finance: ["runway", "burn", "revenue", "cost", "budget", "spending", "money"],
    health: ["sleep", "energy", "stress", "exercise", "tired", "burnout"],
    decision: ["decide", "decision", "choice", "should i", "prioritize", "focus"],
    relationship: ["meet", "met", "call", "email", "intro", "follow up", "connect"],
  };
  const lower = message.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(tagWords)) {
    if (keywords.some(kw => lower.includes(kw))) tags.push(tag);
  }
  return tags.length > 0 ? tags : ["general"];
}

function logExecution(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── GET history ──────────────────────────────────────────────────────────────

router.get("/history/:mode", (req, res) => {
  const { mode } = req.params;
  const rows = db.prepare("SELECT * FROM messages WHERE user_id=? AND mode=? ORDER BY created_at").all(DEFAULT_USER_ID, mode) as any[];
  res.json(rows.map(r => ({
    id: r.id, role: r.role, content: r.content,
    timestamp: new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    draftType: r.draft_type, draftStatus: r.draft_status, agentName: r.agent_name,
  })));
});

// ── Decision Agent (Personal Advisor) ───────────────────────────────────────

router.post("/personal", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    // Load conversation history
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='personal' ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
    const history = historyRows.reverse().map(r => ({ role: (r.role === "user" ? "user" : "assistant") as "user" | "assistant", content: r.content as string }));

    // L2 Pre-conversation flush: if history is long, save older turns to memory
    flushConversationToMemory(history, "personal");

    // L2 Periodic nudge: check if there's a recurring pattern to surface
    const nudge = checkPeriodicNudge();
    const augmentedMessage = nudge ? `${message}\n\n${nudge}` : message;

    // L3 Cognition — pure reasoning
    const result = await decide(augmentedMessage, history);

    // Persist to messages
    const msgId = nanoid();
    const insertMsg = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
    insertMsg.run(nanoid(), DEFAULT_USER_ID, "personal", "user", message, null, null, null);
    insertMsg.run(msgId, DEFAULT_USER_ID, "personal", result.isPlan ? "draft" : "advisor", result.raw, result.isPlan ? "plan" : null, result.isPlan ? "pending" : null, null);

    logExecution("Decision Agent", `${result.isPlan ? "Plan" : "Advice"}: ${message.substring(0, 60)}`);

    // L2 Memory: record this conversation as episodic memory
    writeMemory({
      type: "episodic",
      title: `Conversation: ${message.slice(0, 50)}`,
      content: `User: ${message.slice(0, 150)} | Anchor: ${result.raw.slice(0, 150)}`,
      tags: extractConversationTags(message),
      source: "Decision Agent",
      confidence: 0.8,
    });

    // L1 Graph growth: debounced extract nodes/edges from user message (non-blocking)
    extractFromMessage(message);

    res.json({
      id: msgId, role: result.isPlan ? "draft" : "advisor", content: result.raw,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      draftType: result.isPlan ? "plan" : undefined, draftStatus: result.isPlan ? "pending" : undefined,
      structured: result.structured,
      // Pass cognitive packet to frontend for transparency
      packet: result.packet ? {
        whyThisNow: result.packet.whyThisNow,
        conflictFlags: result.packet.conflictFlags,
        confidenceScore: result.packet.confidenceScore,
        riskLevel: result.packet.riskLevel,
        boundaryClassification: result.packet.boundaryClassification,
        stagesTrace: result.packet.stagesTrace,
      } : undefined,
    });
  } catch (err: any) {
    console.error("Decision Agent error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Confirm Plan ─────────────────────────────────────────────────────────────

router.post("/confirm", async (req: Request, res: Response) => {
  const { original_steps, user_steps } = req.body;
  if (!Array.isArray(original_steps) || !Array.isArray(user_steps))
    return res.status(400).json({ error: "original_steps and user_steps required" });

  const changes: StepChange[] = [];
  const originalMap = new Map(original_steps.map((s: EditableStep) => [s.id, s]));
  const userIds = new Set(user_steps.map((s: EditableStep) => s.id));

  for (const us of user_steps) {
    const orig = originalMap.get(us.id);
    if (!orig) changes.push({ type: "added", content: us.content });
    else if (orig.content !== us.content) changes.push({ type: "modified", step_id: us.id, before: orig.content, after: us.content });
    else changes.push({ type: "kept", step_id: us.id });
  }
  for (const os of original_steps) {
    if (!userIds.has(os.id)) changes.push({ type: "deleted", step_id: os.id, before: os.content });
  }

  logExecution("Decision Agent", `Plan confirmed: ${user_steps.length} steps, ${changes.filter(c => c.type !== "kept").length} changes`);

  // L1 writeback: record the decision in the graph (short label, steps in detail)
  const firstStep = user_steps[0]?.content?.slice(0, 30) ?? "Plan";
  createNode({ domain: "work", label: `Decision: ${firstStep}`, type: "decision", status: "active", captured: "Plan confirmed by user", detail: user_steps.map((s: any) => s.content).join("; ").slice(0, 200) });

  // L2 Memory: record plan confirmation as episodic memory
  writeMemory({
    type: "episodic",
    title: `Plan confirmed: ${firstStep}`,
    content: `${user_steps.length} steps confirmed. Changes: ${changes.filter(c => c.type !== "kept").length} modifications. Steps: ${user_steps.map((s: any) => s.content).join("; ").slice(0, 150)}`,
    tags: ["decision", "plan", "confirmed"],
    source: "Decision Agent",
    confidence: 0.9,
  });

  bus.publish({ type: "USER_CONFIRMED", payload: { original_steps, user_steps, changes } });
  res.json({ ok: true, changes });
});

// ── Reject Plan ──────────────────────────────────────────────────────────────

router.post("/reject", (req: Request, res: Response) => {
  const { messageId, steps } = req.body;
  const stepSummary = Array.isArray(steps) ? steps.map((s: any) => s.content).join("; ").slice(0, 150) : "";

  // Track rejection for Twin pattern learning
  trackPlanDecision("rejected", stepSummary, Array.isArray(steps) ? steps.length : 0);

  if (messageId) {
    db.prepare("UPDATE messages SET draft_status='rejected' WHERE id=? AND user_id=?").run(messageId, DEFAULT_USER_ID);
  }

  logExecution("Decision Agent", `Plan rejected: ${stepSummary.slice(0, 60)}`);
  res.json({ ok: true });
});

// ── General AI ───────────────────────────────────────────────────────────────

router.post("/general", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='general' ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
    const history = historyRows.reverse().map(r => ({ role: (r.role === "user" ? "user" : "assistant") as "user" | "assistant", content: r.content as string }));

    const content = await text({
      task: "general_chat",
      system: "You are a general-purpose AI assistant embedded in Anchor OS. No access to personal data in this mode. Be concise and helpful.",
      messages: [...history, { role: "user" as const, content: message }],
      maxTokens: 2048,
    });

    const insertMsg = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
    insertMsg.run(nanoid(), DEFAULT_USER_ID, "general", "user", message, null, null, null);
    insertMsg.run(nanoid(), DEFAULT_USER_ID, "general", "advisor", content, null, null, null);

    res.json({ id: nanoid(), role: "advisor", content, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  } catch (err: any) {
    console.error("General AI error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Onboarding ───────────────────────────────────────────────────────────────

router.post("/onboarding/scan", async (_req: Request, res: Response) => {
  const nodes = db.prepare("SELECT domain, COUNT(*) as count FROM graph_nodes WHERE user_id=? GROUP BY domain").all(DEFAULT_USER_ID) as any[];
  const insights = db.prepare("SELECT insight FROM twin_insights WHERE user_id=? LIMIT 4").all(DEFAULT_USER_ID) as any[];
  const totalNodes = db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  res.json({
    domains: nodes.map((n: any) => ({ name: n.domain.charAt(0).toUpperCase() + n.domain.slice(1), nodes: n.count })),
    totalNodes: totalNodes?.c ?? 0,
    insights: insights.map((i: any) => i.insight.substring(0, 60) + "..."),
  });
});

export default router;
