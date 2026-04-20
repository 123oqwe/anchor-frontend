import { schedule } from "node-cron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { invalidateSnapshot, writeMemory } from "../memory/retrieval.js";
import { runDream } from "../memory/dream.js";
import { detectDrift } from "../cognition/twin.js";
import { checkProactiveTriggers } from "./enforcement.js";
import { markStaleAsDecaying } from "../graph/writer.js";
import { runIngestion } from "../integrations/pipeline.js";
import { captureActiveWindow, updateGraphFromActivity, cleanupOldCaptures } from "../integrations/local/activity-monitor.js";
import { runPersonalEvolution } from "../cognition/evolution.js";
import { analyzeExecutionTraces } from "../cognition/gepa.js";
import { runSystemEvolution } from "./system-evolution.js";
import { runDiagnostic } from "../cognition/diagnostic.js";

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
    logExecution("Observation Agent", "Morning digest generated");
  } catch (err: any) {
    console.error("[Cron] Morning Digest failed:", err.message);
    logExecution("Observation Agent", "Morning digest failed", "failed");
  }
});

// ── Every 6 hours — Decay Checker ───────────────────────────────────────────
schedule("0 */6 * * *", () => {
  try {
    const changed = markStaleAsDecaying(5); // 5 days
    if (changed > 0) logExecution("Observation Agent", `Decay check: ${changed} nodes marked decaying`);
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
      logExecution("Twin Agent", "Weekly reflection complete");
    }

    // Drift detection: compare recent vs older insights
    await detectDrift();
  } catch (err: any) {
    console.error("[Cron] Weekly reflection failed:", err.message);
    logExecution("Twin Agent", "Weekly reflection failed", "failed");
  }
});

// ── Every day 22:00 — Stale Task Detector ────────────────────────────────────
schedule("0 22 * * *", () => {
  try {
    const result = db.prepare("UPDATE tasks SET status='blocked' WHERE status='in-progress' AND julianday('now') - julianday(created_at) > 7").run();
    if (result.changes > 0) logExecution("Workspace Agent", `${result.changes} stale tasks marked blocked`);
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
      logExecution("Dream Engine", `Dream: p=${stats.pruned} m=${stats.merged} pro=${stats.promoted} sk=${stats.skillsCreated} t=${stats.timeNormalized} cap=${stats.capacityRemoved}`);
    }
    // Also cleanup old activity captures (keep 30 days)
    try { const cleaned = cleanupOldCaptures(); if (cleaned > 0) logExecution("Dream Engine", `Cleaned ${cleaned} old activity captures`); } catch (err) { console.error("[Cron] Activity cleanup failed:", err); }
  } catch (err: any) {
    console.error("[Cron] Dream consolidation failed:", err.message);
  }
});

// ── Every 6 hours — Ingestion Pipeline (Gmail + Calendar scan) ───────────────
schedule("0 */6 * * *", async () => {
  try {
    const result = await runIngestion(DEFAULT_USER_ID, "incremental");
    if (result && result.eventsFetched > 0) {
      logExecution("Ingestion Pipeline", `Incremental: ${result.eventsFetched} events → ${result.nodesCreated} nodes`);
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
      logExecution("Orchestrator", `Proactive trigger: ${trigger.reason}`);
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
  } catch (err) { console.error("[Cron] Activity capture failed:", err); }
});

// ── Every 6 hours — Update Graph from Activity ──────────────────────────────
schedule("30 */6 * * *", () => {
  try {
    const result = updateGraphFromActivity();
    if (result.updated > 0) logExecution("Activity Monitor", `Updated ${result.updated} nodes from activity data`);
    for (const insight of result.insights) {
      logExecution("Activity Monitor", insight);
    }
  } catch (err: any) {
    console.error("[Cron] Activity update failed:", err.message);
  }
});

// ── Every day 02:55 — SQLite Backup (before Dream Engine) ─────────────────
schedule("55 2 * * *", () => {
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
});

// ── Every day 04:00 — Personal Evolution Engine ───────────────────────────
schedule("0 4 * * *", async () => {
  console.log("[Cron] Personal Evolution starting...");
  try {
    const result = await runPersonalEvolution();
    if (result.dimensionsUpdated.length > 0) {
      logExecution("Evolution Engine", `Evolved: ${result.dimensionsUpdated.join(", ")} (${result.signalsProcessed} signals)`);
    }
  } catch (err: any) {
    console.error("[Cron] Evolution failed:", err.message);
    logExecution("Evolution Engine", "Evolution failed", "failed");
  }
});

// ── Every Sunday 05:00 — GEPA Execution Trace Analysis ────────────────────
schedule("0 5 * * 0", async () => {
  console.log("[Cron] GEPA analysis starting...");
  try {
    const result = await analyzeExecutionTraces(7);
    if (result.wastePatterns.length > 0 || result.optimizations.length > 0) {
      logExecution("GEPA Optimizer", `Weekly: ${result.wastePatterns.length} waste, ${result.optimizations.length} opts, efficiency=${result.efficiency}%`);
    }
  } catch (err: any) {
    console.error("[Cron] GEPA failed:", err.message);
    logExecution("GEPA Optimizer", "GEPA analysis failed", "failed");
  }
});

// ── Every Sunday 06:00 — System Evolution (model routing optimization) ────
schedule("0 6 * * 0", async () => {
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
});

// ── Every Sunday 07:00 — Self-Diagnostic Agent ────────────────────────────
schedule("0 7 * * 0", () => {
  // Skip if user inactive > 7 days
  const lastMsg = db.prepare("SELECT MAX(created_at) as last FROM messages WHERE user_id=? AND role='user'").get(DEFAULT_USER_ID) as any;
  const inactiveDays = lastMsg?.last ? (Date.now() - new Date(lastMsg.last).getTime()) / 86400000 : 999;
  if (inactiveDays > 7) {
    console.log("[Cron] Diagnostic skipped — user inactive for " + Math.round(inactiveDays) + " days");
    return;
  }

  console.log("[Cron] Self-Diagnostic starting...");
  try {
    const report = runDiagnostic();
    const criticals = report.alerts.filter(a => a.severity === "critical").length;
    const warnings = report.alerts.filter(a => a.severity === "warning").length;
    logExecution("Diagnostic Agent", `Phase ${report.phase}: ${criticals}C ${warnings}W ${report.fixesApplied.length} fixes`);
  } catch (err: any) {
    console.error("[Cron] Diagnostic failed:", err.message);
    logExecution("Diagnostic Agent", "Diagnostic failed", "failed");
  }
});

export function startCronJobs() {
  // Start first capture immediately
  try { captureActiveWindow(); } catch (err) { console.error("[Cron] Initial capture failed:", err); }
  console.log("⏰ Cron: Activity(5min) | Digest(8am) | Decay(6h) | Twin(Mon 9am) | Tasks(10pm) | Dream(3am) | Evolution(4am) | GEPA(Sun 5am) | SysEvo(Sun 6am) | Diagnostic(Sun 7am) | Proactive(12h) | GraphUpdate(6h)");
}
