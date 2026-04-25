import { schedule } from "node-cron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { writeMemory } from "../memory/retrieval.js";
import { detectDrift } from "../cognition/twin.js";
import { checkProactiveTriggers } from "./enforcement.js";
import { markStaleAsDecaying } from "../graph/writer.js";
import { runIngestion } from "../integrations/pipeline.js";
import { captureActiveWindow, updateGraphFromActivity } from "../integrations/local/activity-monitor.js";
import { runSystemEvolution } from "./system-evolution.js";
import { isCronSnoozed, isCronDisabled } from "../cognition/system-cron-overrides.js";

/**
 * Wrap a cron callback with the user-snooze + user-disabled gate. Phase 2
 * Mode C — every system cron gets the same lifecycle controls (snooze for
 * vacation, fully disable for "stop bothering me forever") without duplicating
 * the gate code at every site. Sync callbacks work too — `void | Promise<void>`.
 */
function gated(
  cronId: string,
  agentName: string,
  fn: () => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    if (isCronSnoozed(cronId)) {
      logExecution(agentName, `${cronId} skipped — user-snoozed`, "skipped");
      return;
    }
    if (isCronDisabled(cronId)) {
      logExecution(agentName, `${cronId} skipped — user disabled`, "skipped");
      return;
    }
    await fn();
  };
}

// ── Every day 08:00 — Morning Digest ────────────────────────────────────────
schedule("0 8 * * *", gated("morning_digest", "Observation Agent", async () => {
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
    logExecution("Observation Agent", "Morning digest generated");
  } catch (err: any) {
    console.error("[Cron] Morning Digest failed:", err.message);
    logExecution("Observation Agent", "Morning digest failed", "failed");
  }
}));

// ── Every 6 hours — Decay Checker ───────────────────────────────────────────
schedule("0 */6 * * *", gated("decay_checker", "Observation Agent", () => {
  try {
    const changed = markStaleAsDecaying(5); // 5 days
    if (changed > 0) logExecution("Observation Agent", `Decay check: ${changed} nodes marked decaying`);
  } catch (err: any) {
    console.error("[Cron] Decay Checker failed:", err.message);
  }
}));

// NOTE: feedback_detectors / weekly_backup / weekly_growth_card / edge_staleness
// removed — owned by `nightly_consolidation` and `weekly_insight` and
// `weekly_backup` workflow DAGs in workflow-defs.ts. Keeping both fired the
// same handler twice and risked race conditions.

// ── Every Monday 09:00 — Weekly Twin Reflection ──────────────────────────────
schedule("0 9 * * 1", gated("twin_weekly_reflection", "Twin Agent", async () => {
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
      logExecution("Twin Agent", "Weekly reflection complete");
    }

    // Drift detection: compare recent vs older insights
    await detectDrift();
  } catch (err: any) {
    console.error("[Cron] Weekly reflection failed:", err.message);
    logExecution("Twin Agent", "Weekly reflection failed", "failed");
  }
}));

// ── Every day 22:00 — Stale Task Detector ────────────────────────────────────
schedule("0 22 * * *", gated("stale_task_detector", "Workspace Agent", () => {
  try {
    const result = db.prepare("UPDATE tasks SET status='blocked' WHERE status='in-progress' AND julianday('now') - julianday(created_at) > 7").run();
    if (result.changes > 0) logExecution("Workspace Agent", `${result.changes} stale tasks marked blocked`);
  } catch (err: any) {
    console.error("[Cron] Stale Task Detector failed:", err.message);
  }
}));

// NOTE: dream cron removed — owned by `nightly_consolidation` workflow.
// Activity-captures cleanup moved into the workflow's dream.run handler so
// nothing is silently dropped.

// ── Every 6 hours — Ingestion Pipeline (Gmail + Calendar scan) ───────────────
schedule("0 */6 * * *", gated("ingestion_pipeline", "Ingestion Pipeline", async () => {
  try {
    const result = await runIngestion(DEFAULT_USER_ID, "incremental");
    if (result && result.eventsFetched > 0) {
      logExecution("Ingestion Pipeline", `Incremental: ${result.eventsFetched} events → ${result.nodesCreated} nodes`);
    }
  } catch (err: any) {
    console.error("[Cron] Ingestion failed:", err.message);
  }
}));

// ── Every 12 hours — Proactive Suggestion Check ─────────────────────────────
schedule("0 */12 * * *", gated("proactive_check", "Orchestrator", () => {
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
      logExecution("Orchestrator", `Proactive trigger: ${trigger.reason}`);
      console.log(`[Cron] Proactive: ${trigger.reason}`);
    }
  } catch (err: any) {
    console.error("[Cron] Proactive check failed:", err.message);
  }
}));

// ── Every 5 minutes — Activity Capture ──────────────────────────────────────
schedule("*/5 * * * *", gated("activity_capture", "Activity Monitor", () => {
  try {
    captureActiveWindow();
  } catch (err) { console.error("[Cron] Activity capture failed:", err); }
}));

// ── Every 6 hours — Update Graph from Activity ──────────────────────────────
schedule("30 */6 * * *", gated("graph_update_activity", "Activity Monitor", () => {
  try {
    const result = updateGraphFromActivity();
    if (result.updated > 0) logExecution("Activity Monitor", `Updated ${result.updated} nodes from activity data`);
    for (const insight of result.insights) {
      logExecution("Activity Monitor", insight);
    }
  } catch (err: any) {
    console.error("[Cron] Activity update failed:", err.message);
  }
}));

// ── Every day 02:55 — SQLite Backup (before Dream Engine) ─────────────────
schedule("55 2 * * *", gated("sqlite_backup", "Backup", () => {
  try {
    const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "infra", "anchor.db");
    const backupDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "infra", "backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `anchor-${date}.db`);

    // SQLite backup API
    db.backup(backupPath).then(() => {
      logExecution("Backup", `Daily backup saved: anchor-${date}.db`);
      console.log(`[Cron] Backup saved: ${backupPath}`);

      // Cleanup: keep only last 7 days
      const files = fs.readdirSync(backupDir).filter(f => f.startsWith("anchor-") && f.endsWith(".db")).sort();
      while (files.length > 7) {
        const old = files.shift()!;
        fs.unlinkSync(path.join(backupDir, old));
        console.log(`[Cron] Deleted old backup: ${old}`);
      }
    }).catch((err: any) => {
      console.error("[Cron] Backup failed:", err.message);
      logExecution("Backup", "Daily backup failed", "failed");
    });
  } catch (err: any) {
    console.error("[Cron] Backup setup failed:", err.message);
  }
}));

// NOTE: personal_evolution + gepa_analysis removed — owned by
// `nightly_consolidation.evolution` and `weekly_insight.gepa` workflow jobs.

// ── Every Sunday 06:00 — System Evolution (model routing optimization) ────
schedule("0 6 * * 0", gated("system_evolution", "System Evolution", async () => {
  console.log("[Cron] System Evolution starting...");
  try {
    const result = await runSystemEvolution();
    if (result.routesUpdated > 0) {
      logExecution("System Evolution", `Applied ${result.routesUpdated} routing changes`);
    }
  } catch (err: any) {
    console.error("[Cron] System Evolution failed:", err.message);
    logExecution("System Evolution", "System evolution failed", "failed");
  }
}));

// NOTE: self_diagnostic cron removed — owned by `nightly_consolidation.diagnostic`.
// Inactive-user skip can be re-added inside the workflow handler if it matters.

export function startCronJobs() {
  // Start first capture immediately
  try { captureActiveWindow(); } catch (err) { console.error("[Cron] Initial capture failed:", err); }
  console.log("⏰ Cron (legacy survivors): Activity(5min) | Digest(8am) | Decay(6h) | Twin(Mon 9am) | Tasks(10pm) | Ingest(6h) | Proactive(12h) | GraphUpdate(6h) | SqliteBackup(2:55am) | SysEvo(Sun 6am) — heavy cognitive jobs now run via workflow DAGs");
}
