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

const router = Router();

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

    // L3 Cognition — pure reasoning
    const result = await decide(message, history);

    // Persist to messages
    const msgId = nanoid();
    const insertMsg = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
    insertMsg.run(nanoid(), DEFAULT_USER_ID, "personal", "user", message, null, null, null);
    insertMsg.run(msgId, DEFAULT_USER_ID, "personal", result.isPlan ? "draft" : "advisor", result.raw, result.isPlan ? "plan" : null, result.isPlan ? "pending" : null, null);

    logExecution("Decision Agent", `${result.isPlan ? "Plan" : "Advice"}: ${message.substring(0, 60)}`);

    // L1 Graph growth: async extract nodes/edges from user message (non-blocking)
    extractFromMessage(message).catch(err => console.error("[Extractor] Error:", err.message));

    res.json({
      id: msgId, role: result.isPlan ? "draft" : "advisor", content: result.raw,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      draftType: result.isPlan ? "plan" : undefined, draftStatus: result.isPlan ? "pending" : undefined,
      structured: result.structured,
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

  // L1 writeback: record the decision in the graph
  const stepSummary = user_steps.map((s: any) => s.content).join("; ").slice(0, 100);
  createNode({ domain: "work", label: `Decision: ${stepSummary}`, type: "decision", status: "active", captured: "Plan confirmed by user", detail: `${user_steps.length} steps confirmed` });

  bus.publish({ type: "USER_CONFIRMED", payload: { original_steps, user_steps, changes } });
  res.json({ ok: true, changes });
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
