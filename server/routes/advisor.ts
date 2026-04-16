import { Router, Request, Response } from "express";
import { db, DEFAULT_USER_ID } from "../db.js";
import { nanoid } from "nanoid";
import { bus, type EditableStep, type StepChange } from "../events.js";
import { text } from "../cortex/index.js";

const router = Router();

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

  const systemPrompt = `You are Anchor's Decision Agent. You know the user through their Human Graph and behavioral patterns.

${getStateContext()}

HUMAN GRAPH:
${getGraphContext()}

BEHAVIORAL MEMORY:
${getMemoryContext()}

TWIN INSIGHTS (user behavioral priors):
${getTwinContext()}

RULES:
1. For actionable requests, respond with a JSON object containing editable steps the user can modify.
2. For conversational questions, respond with plain text advice (2-3 sentences, direct, personal).
3. When producing steps, reference specific items from the graph. Factor in twin insights.
4. Always output valid JSON when you detect the user wants a plan, action, or task list.

JSON FORMAT (when actionable):
{
  "type": "plan",
  "suggestion_summary": "One sentence explaining your recommendation",
  "reasoning": "Why this approach, referencing graph/twin data",
  "editable_steps": [
    { "id": 1, "content": "Specific action", "time_estimate": "20min" },
    { "id": 2, "content": "Another action", "time_estimate": "1h" }
  ],
  "risk_level": "low" | "high",
  "referenced_nodes": ["node labels referenced"]
}

PLAIN TEXT FORMAT (when conversational):
Just respond naturally in 2-3 sentences. Be direct and personal.`;

  try {
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='personal' ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
    const historyMsgs = historyRows.reverse().map(r => ({ role: (r.role === "user" ? "user" : "assistant") as "user" | "assistant", content: r.content as string }));

    const raw = await text({
      task: "decision",
      system: systemPrompt,
      messages: [...historyMsgs, { role: "user" as const, content: message }],
      maxTokens: 1024,
    });

    let parsed: any = null;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {}

    const isPlan = parsed?.type === "plan" && Array.isArray(parsed?.editable_steps);
    const msgId = nanoid();

    const insertMsg = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
    insertMsg.run(nanoid(), DEFAULT_USER_ID, "personal", "user", message, null, null, null);
    insertMsg.run(msgId, DEFAULT_USER_ID, "personal", isPlan ? "draft" : "advisor", raw, isPlan ? "plan" : null, isPlan ? "pending" : null, null);

    logExecution("Decision Agent", `${isPlan ? "Plan" : "Advice"}: ${message.substring(0, 60)}`);

    res.json({
      id: msgId, role: isPlan ? "draft" : "advisor", content: raw,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      draftType: isPlan ? "plan" : undefined, draftStatus: isPlan ? "pending" : undefined,
      structured: isPlan ? parsed : undefined,
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
  bus.publish({ type: "USER_CONFIRMED", payload: { original_steps, user_steps, changes } });
  res.json({ ok: true, changes });
});

// ── General AI ───────────────────────────────────────────────────────────────

router.post("/general", async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='general' ORDER BY created_at DESC LIMIT 10").all(DEFAULT_USER_ID) as any[];
    const historyMsgs = historyRows.reverse().map(r => ({ role: (r.role === "user" ? "user" : "assistant") as "user" | "assistant", content: r.content as string }));

    const content = await text({
      task: "general_chat",
      system: "You are a general-purpose AI assistant embedded in Anchor OS. No access to personal data in this mode. Be concise and helpful.",
      messages: [...historyMsgs, { role: "user" as const, content: message }],
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
