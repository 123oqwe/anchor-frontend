/**
 * Built-in workflow definitions. Registered at boot.
 *
 * Currently migrates the nightly cognitive-consolidation pipeline from
 * "parallel blind crons" into an explicit DAG. The pre-existing cron
 * entries in cron.ts are kept during the transition — set
 * ANCHOR_WORKFLOW_MIGRATION=true to disable the legacy crons and let the
 * workflow own the schedule.
 */
import { registerWorkflow, type WorkflowDef } from "./workflow.js";
import { schedule as nodeCronSchedule } from "node-cron";
import { runWorkflow } from "./workflow.js";

const WORKFLOWS: WorkflowDef[] = [
  {
    id: "nightly_consolidation",
    description:
      "Nightly memory+cognition DAG. Dream compacts memory; evolution/feedback then read fresh memory; diagnostic checks the consolidated state. Old cron model let digest fire at 8am with stale memory if dream crashed at 3am — this DAG cascades skip instead.",
    schedule: "0 3 * * *",   // 03:00 local
    jobs: [
      { id: "dream", handler: "dream.run", timeoutMs: 10 * 60_000 },
      { id: "decay_edges", handler: "graph.close_stale_edges", dependsOn: ["dream"] },
      { id: "evolution", handler: "evolution.run", dependsOn: ["dream"] },
      { id: "feedback_detect", handler: "feedback.detect", dependsOn: ["dream"], continueOnError: true },
      { id: "diagnostic", handler: "diagnostic.run", dependsOn: ["evolution"], continueOnError: true },
    ],
  },
  {
    id: "weekly_insight",
    description:
      "Weekly learning pipeline. GEPA analyzes trace quality and generates mutation proposals (doesn't apply). Eval-gate then scores each proposal against Phase-B fixtures; only accepted proposals deploy. Twin reflects; growth card summarizes. Eval failures are logged, not silently swallowed.",
    schedule: "0 5 * * 0",   // Sunday 05:00
    jobs: [
      { id: "gepa", handler: "gepa.analyze", timeoutMs: 5 * 60_000 },
      // Eval-gate: NEW — route GEPA's proposed route_overrides through
      // Phase-B fixtures before applying. Rejects regressions.
      { id: "evaluate_gepa", handler: "proposals.evaluate_pending",
        params: { source: "gepa" },
        dependsOn: ["gepa"], timeoutMs: 10 * 60_000, continueOnError: true },
      { id: "apply_gepa", handler: "proposals.apply_accepted",
        params: { source: "gepa" },
        dependsOn: ["evaluate_gepa"], continueOnError: true },
      { id: "twin_reflect", handler: "twin.reflect_weekly", dependsOn: ["gepa"], continueOnError: true },
      { id: "growth_card", handler: "graph.weekly_growth_card", dependsOn: ["twin_reflect"], continueOnError: true },
    ],
  },
  {
    id: "profile_auto_refresh",
    description:
      "Daily staleness check → conditional inferProfile. check_staleness is cheap SQL; if it says refresh, the downstream infer job fires (heavy LLM call). Otherwise the infer job skips via upstreamOutputs. Prevents both drift ('3-week-old Portrait') and wasteful re-inference when nothing changed.",
    schedule: "0 6 * * *",   // Daily 06:00 — after nightly_consolidation (03:00)
    jobs: [
      { id: "check_staleness", handler: "profile.check_staleness", timeoutMs: 30_000 },
      { id: "infer", handler: "profile.infer", dependsOn: ["check_staleness"], timeoutMs: 5 * 60_000, continueOnError: true },
    ],
  },
  {
    id: "weekly_backup",
    description:
      "Weekly encrypted backup. Runs standalone (no data dependency).",
    schedule: "30 2 * * 0",  // Sunday 02:30
    jobs: [
      { id: "backup", handler: "backup.encrypted", timeoutMs: 5 * 60_000 },
    ],
  },
];

export function registerBuiltinWorkflows(): void {
  for (const def of WORKFLOWS) registerWorkflow(def);
}

/**
 * Install node-cron hooks so scheduled workflows fire on time. The
 * pre-existing cron.ts still has legacy entries for backward compat —
 * this adds workflow-driven entries on top. Migration: once a workflow
 * handles all jobs for a legacy schedule, delete the legacy cron entry.
 */
export function scheduleWorkflows(): void {
  for (const def of WORKFLOWS) {
    if (!def.schedule) continue;
    nodeCronSchedule(def.schedule, async () => {
      try { await runWorkflow(def.id, { triggerKind: "schedule" }); }
      catch (err: any) { console.error(`[Workflow] scheduled run of ${def.id} failed:`, err.message); }
    });
    console.log(`[Workflow] scheduled ${def.id} — ${def.schedule}`);
  }
}
