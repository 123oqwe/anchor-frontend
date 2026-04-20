/**
 * Task Brain — unified job ledger + worker (OpenClaw-inspired).
 *
 * Any scheduled or triggered action becomes a row in agent_jobs with full
 * state-machine lifecycle: pending → running → succeeded / failed / retrying
 * / cancelled. A worker polls every 5s, atomically claims pending rows,
 * executes them (same dispatch logic that used to live in user-cron-runtime),
 * and updates state. Failures get exponential backoff retries.
 *
 * Why rebuild?
 *   Old path: cron fires → executeAction() → if it fails, it's gone.
 *   New path: cron fires → enqueueJob() → worker claims → runs → retries on
 *             fail → user can see history, cancel pending, force retry.
 *
 * The worker is also the ENTRY POINT for ad-hoc dispatch. Anything in Anchor
 * (event triggers, channels, agent delegate calls) can enqueue a job and the
 * Task Brain handles lifecycle uniformly.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { bus } from "./bus.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type JobSource = "cron" | "manual" | "trigger" | "channel" | "delegate";
export type JobState = "pending" | "running" | "succeeded" | "failed" | "retrying" | "cancelled";

export interface JobEnqueueOpts {
  source: JobSource;
  sourceId?: string;         // e.g. cron id, agent id, trigger id
  actionType: string;        // send_email | create_calendar_event | browser_navigate | desktop_automate | dev_delegate | remind | run_agent
  actionConfig: any;
  name: string;
  delayMs?: number;          // schedule for later (0 = immediate)
  maxAttempts?: number;      // default 3
  runId?: string;            // pre-assigned if enqueuer wants trace correlation
}

export interface JobRow {
  id: string;
  source: JobSource;
  source_id: string | null;
  action_type: string;
  action_config: string;
  name: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  result_summary: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// ── Config ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENT_JOBS = 4;
const STUCK_RUNNING_TIMEOUT_MS = 5 * 60_000; // jobs 'running' > 5 min are presumed crashed

/** Exponential-ish backoff in seconds — 1m, 5m, 30m, 2h, 6h (cap). */
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

// ── Enqueue ─────────────────────────────────────────────────────────────────

export function enqueueJob(opts: JobEnqueueOpts): string {
  const id = nanoid();
  const delaySec = Math.max(0, Math.floor((opts.delayMs ?? 0) / 1000));
  // Use SQLite's own datetime() so format matches everywhere (string comparison
  // breaks if we mix ISO "T...Z" with SQLite's "YYYY-MM-DD HH:MM:SS").
  db.prepare(`
    INSERT INTO agent_jobs
      (id, source, source_id, action_type, action_config, name, state, attempts, max_attempts, next_run_at, run_id)
    VALUES (?,?,?,?,?,?,?,?,?, datetime('now', '+' || ? || ' seconds'), ?)
  `).run(
    id,
    opts.source,
    opts.sourceId ?? null,
    opts.actionType,
    JSON.stringify(opts.actionConfig ?? {}),
    opts.name,
    "pending",
    0,
    opts.maxAttempts ?? 3,
    delaySec,
    opts.runId ?? null,
  );
  return id;
}

// ── Query helpers ───────────────────────────────────────────────────────────

export function listJobs(opts: {
  state?: JobState | JobState[];
  limit?: number;
  source?: JobSource;
} = {}): JobRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = [];
  const args: any[] = [];
  if (opts.state) {
    const states = Array.isArray(opts.state) ? opts.state : [opts.state];
    where.push(`state IN (${states.map(() => "?").join(",")})`);
    args.push(...states);
  }
  if (opts.source) { where.push("source=?"); args.push(opts.source); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  return db.prepare(
    `SELECT * FROM agent_jobs ${whereSql} ORDER BY created_at DESC LIMIT ?`
  ).all(...args, limit) as JobRow[];
}

export function getJob(id: string): JobRow | null {
  return (db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(id) as JobRow | undefined) ?? null;
}

export function cancelJob(id: string): boolean {
  const r = db.prepare(
    "UPDATE agent_jobs SET state='cancelled', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND state IN ('pending','retrying')"
  ).run(id);
  return r.changes > 0;
}

export function retryJob(id: string): boolean {
  const r = db.prepare(
    `UPDATE agent_jobs
       SET state='pending', attempts=0, last_error=NULL, next_run_at=datetime('now'),
           started_at=NULL, finished_at=NULL, updated_at=datetime('now')
     WHERE id=? AND state IN ('failed','cancelled')`
  ).run(id);
  return r.changes > 0;
}

// ── Worker ──────────────────────────────────────────────────────────────────

let pollTimer: NodeJS.Timeout | null = null;
let activeJobs = 0;

export function startTaskBrain(): void {
  // Unstick anything that was 'running' when we last crashed
  const stuck = db.prepare(
    `UPDATE agent_jobs
       SET state='retrying', next_run_at=datetime('now', '+10 seconds'), updated_at=datetime('now')
     WHERE state='running' AND started_at < datetime('now', '-5 minutes')`
  ).run();
  if (stuck.changes > 0) {
    console.log(`[TaskBrain] Unstuck ${stuck.changes} stale running jobs from previous run`);
  }

  pollTimer = setInterval(() => { workerTick().catch(() => {}); }, POLL_INTERVAL_MS);
  console.log("🧠 Task Brain started (ledger poll every 5s, max 4 concurrent)");
}

export function stopTaskBrain(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function workerTick(): Promise<void> {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return;

  const available = MAX_CONCURRENT_JOBS - activeJobs;
  const candidates = db.prepare(
    `SELECT * FROM agent_jobs
       WHERE state IN ('pending','retrying') AND next_run_at <= datetime('now')
       ORDER BY next_run_at ASC LIMIT ?`
  ).all(available) as JobRow[];

  for (const row of candidates) {
    // Atomic claim: update state to running ONLY if still pending/retrying
    const claim = db.prepare(
      `UPDATE agent_jobs
         SET state='running', attempts=attempts+1, started_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND state IN ('pending','retrying')`
    ).run(row.id);

    if (claim.changes === 0) continue; // someone else got it
    activeJobs++;

    // Run without awaiting — let the tick return so next candidates can start
    runJob({ ...row, attempts: row.attempts + 1, state: "running" })
      .finally(() => { activeJobs--; });
  }

  // Also: unstick anything that got stuck in running (defensive against our own bugs)
  db.prepare(
    `UPDATE agent_jobs
       SET state='retrying', next_run_at=datetime('now', '+30 seconds'), updated_at=datetime('now'),
           last_error=COALESCE(last_error,'') || '; auto-unstuck after timeout'
     WHERE state='running' AND started_at < datetime('now', ? )`
  ).run(`-${STUCK_RUNNING_TIMEOUT_MS / 1000} seconds`);
}

async function runJob(row: JobRow): Promise<void> {
  const runId = row.run_id ?? nanoid();
  try {
    const summary = await executeAction(row, runId);
    db.prepare(
      `UPDATE agent_jobs
         SET state='succeeded', result_summary=?, finished_at=datetime('now'),
             run_id=COALESCE(run_id, ?), updated_at=datetime('now')
       WHERE id=?`
    ).run(summary.slice(0, 500), runId, row.id);
    bus.publish({ type: "NOTIFICATION", payload: {
      id: `job-ok-${row.id}`, type: "info",
      title: row.name, body: summary.slice(0, 120), priority: "low",
    }});
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).slice(0, 500);
    const attempts = row.attempts;
    if (attempts < row.max_attempts) {
      const delaySec = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
      db.prepare(
        `UPDATE agent_jobs
           SET state='retrying', last_error=?, next_run_at=datetime('now', '+' || ? || ' seconds'),
               updated_at=datetime('now')
         WHERE id=?`
      ).run(msg, delaySec, row.id);
      logExecution(`TaskBrain: ${row.name}`, `retry ${attempts}/${row.max_attempts} in ${delaySec}s — ${msg}`, "failed");
    } else {
      db.prepare(
        `UPDATE agent_jobs
           SET state='failed', last_error=?, finished_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`
      ).run(msg, row.id);
      logExecution(`TaskBrain: ${row.name}`, `gave up after ${attempts} attempts — ${msg}`, "failed");
      bus.publish({ type: "NOTIFICATION", payload: {
        id: `job-fail-${row.id}`, type: "alert",
        title: `Job failed: ${row.name}`, body: msg, priority: "normal",
      }});
    }
  }
}

// ── Action dispatch (centralized — was previously in user-cron-runtime) ────

async function executeAction(row: JobRow, runId: string): Promise<string> {
  let cfg: any = {};
  try { cfg = JSON.parse(row.action_config ?? "{}"); } catch {}

  switch (row.action_type) {
    case "run_agent":
      return runAgentAction(row, cfg, runId);

    case "send_email":
      return dispatchBridge("email.send", cfg, runId, row.name);
    case "create_calendar_event":
      return dispatchBridge("calendar.create_event", cfg, runId, row.name);
    case "browser_navigate":
      return dispatchBridge("browser.navigate", cfg, runId, row.name);
    case "desktop_automate":
      return dispatchBridge("desktop.automate", cfg, runId, row.name);
    case "dev_delegate":
      return dispatchBridge("dev.delegate", cfg, runId, row.name);

    case "remind":
      bus.publish({ type: "NOTIFICATION", payload: {
        id: `remind-${row.id}-${Date.now()}`, type: "reminder",
        title: row.name, body: cfg.message ?? row.name, priority: "normal",
      }});
      logExecution(`Job: ${row.name}`, `Reminder: ${cfg.message ?? row.name}`);
      return `Reminder sent: ${cfg.message ?? row.name}`;

    default:
      throw new Error(`Unknown action_type "${row.action_type}"`);
  }
}

async function dispatchBridge(capability: string, input: any, runId: string, jobName: string): Promise<string> {
  const { dispatchCapability } = await import("../bridges/registry.js");
  const r = await dispatchCapability(capability, input, {
    previousResults: [], stepIndex: 0, totalSteps: 1, runId,
  } as any, "cron");
  if (!r.success) {
    throw new Error(`${capability} failed: ${r.error ?? r.output}`);
  }
  return `${capability} via ${r.providerId ?? "unknown"}: ${r.output.slice(0, 200)}`;
}

async function runAgentAction(row: JobRow, cfg: any, runId: string): Promise<string> {
  const agentName: string | undefined = cfg.agent_name ?? cfg.agentName;
  const message: string = cfg.message ?? cfg.prompt ?? `Scheduled trigger from job "${row.name}"`;
  if (!agentName) throw new Error(`run_agent missing agent_name in config`);

  const agent = db.prepare("SELECT * FROM user_agents WHERE user_id=? AND name=?")
    .get(DEFAULT_USER_ID, agentName) as any;
  if (!agent) throw new Error(`Agent "${agentName}" not found`);

  const { serializeForPrompt } = await import("../graph/reader.js");
  const graphContext = serializeForPrompt();
  const systemPrompt = `${agent.instructions}\n\nUser's Human Graph context:\n${graphContext}\n\n(Triggered by ${row.source} "${row.name}")`;

  const allowedTools: string[] = (() => { try { return JSON.parse(agent.tools) ?? []; } catch { return []; } })();

  if (allowedTools.length > 0) {
    const { runCustomAgentReAct } = await import("../execution/custom-agent-react.js");
    const result = await runCustomAgentReAct({
      agentId: agent.id, agentName: agent.name,
      systemPrompt, userMessage: message, allowedTools, runId,
    });
    return `${agent.name}: ${result.turns} turns, ${result.toolCalls.length} tools → ${(result.text ?? "").slice(0, 200)}`;
  }
  const { text } = await import("../infra/compute/index.js");
  const result = await text({
    task: "decision",
    system: systemPrompt,
    messages: [{ role: "user", content: message }],
    maxTokens: 1500,
    runId,
    agentName: `Job[${row.name}]: ${agent.name}`,
  });
  return `${agent.name}: ${result.slice(0, 200)}`;
}
