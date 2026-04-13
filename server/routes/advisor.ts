import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { db, DEFAULT_USER_ID } from "../db.js";
import { nanoid } from "nanoid";
import { bus } from "../events.js";

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── helpers ─────────────────────────────────────────────────────────────────

function getGraphContext(): string {
  const nodes = db.prepare("SELECT domain, label, type, status, detail FROM graph_nodes WHERE user_id=? ORDER BY domain").all(DEFAULT_USER_ID) as any[];
  if (!nodes.length) return "No Human Graph data yet.";
  const byDomain: Record<string, string[]> = {};
  for (const n of nodes) {
    if (!byDomain[n.domain]) byDomain[n.domain] = [];
    byDomain[n.domain].push(`  - [${n.type}] ${n.label} (${n.status}): ${n.detail}`);
  }
  return Object.entries(byDomain).map(([d, items]) => `${d.toUpperCase()}:\n${items.join("\n")}`).join("\n\n");
}

function getMemoryContext(): string {
  const mems = db.prepare("SELECT type, title, content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
  if (!mems.length) return "No memory data yet.";
  return mems.map(m => `[${m.type}] ${m.title}: ${m.content}`).join("\n");
}

function getTwinContext(): string {
  const insights = db.prepare("SELECT category, insight, confidence FROM twin_insights WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
  if (!insights.length) return "No behavioral insights yet.";
  return insights.map(i => `${i.category} (${Math.round(i.confidence * 100)}% confidence): ${i.insight}`).join("\n");
}

function getStateContext(): string {
  const s = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  if (!s) return "";
  return `Current state — Energy: ${s.energy}/100, Focus: ${s.focus}/100, Stress: ${s.stress}/100`;
}

function saveMessages(mode: string, userContent: string, assistantContent: string, extra: Record<string, any> = {}) {
  const insertMsg = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
  insertMsg.run(nanoid(), DEFAULT_USER_ID, mode, "user", userContent, null, null, null);
  insertMsg.run(nanoid(), DEFAULT_USER_ID, mode, extra.role ?? "advisor", assistantContent, extra.draftType ?? null, extra.draftStatus ?? null, extra.agentName ?? null);
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
    id: r.id,
    role: r.role,
    content: r.content,
    timestamp: new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    draftType: r.draft_type,
    draftStatus: r.draft_status,
    agentName: r.agent_name,
  })));
});

// ── Personal Advisor ─────────────────────────────────────────────────────────

router.post("/personal", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const graphCtx = getGraphContext();
  const memCtx = getMemoryContext();
  const twinCtx = getTwinContext();
  const stateCtx = getStateContext();

  const systemPrompt = `You are Anchor's Personal Advisor — an intimate AI that knows the user deeply through their Human Graph and behavioral patterns.

Your role: Give sharp, personal, actionable advice based entirely on the user's actual situation. Reference specific items from their graph. Call out avoidance patterns directly. Be direct, warm, and insightful. Keep responses concise (2-4 sentences or a short structured plan).

${stateCtx}

HUMAN GRAPH:
${graphCtx}

BEHAVIORAL MEMORY:
${memCtx}

TWIN INSIGHTS:
${twinCtx}

When creating plans or drafts, format them as markdown with clear steps. Mark time estimates when relevant.`;

  try {
    // Build conversation history for context
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='personal' ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
    const historyMsgs = historyRows.reverse().map(r => ({ role: (r.role === "advisor" ? "assistant" : "user") as "user" | "assistant", content: r.content as string }));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [...historyMsgs, { role: "user" as const, content: message }],
    });

    const content = (response.content[0] as any).text as string;
    const isDraft = content.includes("**") && (content.includes("1.") || content.includes("→") || content.includes("Step"));
    const draftType = isDraft ? (content.toLowerCase().includes("email") ? "email" : "plan") : undefined;

    saveMessages("personal", message, content, {
      role: isDraft ? "draft" : "advisor",
      draftType,
      draftStatus: isDraft ? "pending" : null,
    });

    logExecution("Decision Agent", `Responded to: ${message.substring(0, 60)}`);

    res.json({
      id: nanoid(),
      role: isDraft ? "draft" : "advisor",
      content,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      draftType,
      draftStatus: isDraft ? "pending" : undefined,
    });
  } catch (err: any) {
    console.error("Personal advisor error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── General AI ───────────────────────────────────────────────────────────────

router.post("/general", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const systemPrompt = `You are a general-purpose AI assistant — like Claude, but embedded in Anchor OS. You have no access to the user's personal data in this mode. Help with research, analysis, writing, brainstorming, coding, and any other task. Be concise and helpful.`;

  try {
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='general' ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
    const historyMsgs = historyRows.reverse().map(r => ({ role: (r.role === "advisor" ? "assistant" : "user") as "user" | "assistant", content: r.content as string }));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [...historyMsgs, { role: "user" as const, content: message }],
    });

    const content = (response.content[0] as any).text as string;
    saveMessages("general", message, content);

    res.json({
      id: nanoid(),
      role: "advisor",
      content,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  } catch (err: any) {
    console.error("General AI error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Mode ───────────────────────────────────────────────────────────────

router.post("/agent", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const graphCtx = getGraphContext();

  const systemPrompt = `You are Anchor's Agent Orchestrator. When the user describes a task, you create a specialized agent plan.

HUMAN GRAPH CONTEXT:
${graphCtx}

When given a task, respond with a structured agent creation plan in this exact format:
**Agent Created: [Descriptive Agent Name]**

Objective: [one clear sentence]

Plan:
→ Step 1: [specific action]
→ Step 2: [specific action]
→ Step 3: [specific action]
→ Step 4: Present results for your approval

Estimated: [time estimate]

Make the plan specific, referencing the user's actual Human Graph data when relevant. Be concise.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    const content = (response.content[0] as any).text as string;
    const agentNameMatch = content.match(/\*\*Agent Created: (.+?)\*\*/);
    const agentName = agentNameMatch ? agentNameMatch[1] : "Custom Task Agent";

    saveMessages("agent", message, content, {
      role: "agent-action",
      draftType: "agent",
      draftStatus: "pending",
      agentName,
    });

    logExecution("Execution Agent", `Created agent: ${agentName}`);

    res.json({
      id: nanoid(),
      role: "agent-action",
      content,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      draftType: "agent",
      draftStatus: "pending",
      agentName,
    });
  } catch (err: any) {
    console.error("Agent mode error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Draft approval ───────────────────────────────────────────────────────────

router.post("/drafts/:id/approve", (req, res) => {
  db.prepare("UPDATE messages SET draft_status='approved' WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  logExecution("Execution Agent", `Draft approved: ${req.params.id}`);

  // Fire event → triggers Execution Agent → Twin Agent → Memory Agent
  const msg = db.prepare("SELECT content FROM messages WHERE id=?").get(req.params.id) as any;
  if (msg) {
    bus.publish({ type: "DRAFT_APPROVED", payload: { messageId: req.params.id, content: msg.content } });
  }

  res.json({ ok: true });
});

router.post("/drafts/:id/reject", (req, res) => {
  db.prepare("UPDATE messages SET draft_status='rejected' WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// ── Onboarding ───────────────────────────────────────────────────────────────

router.post("/onboarding/scan", async (req: Request, res: Response) => {
  // Simulate a brief scan then return graph summary
  const nodes = db.prepare("SELECT domain, COUNT(*) as count FROM graph_nodes WHERE user_id=? GROUP BY domain").all(DEFAULT_USER_ID) as any[];
  const insights = db.prepare("SELECT insight FROM twin_insights WHERE user_id=? LIMIT 4").all(DEFAULT_USER_ID) as any[];
  const totalNodes = db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any;

  res.json({
    domains: nodes.map(n => ({
      name: n.domain.charAt(0).toUpperCase() + n.domain.slice(1),
      nodes: n.count,
    })),
    totalNodes: totalNodes?.c ?? 0,
    insights: insights.map(i => i.insight.substring(0, 60) + "..."),
  });
});

export default router;
