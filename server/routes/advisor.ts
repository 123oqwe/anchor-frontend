/**
 * L7 Transport — Advisor routes.
 * Thin HTTP boundary. All business logic delegated to L3 cognition, L2 memory, L4 orchestration.
 */
import { Router, Request, Response } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { z } from "zod";
import { bus, type EditableStep, type StepChange } from "../orchestration/bus.js";
import { text } from "../infra/compute/index.js";
import { decide } from "../cognition/decision.js";
import { extractFromMessage } from "../cognition/extractor.js";
import { createNode } from "../graph/writer.js";
import { writeMemory, flushConversationToMemory, checkPeriodicNudge } from "../memory/retrieval.js";
import { trackPlanDecision } from "../cognition/twin.js";
import { tryCrystallizeSkill, evolveSkill, penalizeSkill } from "../cognition/skills.js";

// ── Zod schemas ─────────────────────────────────────────────────────────────
const MessageBody = z.object({ message: z.string().min(1) });
const UniversalBody = z.object({ message: z.string().min(1), context: z.string().optional() });
const ConfirmBody = z.object({
  original_steps: z.array(z.object({ id: z.any(), content: z.string() }).passthrough()),
  user_steps: z.array(z.object({ id: z.any(), content: z.string() }).passthrough()),
});
const RejectBody = z.object({
  messageId: z.string().optional(),
  steps: z.array(z.any()).optional(),
});

/** Record a satisfaction signal. */
function recordSatisfaction(signalType: string, context: string, value: number) {
  db.prepare("INSERT INTO satisfaction_signals (id, user_id, signal_type, context, value) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, signalType, context, value);
}

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
  const parsed = MessageBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { message } = parsed.data;

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
  const parsed = ConfirmBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { original_steps, user_steps } = parsed.data;

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

  const editCount = changes.filter(c => c.type !== "kept").length;
  const editRatio = user_steps.length > 0 ? editCount / user_steps.length : 0;
  logExecution("Decision Agent", `Plan confirmed: ${user_steps.length} steps, ${editCount} changes`);

  // Satisfaction: plan confirmed = positive, edit ratio = modification signal
  recordSatisfaction("plan_confirmed", `${user_steps.length} steps`, 1.0);
  if (editRatio > 0) {
    recordSatisfaction("plan_modified", `${editCount}/${user_steps.length} steps edited`, 1.0 - editRatio);
  }

  // L1 writeback: record the decision in the graph (short label, steps in detail)
  const firstStep = user_steps[0]?.content?.slice(0, 30) ?? "Plan";
  createNode({ domain: "work", label: `Decision: ${firstStep}`, type: "decision", status: "active", captured: "Plan confirmed by user", detail: user_steps.map((s: any) => s.content).join("; ").slice(0, 200) });

  // Note: plan decision memory is recorded by Twin's trackPlanDecision() in handlers.ts
  // No duplicate writeMemory here.

  bus.publish({ type: "USER_CONFIRMED", payload: { original_steps, user_steps, changes } });

  // Skills: try to crystallize a new skill from confirmed patterns (non-blocking)
  const stepContents = user_steps.map((s: any) => s.content);
  tryCrystallizeSkill(stepContents, editRatio).catch(() => {});

  // Skills: if this plan was generated from a skill, evolve it based on user edits
  // (skill_source is embedded in the plan JSON by buildSkillBasedPlan)
  try {
    const lastDraft = db.prepare("SELECT content FROM messages WHERE user_id=? AND role='draft' ORDER BY created_at DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
    if (lastDraft?.content) {
      const draftParsed = JSON.parse(lastDraft.content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      if (draftParsed.skill_source) {
        if (editRatio > 0) {
          evolveSkill(draftParsed.skill_source, stepContents);
        }
      }
    }
  } catch {}

  res.json({ ok: true, changes });
});

// ── Reject Plan ──────────────────────────────────────────────────────────────

router.post("/reject", (req: Request, res: Response) => {
  const parsed = RejectBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { messageId, steps } = parsed.data;
  const stepSummary = Array.isArray(steps) ? steps.map((s: any) => s.content).join("; ").slice(0, 150) : "";

  // Satisfaction: plan rejected = negative signal
  recordSatisfaction("plan_rejected", stepSummary.slice(0, 100), -1.0);

  // Track rejection for Twin pattern learning
  trackPlanDecision("rejected", stepSummary, Array.isArray(steps) ? steps.length : 0);

  if (messageId) {
    db.prepare("UPDATE messages SET draft_status='rejected' WHERE id=? AND user_id=?").run(messageId, DEFAULT_USER_ID);
  }

  // Skills: if rejected plan was from a skill, penalize it
  try {
    if (messageId) {
      const msg = db.prepare("SELECT content FROM messages WHERE id=? AND user_id=?").get(messageId, DEFAULT_USER_ID) as any;
      if (msg?.content) {
        const draftParsed = JSON.parse(msg.content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        if (draftParsed.skill_source) {
          penalizeSkill(draftParsed.skill_source);
        }
      }
    }
  } catch {}

  logExecution("Decision Agent", `Plan rejected: ${stepSummary.slice(0, 60)}`);
  res.json({ ok: true });
});

// ── First Insight (called after Onboarding) ─────────────────────────────────

router.post("/first-insight", async (req: Request, res: Response) => {
  try {
    const history: any[] = [];
    const result = await decide(
      "Based on everything you know about me from my graph, give me the ONE most important thing I should focus on right now and WHY. Be specific, personal, and direct. Reference my actual goals and constraints.",
      history
    );

    // Save as working memory so it persists
    writeMemory({
      type: "working",
      title: "First Insight",
      content: result.raw.slice(0, 300),
      tags: ["onboarding", "first-insight"],
      source: "Decision Agent",
      confidence: 0.9,
    });

    res.json({
      content: result.raw,
      structured: result.structured,
      packet: result.packet ? {
        whyThisNow: result.packet.whyThisNow,
        confidenceScore: result.packet.confidenceScore,
      } : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Universal Input (talk to Anchor from any page) ──────────────────────────

router.post("/universal", async (req: Request, res: Response) => {
  const parsed = UniversalBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { message, context } = parsed.data;

  try {
    const historyRows = db.prepare("SELECT role, content FROM messages WHERE user_id=? AND mode='personal' ORDER BY created_at DESC LIMIT 5").all(DEFAULT_USER_ID) as any[];
    const history = historyRows.reverse().map(r => ({ role: (r.role === "user" ? "user" : "assistant") as "user" | "assistant", content: r.content as string }));

    // Add page context if provided — sanitize to prevent prompt injection
    const ALLOWED_PAGES = ["Dashboard", "Advisor", "Twin", "Memory", "Workspace", "Settings", "Admin"];
    const safeContext = context && ALLOWED_PAGES.some(p => context.startsWith(p)) ? context.replace(/[\n\r\[\]]/g, " ").slice(0, 50) : undefined;
    const augmented = safeContext ? `[Context: user is on ${safeContext}]\n${message}` : message;

    const result = await decide(augmented, history);

    const msgId = nanoid();
    const insertMsg = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
    insertMsg.run(nanoid(), DEFAULT_USER_ID, "personal", "user", message, null, null, null);
    insertMsg.run(msgId, DEFAULT_USER_ID, "personal", result.isPlan ? "draft" : "advisor", result.raw, result.isPlan ? "plan" : null, result.isPlan ? "pending" : null, null);

    writeMemory({ type: "episodic", title: `Conversation: ${message.slice(0, 50)}`, content: `User: ${message.slice(0, 150)} | Anchor: ${result.raw.slice(0, 150)}`, tags: extractConversationTags(message), source: "Decision Agent", confidence: 0.8 });
    extractFromMessage(message);

    res.json({
      id: msgId, role: result.isPlan ? "draft" : "advisor", content: result.raw,
      structured: result.structured,
      packet: result.packet ? { whyThisNow: result.packet.whyThisNow, conflictFlags: result.packet.conflictFlags, confidenceScore: result.packet.confidenceScore } : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── What happened while you were away ───────────────────────────────────────

router.get("/digest", (_req, res) => {
  // Get recent agent activity + proactive suggestions + new insights
  const recentExecs = db.prepare(
    "SELECT agent, action, status, created_at FROM agent_executions WHERE user_id=? AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 15"
  ).all(DEFAULT_USER_ID) as any[];

  const newInsights = db.prepare(
    "SELECT category, insight, confidence, created_at FROM twin_insights WHERE user_id=? AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 5"
  ).all(DEFAULT_USER_ID) as any[];

  const workingMems = db.prepare(
    "SELECT title, content, created_at FROM memories WHERE user_id=? AND type='working' AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 5"
  ).all(DEFAULT_USER_ID) as any[];

  const urgentNodes = db.prepare(
    "SELECT label, status, detail FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed','decaying') ORDER BY CASE status WHEN 'overdue' THEN 0 WHEN 'delayed' THEN 1 ELSE 2 END LIMIT 5"
  ).all(DEFAULT_USER_ID) as any[];

  res.json({
    agentActivity: recentExecs.length,
    recentActions: recentExecs.slice(0, 5).map((e: any) => ({
      agent: e.agent, action: e.action.slice(0, 80), status: e.status, at: e.created_at,
    })),
    newInsights: newInsights.map((i: any) => ({ category: i.category, insight: i.insight, confidence: i.confidence })),
    workingMemory: workingMems.map((m: any) => ({ title: m.title, content: m.content.slice(0, 100) })),
    urgentItems: urgentNodes.map((n: any) => ({ label: n.label, status: n.status, detail: n.detail.slice(0, 80) })),
    hasUpdates: recentExecs.length > 0 || newInsights.length > 0 || urgentNodes.length > 0,
  });
});

// ── General AI ───────────────────────────────────────────────────────────────

router.post("/general", async (req: Request, res: Response) => {
  const parsed = MessageBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { message } = parsed.data;

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
