import { schedule } from "node-cron";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { invalidateSnapshot, writeMemory } from "../memory/retrieval.js";
import { runDream } from "../memory/dream.js";
import { detectDrift } from "../cognition/twin.js";
import { checkProactiveTriggers } from "./enforcement.js";
import { markStaleAsDecaying } from "../graph/writer.js";
import { runIngestion } from "../integrations/pipeline.js";
import { captureActiveWindow, updateGraphFromActivity } from "../integrations/local/activity-monitor.js";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── Every day 08:00 — Morning Digest ────────────────────────────────────────
schedule("0 8 * * *", async () => {
  console.log("[Cron] Morning Digest starting...");
  try {
    const nodes = db.prepare(
      "SELECT label, status, detail FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed','decaying') ORDER BY status"
    ).all(DEFAULT_USER_ID) as any[];
    const state = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
    if (!nodes.length) return;

    const content = await text({
      task: "morning_digest",
      system: "You are Anchor's Morning Digest Agent. Write a 3-bullet daily briefing. Be direct and specific. No fluff.",
      messages: [{
        role: "user",
        content: `State: Energy ${state?.energy}/100, Focus ${state?.focus}/100, Stress ${state?.stress}/100\n\nItems needing attention:\n${nodes.map((n: any) => `[${n.status}] ${n.label}: ${n.detail}`).join("\n")}`,
      }],
      maxTokens: 400,
    });

    db.prepare(
      "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
    ).run(nanoid(), DEFAULT_USER_ID, "working", `Morning Digest — ${new Date().toLocaleDateString()}`, content, JSON.stringify(["digest", "daily"]), "Observation Agent", 0.9);
    log("Observation Agent", "Morning digest generated");
  } catch (err: any) {
    console.error("[Cron] Morning Digest failed:", err.message);
    log("Observation Agent", "Morning digest failed", "failed");
  }
});

// ── Every 6 hours — Decay Checker ───────────────────────────────────────────
schedule("0 */6 * * *", () => {
  try {
    const changed = markStaleAsDecaying(5); // 5 days
    if (changed > 0) log("Observation Agent", `Decay check: ${changed} nodes marked decaying`);
  } catch (err: any) {
    console.error("[Cron] Decay Checker failed:", err.message);
  }
});

// ── Every Monday 09:00 — Weekly Twin Reflection ──────────────────────────────
schedule("0 9 * * 1", async () => {
  console.log("[Cron] Weekly Twin Reflection starting...");
  try {
    const execs = db.prepare(
      "SELECT agent, action, status FROM agent_executions WHERE user_id=? AND created_at >= datetime('now','-7 days') ORDER BY created_at"
    ).all(DEFAULT_USER_ID) as any[];
    const doneTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='done' AND created_at >= datetime('now','-7 days')").get() as any;

    const reflectionText = await text({
      task: "weekly_reflection",
      system: `You are Anchor's Twin Agent doing weekly reflection. Extract ONE behavioral pattern.\nRespond ONLY with valid JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Week: ${execs.length} executions, ${doneTasks?.c ?? 0} tasks done, ${execs.filter((e: any) => e.status === "failed").length} failures.\n\n${execs.slice(-20).map((e: any) => `[${e.status}] ${e.agent}: ${e.action}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    const jsonMatch = reflectionText.match(/\{[^}]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare("INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);
      log("Twin Agent", "Weekly reflection complete");
    }

    // Drift detection: compare recent vs older insights
    await detectDrift();
  } catch (err: any) {
    console.error("[Cron] Weekly reflection failed:", err.message);
    log("Twin Agent", "Weekly reflection failed", "failed");
  }
});

// ── Every day 22:00 — Stale Task Detector ────────────────────────────────────
schedule("0 22 * * *", () => {
  try {
    const result = db.prepare("UPDATE tasks SET status='blocked' WHERE status='in-progress' AND julianday('now') - julianday(created_at) > 7").run();
    if (result.changes > 0) log("Workspace Agent", `${result.changes} stale tasks marked blocked`);
  } catch (err: any) {
    console.error("[Cron] Stale Task Detector failed:", err.message);
  }
});

// ── Every day 03:00 — Dream Consolidation ────────────────────────────────────
schedule("0 3 * * *", async () => {
  try {
    const stats = await runDream();
    invalidateSnapshot(); // force memory snapshot refresh after dream
    const total = stats.pruned + stats.merged + stats.promoted + stats.skillsCreated + stats.timeNormalized + stats.capacityRemoved;
    if (total > 0) {
      log("Dream Engine", `Dream: p=${stats.pruned} m=${stats.merged} pro=${stats.promoted} sk=${stats.skillsCreated} t=${stats.timeNormalized} cap=${stats.capacityRemoved}`);
    }
  } catch (err: any) {
    console.error("[Cron] Dream consolidation failed:", err.message);
  }
});

// ── Every 6 hours — Ingestion Pipeline (Gmail + Calendar scan) ───────────────
schedule("0 */6 * * *", async () => {
  try {
    const result = await runIngestion(DEFAULT_USER_ID, "incremental");
    if (result && result.eventsFetched > 0) {
      log("Ingestion Pipeline", `Incremental: ${result.eventsFetched} events → ${result.nodesCreated} nodes`);
    }
  } catch (err: any) {
    console.error("[Cron] Ingestion failed:", err.message);
  }
});

// ── Every 12 hours — Proactive Suggestion Check ─────────────────────────────
schedule("0 */12 * * *", () => {
  try {
    const trigger = checkProactiveTriggers();
    if (trigger) {
      // Write proactive suggestion as working memory (will appear in next Decision context)
      writeMemory({
        type: "working",
        title: `Proactive: ${trigger.reason}`,
        content: `System detected: ${trigger.reason}. Consider addressing this proactively.`,
        tags: ["proactive", "system-triggered"],
        source: "Orchestrator",
        confidence: 0.85,
      });
      log("Orchestrator", `Proactive trigger: ${trigger.reason}`);
      console.log(`[Cron] Proactive: ${trigger.reason}`);
    }
  } catch (err: any) {
    console.error("[Cron] Proactive check failed:", err.message);
  }
});

// ── Every 5 minutes — Activity Capture ──────────────────────────────────────
schedule("*/5 * * * *", () => {
  try {
    captureActiveWindow();
  } catch {}
});

// ── Every 6 hours — Update Graph from Activity ──────────────────────────────
schedule("30 */6 * * *", () => {
  try {
    const result = updateGraphFromActivity();
    if (result.updated > 0) log("Activity Monitor", `Updated ${result.updated} nodes from activity data`);
    for (const insight of result.insights) {
      log("Activity Monitor", insight);
    }
  } catch (err: any) {
    console.error("[Cron] Activity update failed:", err.message);
  }
});

export function startCronJobs() {
  // Start first capture immediately
  try { captureActiveWindow(); } catch {}
  console.log("⏰ Cron: Activity(5min) | Digest(8am) | Decay(6h) | Twin(Mon 9am) | Tasks(10pm) | Dream(3am) | Proactive(3h) | GraphUpdate(6h)");
}
