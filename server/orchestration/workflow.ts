/**
 * L4 Orchestration — Workflow DAG.
 *
 * Anchor's pre-existing pattern was "N independent cron jobs fire at different
 * times and hope the data they depend on is ready." This module replaces that
 * with a dependency graph: jobs declare what they depend on, the engine
 * resolves topological order, and a failed upstream cascade-skips its
 * dependents instead of feeding them stale data.
 *
 * Design constraints for a single-user local-first product:
 *   - No external cluster (Temporal/Restate would be overkill)
 *   - In-process, one worker — node-cron drives the schedule
 *   - Workflow runs are fully observable via workflow_runs + workflow_jobs
 *   - OTel spans nest: workflow → wave → job → (any LLM/tool spans within)
 *   - Backward-compatible: existing cron jobs can coexist during migration
 *
 * The engine does NOT replace task-brain (which handles user-triggered jobs
 * with retries across server restarts). Workflows are for internal periodic
 * dependency graphs; task-brain is for user/agent-initiated durable tasks.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { bus } from "./bus.js";
import { withSpan } from "../infra/compute/otel.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface JobDef {
  id: string;                        // unique within a workflow
  description?: string;
  dependsOn?: string[];              // other job ids in the same workflow
  handler: string;                   // registered handler name — see registerHandler
  params?: Record<string, any>;
  timeoutMs?: number;                // default 10 minutes
  continueOnError?: boolean;         // if true, dependents still run on failure
}

export interface WorkflowDef {
  id: string;                        // unique workflow identifier
  description?: string;
  schedule?: string;                 // optional cron expression
  triggerEvent?: string;             // optional bus event type to trigger on
  jobs: JobDef[];
}

export type JobStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type WorkflowStatus = "running" | "completed" | "partial" | "failed" | "cancelled";

export interface JobContext {
  workflowId: string;
  runId: string;
  jobId: string;
  params: Record<string, any>;
  upstreamOutputs: Record<string, any>; // { jobId: output } from completed deps
}

export type JobHandler = (ctx: JobContext) => Promise<any>;

// ── Registries (in-memory) ───────────────────────────────────────────────

const workflowRegistry = new Map<string, WorkflowDef>();
const handlerRegistry = new Map<string, JobHandler>();

export function registerHandler(name: string, handler: JobHandler): void {
  if (handlerRegistry.has(name)) {
    console.warn(`[Workflow] handler "${name}" re-registered`);
  }
  handlerRegistry.set(name, handler);
}

export function registerWorkflow(def: WorkflowDef): void {
  validateDAG(def);
  workflowRegistry.set(def.id, def);
  // Persist def metadata so admin UI can inspect even if no run has happened
  db.prepare(
    `INSERT OR REPLACE INTO workflow_defs
      (id, user_id, description, schedule, trigger_event, enabled, jobs_json, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`
  ).run(
    def.id, DEFAULT_USER_ID,
    def.description ?? null,
    def.schedule ?? null,
    def.triggerEvent ?? null,
    JSON.stringify(def.jobs),
  );
}

export function listWorkflowDefs(): WorkflowDef[] {
  return Array.from(workflowRegistry.values());
}

// ── DAG validation ───────────────────────────────────────────────────────

function validateDAG(def: WorkflowDef): void {
  const ids = new Set(def.jobs.map(j => j.id));
  if (ids.size !== def.jobs.length) {
    throw new Error(`Workflow "${def.id}": duplicate job ids`);
  }
  for (const job of def.jobs) {
    for (const dep of job.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`Workflow "${def.id}": job "${job.id}" depends on unknown "${dep}"`);
      }
      if (dep === job.id) {
        throw new Error(`Workflow "${def.id}": job "${job.id}" depends on itself`);
      }
    }
    if (job.handler && !handlerRegistry.has(job.handler)) {
      // Not fatal — handlers may register after workflows. But warn.
      // Real check happens at runWorkflow dispatch time.
    }
  }
  // Cycle detection via DFS
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const j of def.jobs) color.set(j.id, WHITE);
  const byId = new Map(def.jobs.map(j => [j.id, j]));
  const dfs = (id: string, stack: string[]): void => {
    const c = color.get(id);
    if (c === GRAY) throw new Error(`Workflow "${def.id}": cycle through ${stack.concat(id).join(" → ")}`);
    if (c === BLACK) return;
    color.set(id, GRAY);
    const job = byId.get(id)!;
    for (const dep of job.dependsOn ?? []) dfs(dep, stack.concat(id));
    color.set(id, BLACK);
  };
  for (const j of def.jobs) dfs(j.id, []);
}

// ── Topological wave scheduling ──────────────────────────────────────────

/** Partition jobs into waves — within a wave, all jobs can run in parallel
 *  because their dependencies are satisfied by prior waves. */
function scheduleWaves(jobs: JobDef[]): JobDef[][] {
  const unmet = new Map<string, Set<string>>();
  for (const j of jobs) unmet.set(j.id, new Set(j.dependsOn ?? []));
  const byId = new Map(jobs.map(j => [j.id, j]));
  const completed = new Set<string>();
  const waves: JobDef[][] = [];
  while (completed.size < jobs.length) {
    const thisWave: JobDef[] = [];
    unmet.forEach((deps, id) => {
      if (completed.has(id)) return;
      // Ready when all deps either completed OR are outside this workflow
      let ready = true;
      deps.forEach(d => { if (byId.has(d) && !completed.has(d)) ready = false; });
      if (ready) thisWave.push(byId.get(id)!);
    });
    if (thisWave.length === 0) {
      // Shouldn't happen after validateDAG, but defensive
      throw new Error("Workflow deadlock — no job ready");
    }
    waves.push(thisWave);
    for (const j of thisWave) completed.add(j.id);
  }
  return waves;
}

// ── Execute a workflow run ────────────────────────────────────────────────

export interface RunOptions {
  triggerKind?: "schedule" | "event" | "manual";
  runId?: string;                    // override — for resume scenarios (future)
}

export interface RunResult {
  runId: string;
  workflowId: string;
  status: WorkflowStatus;
  jobs: Array<{
    jobId: string;
    status: JobStatus;
    durationMs: number;
    error?: string;
    outputSummary?: string;
  }>;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
}

export async function runWorkflow(
  workflowId: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const def = workflowRegistry.get(workflowId);
  if (!def) throw new Error(`Unknown workflow: ${workflowId}`);

  const runId = opts.runId ?? nanoid();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, user_id, status, trigger_kind, started_at)
     VALUES (?, ?, ?, 'running', ?, ?)`
  ).run(runId, workflowId, DEFAULT_USER_ID, opts.triggerKind ?? "manual", startedAt);

  // Emit into the existing TASK_COMPLETED channel as a lightweight progress
  // signal for the admin UI; a dedicated WORKFLOW_* event type can come later.
  try { bus.publish({ type: "TASK_COMPLETED", payload: { title: `workflow:${workflowId}:start`, source: runId } } as any); } catch {}

  const waves = scheduleWaves(def.jobs);
  const outputs: Record<string, any> = {};
  const statuses: Record<string, JobStatus> = {};
  const jobResults: RunResult["jobs"] = [];

  // Pre-insert all job rows with status=pending so admin sees full graph mid-run
  for (const j of def.jobs) {
    db.prepare(
      `INSERT INTO workflow_jobs (id, run_id, job_id, status, handler)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(nanoid(), runId, j.id, j.handler);
  }

  await withSpan(`workflow ${workflowId}`, {
    "anchor.workflow.id": workflowId,
    "anchor.workflow.run_id": runId,
    "anchor.workflow.trigger": opts.triggerKind ?? "manual",
  }, async () => {
    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx];

      // Identify which jobs in this wave must skip because an upstream failed
      const toRun: JobDef[] = [];
      const toSkip: JobDef[] = [];
      for (const job of wave) {
        const upstreamFailed = (job.dependsOn ?? []).some(d => {
          const st = statuses[d];
          if (!st) return false;
          if (st === "failed" || st === "skipped") {
            // Upstream failed AND upstream didn't declare continueOnError
            const upJob = def.jobs.find(x => x.id === d);
            return !upJob?.continueOnError;
          }
          return false;
        });
        if (upstreamFailed) toSkip.push(job); else toRun.push(job);
      }

      for (const job of toSkip) {
        statuses[job.id] = "skipped";
        db.prepare(
          `UPDATE workflow_jobs SET status='skipped', wave_index=?, finished_at=datetime('now')
           WHERE run_id=? AND job_id=?`
        ).run(waveIdx, runId, job.id);
        jobResults.push({ jobId: job.id, status: "skipped", durationMs: 0 });
      }

      await Promise.all(toRun.map(async (job) => {
        const handler = handlerRegistry.get(job.handler);
        const jobT0 = Date.now();
        db.prepare(
          `UPDATE workflow_jobs SET status='running', wave_index=?, started_at=datetime('now')
           WHERE run_id=? AND job_id=?`
        ).run(waveIdx, runId, job.id);

        if (!handler) {
          statuses[job.id] = "failed";
          db.prepare(
            `UPDATE workflow_jobs SET status='failed', error=?, finished_at=datetime('now'), duration_ms=?
             WHERE run_id=? AND job_id=?`
          ).run(`handler "${job.handler}" not registered`, Date.now() - jobT0, runId, job.id);
          jobResults.push({ jobId: job.id, status: "failed", durationMs: Date.now() - jobT0, error: `handler "${job.handler}" not registered` });
          return;
        }

        try {
          const upstreamOutputs: Record<string, any> = {};
          for (const dep of job.dependsOn ?? []) if (outputs[dep] !== undefined) upstreamOutputs[dep] = outputs[dep];

          const output = await withSpan(`job ${job.id}`, {
            "anchor.workflow.job": job.id,
            "anchor.workflow.handler": job.handler,
          }, async () => withTimeout(
            handler({ workflowId, runId, jobId: job.id, params: job.params ?? {}, upstreamOutputs }),
            job.timeoutMs ?? 600_000,
          ));

          outputs[job.id] = output;
          statuses[job.id] = "completed";
          db.prepare(
            `UPDATE workflow_jobs
             SET status='completed', output_json=?, finished_at=datetime('now'), duration_ms=?
             WHERE run_id=? AND job_id=?`
          ).run(safeStringify(output), Date.now() - jobT0, runId, job.id);
          jobResults.push({
            jobId: job.id, status: "completed",
            durationMs: Date.now() - jobT0,
            outputSummary: typeof output === "object" ? JSON.stringify(output).slice(0, 140) : String(output).slice(0, 140),
          });
        } catch (err: any) {
          statuses[job.id] = "failed";
          const errMsg = err?.message ?? String(err);
          db.prepare(
            `UPDATE workflow_jobs SET status='failed', error=?, finished_at=datetime('now'), duration_ms=?
             WHERE run_id=? AND job_id=?`
          ).run(errMsg.slice(0, 500), Date.now() - jobT0, runId, job.id);
          jobResults.push({ jobId: job.id, status: "failed", durationMs: Date.now() - jobT0, error: errMsg.slice(0, 200) });
        }
      }));
    }
  });

  // Roll up final workflow status
  const anyFailed = jobResults.some(j => j.status === "failed");
  const anySkipped = jobResults.some(j => j.status === "skipped");
  const finalStatus: WorkflowStatus =
    anyFailed && anySkipped ? "failed" :
    anyFailed ? "failed" :
    anySkipped ? "partial" : "completed";

  const finishedAt = new Date().toISOString();
  db.prepare(
    `UPDATE workflow_runs SET status=?, finished_at=? WHERE id=?`
  ).run(finalStatus, finishedAt, runId);

  console.log(
    `[Workflow] ${workflowId} ${finalStatus.toUpperCase()} in ${Date.now() - t0}ms ` +
    `— ${jobResults.filter(j => j.status === "completed").length} completed, ` +
    `${jobResults.filter(j => j.status === "failed").length} failed, ` +
    `${jobResults.filter(j => j.status === "skipped").length} skipped`
  );

  try { bus.publish({ type: "TASK_COMPLETED", payload: { title: `workflow:${workflowId}:${finalStatus}`, source: runId } } as any); } catch {}

  return {
    runId, workflowId, status: finalStatus,
    jobs: jobResults, startedAt, finishedAt,
    totalDurationMs: Date.now() - t0,
  };
}

// ── Bus-event trigger plumbing ───────────────────────────────────────────

/**
 * Wire workflows that declare a triggerEvent to fire on matching bus events.
 * Called once at server boot. Single shared handler filters by event type
 * — the bus emits all events on one "event" channel.
 */
export function wireEventTriggers(): void {
  const triggered = new Map<string, string[]>(); // event_type → [workflow_id, ...]
  workflowRegistry.forEach((def) => {
    if (!def.triggerEvent) return;
    const list = triggered.get(def.triggerEvent) ?? [];
    list.push(def.id);
    triggered.set(def.triggerEvent, list);
  });
  if (triggered.size === 0) return;
  bus.on("event", async (data: any) => {
    const workflows = triggered.get(data?.type);
    if (!workflows) return;
    for (const wid of workflows) {
      runWorkflow(wid, { triggerKind: "event" })
        .catch(err => console.error(`[Workflow] event-trigger ${wid} failed:`, err.message));
    }
  });
}

// ── Utility helpers ──────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`job timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function safeStringify(v: any): string | null {
  try {
    const s = JSON.stringify(v);
    return s && s.length < 2048 ? s : s ? s.slice(0, 2048) : null;
  } catch { return null; }
}

// ── Inspection API ───────────────────────────────────────────────────────

export function getWorkflowRun(runId: string) {
  const run = db.prepare(
    `SELECT id, workflow_id as workflowId, status, trigger_kind as triggerKind,
            started_at as startedAt, finished_at as finishedAt, error
     FROM workflow_runs WHERE id = ? AND user_id = ?`
  ).get(runId, DEFAULT_USER_ID) as any;
  if (!run) return null;
  const jobs = db.prepare(
    `SELECT id, job_id as jobId, status, handler, error, output_json as outputJson,
            started_at as startedAt, finished_at as finishedAt, duration_ms as durationMs,
            wave_index as waveIndex
     FROM workflow_jobs WHERE run_id = ? ORDER BY wave_index, job_id`
  ).all(runId) as any[];
  return { ...run, jobs };
}

export function listWorkflowRuns(opts: { workflowId?: string; limit?: number; status?: WorkflowStatus } = {}) {
  const wheres = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.workflowId) { wheres.push("workflow_id = ?"); params.push(opts.workflowId); }
  if (opts.status) { wheres.push("status = ?"); params.push(opts.status); }
  const limit = Math.min(200, opts.limit ?? 50);
  return db.prepare(
    `SELECT id, workflow_id as workflowId, status, trigger_kind as triggerKind,
            started_at as startedAt, finished_at as finishedAt
     FROM workflow_runs WHERE ${wheres.join(" AND ")}
     ORDER BY started_at DESC LIMIT ?`
  ).all(...params, limit);
}
