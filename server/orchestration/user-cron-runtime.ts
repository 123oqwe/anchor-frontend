/**
 * User-Cron Runtime — cron-pattern scheduler.
 *
 * Reads user_crons (enabled=1), registers one node-cron task per row. When
 * a cron fires, it no longer runs the action directly — it ENQUEUES a job
 * onto the Task Brain ledger. The worker in task-brain.ts owns execution,
 * retry, and state tracking.
 *
 * This split is the Kubernetes-style separation: cron is the CronJob
 * controller, Task Brain is the Pod scheduler+executor.
 */
import cron, { type ScheduledTask } from "node-cron";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { enqueueJob } from "./task-brain.js";
import { parseCronConfig, shouldCronFire, recordCronFireInVitality } from "../cognition/agent-config.js";

interface UserCronRow {
  id: string;
  name: string;
  cron_pattern: string;
  action_type: string;
  action_config: string;
  enabled: number;
  config_json?: string;
}

const scheduled = new Map<string, { task: ScheduledTask; pattern: string; actionType: string }>();
let pollTimer: NodeJS.Timeout | null = null;

export function startUserCronRuntime(): void {
  refreshFromDb();
  pollTimer = setInterval(refreshFromDb, 60_000);
  console.log("⏰ User-cron runtime started (polling every 60s, enqueues to Task Brain on fire)");
}

export function stopUserCronRuntime(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  scheduled.forEach((s) => { try { s.task.stop(); } catch {} });
  scheduled.clear();
}

function refreshFromDb(): void {
  let rows: UserCronRow[];
  try {
    rows = db.prepare(
      "SELECT id, name, cron_pattern, action_type, action_config, enabled, config_json FROM user_crons WHERE user_id=? AND enabled=1"
    ).all(DEFAULT_USER_ID) as UserCronRow[];
  } catch (err: any) {
    console.error("[UserCron] DB read failed:", err.message);
    return;
  }

  const activeIds = new Set(rows.map(r => r.id));

  // Stop tasks for rows that no longer exist / disabled / pattern changed
  for (const [id, s] of Array.from(scheduled.entries())) {
    if (!activeIds.has(id)) {
      try { s.task.stop(); } catch {}
      scheduled.delete(id);
      continue;
    }
    const row = rows.find(r => r.id === id);
    if (row && (row.cron_pattern !== s.pattern || row.action_type !== s.actionType)) {
      try { s.task.stop(); } catch {}
      scheduled.delete(id);
    }
  }

  // Register new tasks
  for (const row of rows) {
    if (scheduled.has(row.id)) continue;
    if (!cron.validate(row.cron_pattern)) {
      console.error(`[UserCron] Invalid pattern "${row.cron_pattern}" on cron ${row.id} (${row.name})`);
      continue;
    }
    try {
      const task = cron.schedule(row.cron_pattern, () => { fireCron(row); });
      scheduled.set(row.id, { task, pattern: row.cron_pattern, actionType: row.action_type });
    } catch (err: any) {
      console.error(`[UserCron] Failed to schedule ${row.name}:`, err.message);
    }
  }
}

function fireCron(row: UserCronRow): void {
  let cfg: any = {};
  try { cfg = JSON.parse(row.action_config ?? "{}"); } catch {}

  // Pre-fire gates: snooze + conditions. The cron's structured config (Phase 1)
  // can declare both. If snoozed → silently skip. If conditions fail → log
  // *why* but don't enqueue.
  // Context for conditions: minimal but extensible — currently exposes user_state
  // and current time. Add more fields here as conditions reference them.
  const cronConfig = parseCronConfig(row.config_json);
  const userState = (() => {
    try {
      return db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
    } catch { return {}; }
  })();
  const context = {
    user_state: userState ?? {},
    now: new Date().toISOString(),
    hour: new Date().getHours(),
    day_of_week: new Date().getDay(),
  };
  const gate = shouldCronFire(cronConfig, context);
  if (!gate.fire) {
    logExecution(`Cron: ${row.name}`, `Skipped: ${gate.reason}`, "skipped");
    return;
  }

  try {
    const jobId = enqueueJob({
      source: "cron",
      sourceId: row.id,
      actionType: row.action_type,
      actionConfig: cfg,
      name: row.name,
    });
    logExecution(`Cron: ${row.name}`, `Enqueued as job ${jobId} (${row.action_type})`);

    // Vitality tick: best-effort. Persisting the updated config keeps
    // last_fired_at + fire_count visible to user via GET /api/crons.
    try {
      const updated = recordCronFireInVitality(cronConfig, { success: true });
      db.prepare("UPDATE user_crons SET config_json=? WHERE id=?")
        .run(JSON.stringify(updated), row.id);
    } catch {}
  } catch (err: any) {
    logExecution(`Cron: ${row.name}`, `Enqueue failed: ${err.message}`, "failed");
    try {
      const updated = recordCronFireInVitality(cronConfig, { success: false, error: err?.message });
      db.prepare("UPDATE user_crons SET config_json=? WHERE id=?")
        .run(JSON.stringify(updated), row.id);
    } catch {}
  }
}

export function getScheduledCronStatus() {
  const list: { id: string; pattern: string; actionType: string; running: boolean }[] = [];
  scheduled.forEach((s, id) => {
    list.push({ id, pattern: s.pattern, actionType: s.actionType, running: true });
  });
  return { count: scheduled.size, tasks: list };
}
