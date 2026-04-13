/**
 * Event handlers — downstream agents triggered by bus events.
 */
import Anthropic from "@anthropic-ai/sdk";
import { bus, type AnchorEvent } from "./events.js";
import { db, DEFAULT_USER_ID } from "./db.js";
import { nanoid } from "nanoid";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── DRAFT_APPROVED → Execution Agent ────────────────────────────────────────
async function onDraftApproved(payload: { messageId: string; content: string }) {
  console.log("[Execution Agent] Running...");
  log("Execution Agent", `Plan received: ${payload.content.slice(0, 60)}`);

  try {
    // Extract steps from the plan (matches "→ Step N: ..." or "1. ...")
    const arrowSteps = payload.content.match(/→ Step \d+:\s*(.+)/g) ?? [];
    const numberedSteps = payload.content.match(/^\d+\.\s+(.+)/gm) ?? [];
    const rawSteps = [...arrowSteps, ...numberedSteps]
      .map(s => s.replace(/^(→ Step \d+:\s*|\d+\.\s*)/, "").trim())
      .filter(s => s.length > 3 && !s.toLowerCase().includes("present results"));

    // Write steps as tasks in the most recent project
    const project = db.prepare(
      "SELECT id FROM projects WHERE user_id=? ORDER BY created_at DESC LIMIT 1"
    ).get(DEFAULT_USER_ID) as any;

    if (project && rawSteps.length > 0) {
      for (const step of rawSteps) {
        db.prepare(
          "INSERT INTO tasks (id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?)"
        ).run(nanoid(), project.id, step, "todo", "high", JSON.stringify(["auto", "from-plan"]));
      }
      log("Execution Agent", `Created ${rawSteps.length} tasks from approved plan`);
    }

    // Advance the top delayed/overdue graph node to active
    const staleNode = db.prepare(
      "SELECT id, label FROM graph_nodes WHERE user_id=? AND status IN ('delayed','overdue') ORDER BY created_at LIMIT 1"
    ).get(DEFAULT_USER_ID) as any;

    if (staleNode) {
      db.prepare("UPDATE graph_nodes SET status='active', updated_at=datetime('now') WHERE id=?")
        .run(staleNode.id);
      log("Execution Agent", `Graph node promoted: "${staleNode.label}" → active`);
      bus.publish({ type: "GRAPH_UPDATED", payload: { nodeId: staleNode.id, status: "active", label: staleNode.label } });
    }

    bus.publish({
      type: "EXECUTION_DONE",
      payload: { planSummary: payload.content.slice(0, 200), changes: rawSteps.length },
    });
  } catch (err: any) {
    console.error("[Execution Agent] Error:", err.message);
    log("Execution Agent", "Execution failed", "failed");
  }
}

// ── EXECUTION_DONE → Twin Agent ──────────────────────────────────────────────
async function onExecutionDone(payload: { planSummary: string; changes: number }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[Twin Agent] Skipped — no ANTHROPIC_API_KEY");
    return;
  }
  console.log("[Twin Agent] Updating behavioral model...");

  try {
    const recentExecs = db.prepare(
      "SELECT agent, action, status FROM agent_executions WHERE user_id=? ORDER BY created_at DESC LIMIT 15"
    ).all(DEFAULT_USER_ID) as any[];

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are Anchor's Twin Agent. Extract ONE behavioral insight from recent activity.
Respond ONLY with valid JSON (no markdown): {"category":"decision_making|avoidance|productivity|relationships|follow_through","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Completed plan: ${payload.planSummary}\nNew tasks created: ${payload.changes}\n\nRecent executions:\n${recentExecs.map(e => `[${e.status}] ${e.agent}: ${e.action}`).join("\n")}`,
      }],
    });

    const text = (response.content[0] as any).text as string;
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error("No JSON in Twin response");

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare(
        "INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)"
      ).run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);

      log("Twin Agent", `Insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
      console.log("[Twin Agent] New insight saved.");
    }
  } catch (err: any) {
    console.error("[Twin Agent] Error:", err.message);
    log("Twin Agent", `Insight extraction failed: ${err.message}`, "failed");
  }
}

// ── TWIN_UPDATED → Memory Agent (persist as semantic memory) ─────────────────
function onTwinUpdated(payload: { insight: string }) {
  db.prepare(
    "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
  ).run(
    nanoid(), DEFAULT_USER_ID,
    "semantic",
    "Behavioral Pattern Detected",
    payload.insight,
    JSON.stringify(["twin", "auto-generated"]),
    "Twin Agent",
    0.75
  );
  log("Memory Agent", `Semantic memory stored from Twin insight`);
  console.log("[Memory Agent] Twin insight persisted to semantic memory.");
}

// ── TASK_COMPLETED → Twin Agent (XP grant) ───────────────────────────────────
function onTaskCompleted(payload: { taskId: string; title: string }) {
  const evo = db.prepare(
    "SELECT xp, level FROM twin_evolution WHERE user_id=?"
  ).get(DEFAULT_USER_ID) as any;
  if (!evo) return;

  const xpGain = 5;
  const newXp = evo.xp + xpGain;
  const newLevel = Math.min(4, Math.floor(newXp / 100) + 1);

  db.prepare("UPDATE twin_evolution SET xp=?, level=?, updated_at=datetime('now') WHERE user_id=?")
    .run(newXp, newLevel, DEFAULT_USER_ID);

  log("Twin Agent", `+${xpGain} XP for completing: "${payload.title.slice(0, 40)}"`);
  console.log(`[Twin Agent] +${xpGain} XP (total: ${newXp})`);
}

// ── Wire all handlers ────────────────────────────────────────────────────────
export function startEventHandlers() {
  bus.on("event", (e: AnchorEvent) => {
    switch (e.type) {
      case "DRAFT_APPROVED":  onDraftApproved(e.payload);  break;
      case "EXECUTION_DONE":  onExecutionDone(e.payload);  break;
      case "TWIN_UPDATED":    onTwinUpdated(e.payload);    break;
      case "TASK_COMPLETED":  onTaskCompleted(e.payload);  break;
    }
  });
  console.log("⚡ Event handlers active: DRAFT_APPROVED → Execution → Twin → Memory");
}
