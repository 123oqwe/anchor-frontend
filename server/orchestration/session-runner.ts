/**
 * L4 Orchestration — SessionRunner (Phase 2 of #2).
 *
 * Polls action_sessions/action_steps and advances ONE step per session per
 * tick. Replaces the LLM-driven 12-turn ReAct loop in execution/agent.ts
 * with a deterministic outer loop: each step has explicit input, runtime,
 * tool, optional approval gate, and (Phase 3) optional verifier.
 *
 * Why a poll loop (vs event-driven push):
 *   - Same pattern as task-brain.ts; one mental model for both.
 *   - Atomic SQL claim is the natural concurrency primitive.
 *   - Resilient to crashes — boot-time recovery just looks at status='running'.
 *
 * Feature flag: ANCHOR_NEW_SESSION_RUNNER=true. Default off — handlers.ts
 * still routes to legacy runExecutionReAct unless the flag is set. New path
 * runs in parallel: the row exists in action_sessions either way (Phase 1
 * shadow), the flag controls who actually drives execution.
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { bus } from "./bus.js";
import { type ToolObservation, getTool } from "../execution/registry.js";
import { enqueueApproval } from "../permission/approval-queue.js";
import { runVerifier } from "../execution/verifiers.js";
import { runStepDispatch, type RuntimeKind } from "../execution/runtime-router.js";
import { object } from "../infra/compute/index.js";
import { z } from "zod";

const POLL_INTERVAL_MS = 2_000;
const STUCK_RUNNING_TIMEOUT_MS = 5 * 60_000;
const MAX_CONCURRENT_SESSIONS = 4;

let pollTimer: NodeJS.Timeout | null = null;
let activeSessions = 0;

interface SessionRow {
  id: string;
  goal: string;
  status: string;
  current_step_id: string | null;
  source: string;
  source_ref_id: string | null;
}

interface StepRow {
  id: string;
  session_id: string;
  step_index: number;
  name: string;
  type: string;
  runtime: string;
  tool: string | null;
  input_template_json: string;
  status: string;
  approval_required: number;
  approval_decision: string | null;
  retry_count: number;
  max_retries: number;
  depends_on_step_ids_json: string;
  output_text: string | null;
  observation_json: string | null;
  verify_rule: string | null;
  started_at: string | null;
}

// ── Boot ─────────────────────────────────────────────────────────────────

export function startSessionRunner(): void {
  // Recovery: anything stuck in 'running' from a prior process — fail it.
  // Distinct from task-brain: we don't auto-retry steps because the user
  // expects deterministic ordering. Failed sessions surface in /api/sessions.
  const stuck = db.prepare(
    `UPDATE action_steps SET status='failed', updated_at=datetime('now')
       WHERE status='running' AND started_at < datetime('now', '-5 minutes')`
  ).run();
  if (stuck.changes > 0) {
    console.log(`[SessionRunner] Recovery: ${stuck.changes} stuck step(s) marked failed`);
  }
  const stuckSessions = db.prepare(
    `UPDATE action_sessions SET status='failed', updated_at=datetime('now')
       WHERE status='running'
         AND id IN (SELECT session_id FROM action_steps WHERE status='failed')`
  ).run();
  if (stuckSessions.changes > 0) {
    console.log(`[SessionRunner] Recovery: ${stuckSessions.changes} session(s) marked failed`);
  }

  pollTimer = setInterval(() => { tick().catch(err => console.error("[SessionRunner] tick error:", err)); }, POLL_INTERVAL_MS);
  console.log("🧭 SessionRunner started (poll 2s, max 4 concurrent sessions)");
}

export function stopSessionRunner(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── External entry: kick a session into 'running' state ──────────────────
// Called by handlers.ts when USER_CONFIRMED fires AND feature flag is on.
// Idempotent: if already running, no-op.
export function startSession(sessionId: string): void {
  const r = db.prepare(
    `UPDATE action_sessions SET status='running', updated_at=datetime('now')
       WHERE id=? AND status='pending'`
  ).run(sessionId);
  if (r.changes > 0) {
    console.log(`[SessionRunner] session ${sessionId} → running`);
  }
}

// ── Main loop ────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (activeSessions >= MAX_CONCURRENT_SESSIONS) return;

  const slots = MAX_CONCURRENT_SESSIONS - activeSessions;
  const candidates = db.prepare(
    "SELECT id, goal, status, current_step_id, source, source_ref_id FROM action_sessions WHERE user_id=? AND status='running' ORDER BY updated_at ASC LIMIT ?"
  ).all(DEFAULT_USER_ID, slots) as SessionRow[];

  for (const session of candidates) {
    activeSessions++;
    advanceSession(session).finally(() => { activeSessions--; });
  }
}

async function advanceSession(session: SessionRow): Promise<void> {
  // 1. Find next runnable step: lowest step_index with status='pending'
  //    and all its dependencies in {succeeded, skipped}.
  const nextStep = findNextRunnableStep(session.id);
  if (!nextStep) {
    // No step ready. Could be: all done → mark completed; or all blocked
    // (waiting on approval / failed deps).
    finalizeSessionIfDone(session);
    return;
  }

  // 2. Approval gate (before atomic claim — we want to enqueue + park here).
  if (nextStep.approval_required && nextStep.approval_decision !== "approved") {
    if (nextStep.approval_decision === "rejected") {
      markStep(nextStep.id, { status: "skipped" });
      bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index, status: "skipped", tool: nextStep.tool, runtime: nextStep.runtime } });
      return;   // next tick will pick up downstream
    }
    // Mark awaiting + enqueue once.
    if (nextStep.status !== "awaiting_approval") {
      markStep(nextStep.id, { status: "awaiting_approval" });
      try {
        enqueueApproval({
          source: "step",
          sourceRefId: nextStep.id,
          title: `${nextStep.tool ?? nextStep.runtime}: ${nextStep.name.slice(0, 80)}`,
          summary: `Session ${session.id.slice(0, 6)} step ${nextStep.step_index + 1} requires approval`,
          detail: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index, runtime: nextStep.runtime, tool: nextStep.tool },
          riskLevel: "high",
        });
      } catch (err) { console.error("[SessionRunner] approval enqueue failed:", err); }
      bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index, status: "awaiting_approval", tool: nextStep.tool, runtime: nextStep.runtime } });
    }
    return;
  }

  // 3. Atomic claim: only one runner can transition pending→running.
  const claim = db.prepare(
    `UPDATE action_steps SET status='running', started_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status IN ('pending','retrying')`
  ).run(nextStep.id);
  if (claim.changes === 0) return;   // someone else got it; back off

  bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index, status: "running", tool: nextStep.tool, runtime: nextStep.runtime } });
  db.prepare("UPDATE action_sessions SET current_step_id=?, updated_at=datetime('now') WHERE id=?").run(nextStep.id, session.id);

  // 4. Resolve input. Mustache+jsonpath first (deterministic, free); when
  //    that throws (missing ref / non-JSON / type mismatch) drop into a
  //    cheap LLM fallback that fills the tool input from step.name + prior
  //    outputs + tool input schema. Only fail the step if BOTH paths fail.
  let input: any;
  try {
    input = resolveInputTemplate(nextStep, getCompletedSteps(session.id));
  } catch (templateErr: any) {
    try {
      input = await llmResolveInput(nextStep, getCompletedSteps(session.id), session.goal);
      console.log(`[SessionRunner] step ${nextStep.step_index}: template failed (${templateErr?.message?.slice(0, 80)}), LLM fallback succeeded`);
    } catch (llmErr: any) {
      failStep(nextStep, `input resolve: ${templateErr?.message ?? templateErr} (LLM fallback also failed: ${llmErr?.message ?? llmErr})`, session);
      return;
    }
  }
  db.prepare("UPDATE action_steps SET input_resolved_json=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(input), nextStep.id);

  // 5. Dispatch.
  if (nextStep.runtime === "human") {
    // human runtime without a tool — treat as "user must do this manually"
    // and pause until they say done. Use the same approval queue so the user
    // sees it in the inbox; their decision (approved=I did it) advances.
    markStep(nextStep.id, { status: "awaiting_approval" });
    try {
      enqueueApproval({
        source: "step",
        sourceRefId: nextStep.id,
        title: `Manual step: ${nextStep.name.slice(0, 80)}`,
        summary: `Session ${session.id.slice(0, 6)} step ${nextStep.step_index + 1} — confirm when done`,
        detail: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index },
        riskLevel: "low",
      });
    } catch {}
    return;
  }

  if (!nextStep.tool) {
    failStep(nextStep, `non-human step has no tool`, session);
    return;
  }

  try {
    const result = await runStepDispatch({
      runtime: nextStep.runtime as RuntimeKind,
      tool: nextStep.tool,
      input,
      ctx: {
        previousResults: [], stepIndex: nextStep.step_index, totalSteps: countSteps(session.id),
        runId: session.id,
      },
    });

    if (result.success) {
      // Persist structured observation if the tool returned one (Phase 3);
      // otherwise stash result.data as a generic envelope so old tools that
      // only set `data` still leave a trace.
      const observation: ToolObservation | null = result.observation
        ?? (result.data ? ({ runtime: nextStep.runtime as any, raw: result.data } as any) : null);
      db.prepare(
        `UPDATE action_steps SET status='succeeded', output_text=?, observation_json=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
      ).run(result.output ?? "", observation ? JSON.stringify(observation) : null, nextStep.id);

      // Phase 3 of #2 — verifier hook. Optional per step. Only blocks the
      // session when type='side_effect' AND verifier says fail; for query/
      // draft we record verify_status but never demote a succeeded step.
      if (nextStep.verify_rule) {
        const verdict = await runVerifier(nextStep.verify_rule, {
          stepName: nextStep.name,
          stepType: nextStep.type,
          outputText: result.output ?? "",
          observation,
          tool: nextStep.tool,
        });
        db.prepare(
          "UPDATE action_steps SET verify_status=?, verify_evidence=?, updated_at=datetime('now') WHERE id=?"
        ).run(verdict.pass ? "pass" : "fail", verdict.evidence.slice(0, 500), nextStep.id);
        if (!verdict.pass && nextStep.type === "side_effect") {
          // Verifier says the action didn't actually take effect → demote
          // the step from succeeded to failed and surface as session failure.
          db.prepare(
            "UPDATE action_steps SET status='failed', updated_at=datetime('now') WHERE id=?"
          ).run(nextStep.id);
          db.prepare(
            "UPDATE action_sessions SET status='failed', updated_at=datetime('now') WHERE id=?"
          ).run(session.id);
          bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index, status: "failed", tool: nextStep.tool, runtime: nextStep.runtime } });
          logExecution("SessionRunner", `step ${nextStep.step_index} verify failed: ${verdict.evidence}`, "failed");
          publishExecutionDone(session.id, "failed");
          return;
        }
      }
      bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: nextStep.id, stepIndex: nextStep.step_index, status: "succeeded", tool: nextStep.tool, runtime: nextStep.runtime } });
    } else {
      handleStepFailure(nextStep, `tool: ${result.error ?? result.output}`, session, result.shouldRetry);
    }
  } catch (err: any) {
    handleStepFailure(nextStep, `dispatch: ${err?.message ?? err}`, session, true);
  }

  finalizeSessionIfDone(session);
}

// ── Step resolution helpers ──────────────────────────────────────────────

function findNextRunnableStep(sessionId: string): StepRow | null {
  const all = db.prepare(
    "SELECT * FROM action_steps WHERE session_id=? ORDER BY step_index ASC"
  ).all(sessionId) as StepRow[];
  if (all.length === 0) return null;

  const byId = new Map(all.map(s => [s.id, s]));

  for (const s of all) {
    if (s.status === "running") return null;             // someone is running, wait
    if (s.status !== "pending" && s.status !== "retrying") continue;
    const deps = safeArr<string>(s.depends_on_step_ids_json);
    const depsBlocked = deps.some(depId => {
      const dep = byId.get(depId);
      return !dep || (dep.status !== "succeeded" && dep.status !== "skipped");
    });
    if (depsBlocked) continue;
    return s;
  }
  return null;
}

function getCompletedSteps(sessionId: string): StepRow[] {
  return db.prepare(
    "SELECT * FROM action_steps WHERE session_id=? AND status IN ('succeeded','skipped') ORDER BY step_index ASC"
  ).all(sessionId) as StepRow[];
}

function countSteps(sessionId: string): number {
  return (db.prepare("SELECT COUNT(*) as c FROM action_steps WHERE session_id=?").get(sessionId) as any)?.c ?? 0;
}

// ── Input template resolution (mustache + jsonpath, deterministic) ──────

// "Smart unquote" template:
//   "{{ref}}"  → JSON.stringify(value)   (replaces incl. surrounding quotes;
//                                          works for both strings and any JSON value)
//   {{ref}}    → JSON.stringify(value)   (raw JSON token — caller chose to omit quotes)
// Two-pass replace: quoted form first so its quotes get consumed before the
// bare-form regex sees them.
const QUOTED_TEMPLATE_RE = /"\{\{\s*([^}]+?)\s*\}\}"/g;
const PLAIN_TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolveInputTemplate(step: StepRow, prior: StepRow[]): any {
  const raw = step.input_template_json || "{}";
  const sub = (text: string, re: RegExp) => text.replace(re, (_match, refRaw) => {
    const ref = String(refRaw).trim();
    const value = lookupRef(ref, prior, step);
    if (value === undefined) {
      throw new Error(`unresolved reference: {{${ref}}}`);
    }
    return JSON.stringify(value);
  });
  const replaced = sub(sub(raw, QUOTED_TEMPLATE_RE), PLAIN_TEMPLATE_RE);
  try { return JSON.parse(replaced); }
  catch (err: any) { throw new Error(`invalid resolved JSON: ${err?.message} (post-replace: ${replaced.slice(0, 200)})`); }
}

function lookupRef(ref: string, prior: StepRow[], current: StepRow): unknown {
  // Supported syntax:
  //   steps[i].output                  → prior[i].output_text (parsed if JSON)
  //   steps[i].output.path.to.x        → JSON path inside output
  //   steps[i].observation.path        → inside observation_json
  //   prev.output                      → previous succeeded step
  //   goal                             → session goal (passed in step.name? — too noisy; skip for now)
  //   self.name                        → current step's name (debug)

  if (ref === "self.name") return current.name;
  if (ref.startsWith("prev.")) {
    if (prior.length === 0) return undefined;
    const last = prior[prior.length - 1];
    return lookupOnStep(last, ref.slice("prev.".length));
  }
  const m = ref.match(/^steps\[(\d+)\]\.(.+)$/);
  if (m) {
    const idx = parseInt(m[1], 10);
    const target = prior.find(p => p.step_index === idx);
    if (!target) return undefined;
    return lookupOnStep(target, m[2]);
  }
  return undefined;
}

function lookupOnStep(step: StepRow, path: string): unknown {
  // path = 'output' or 'output.field.subfield' or 'observation.field'
  const [head, ...rest] = path.split(".");
  let base: any;
  if (head === "output") {
    base = step.output_text;
    // Auto-parse JSON when downstream wants a deeper path
    if (rest.length > 0 && typeof base === "string") {
      try { base = JSON.parse(base); } catch { /* keep string */ }
    }
  } else if (head === "observation") {
    try { base = JSON.parse(step.observation_json ?? "null"); } catch { base = null; }
  } else {
    return undefined;
  }
  return walk(base, rest);
}

function walk(base: any, path: string[]): unknown {
  let cur: any = base;
  for (const seg of path) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function safeArr<T>(s: string | null | undefined): T[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v as T[] : []; } catch { return []; }
}

// ── LLM input resolver (fallback when mustache template fails) ───────────
// Used by advanceSession when resolveInputTemplate throws (unresolved ref /
// invalid JSON post-substitution / type mismatch). One cheap LLM call
// constrained by the tool's input schema. Throws if LLM also fails so the
// caller can mark the step failed with both error reasons.
async function llmResolveInput(step: StepRow, prior: StepRow[], goal: string): Promise<any> {
  if (!step.tool) throw new Error("LLM resolve requires a tool");
  const tool = getTool(step.tool);
  if (!tool) throw new Error(`tool "${step.tool}" not in registry`);

  const priorSummary = prior.length === 0
    ? "(no prior steps)"
    : prior.map(s => `Step ${s.step_index} (${s.tool ?? s.runtime}): ${(s.output_text ?? "").slice(0, 200)}`).join("\n");

  const filled = await object({
    task: "twin_edit_learning",
    system: `You produce tool input JSON given a step description, prior outputs, and the tool's input schema. Output ONLY the input object — no commentary.

Tool: ${tool.name}
Tool description: ${tool.description}
Tool input JSON schema:
${JSON.stringify(tool.inputSchema, null, 2)}

Goal: ${goal.slice(0, 300)}
Step description: ${step.name.slice(0, 300)}
Original input template (had unresolved refs):
${step.input_template_json}

Prior step outputs:
${priorSummary}`,
    messages: [{ role: "user", content: "Produce the tool input JSON now." }],
    schema: z.record(z.string(), z.any()),
    maxTokens: 500,
  });
  return filled;
}

// ── State-machine writers ────────────────────────────────────────────────

function markStep(id: string, fields: Partial<{ status: string; approval_decision: string }>) {
  const sets: string[] = ["updated_at=datetime('now')"];
  const args: any[] = [];
  if (fields.status) { sets.push("status=?"); args.push(fields.status); }
  if (fields.approval_decision) { sets.push("approval_decision=?"); args.push(fields.approval_decision); }
  args.push(id);
  db.prepare(`UPDATE action_steps SET ${sets.join(",")} WHERE id=?`).run(...args);
}

function failStep(step: StepRow, reason: string, session: SessionRow): void {
  db.prepare(
    `UPDATE action_steps SET status='failed', output_text=?, finished_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
  ).run(`ERROR: ${reason}`, step.id);
  db.prepare(
    "UPDATE action_sessions SET status='failed', updated_at=datetime('now') WHERE id=?"
  ).run(session.id);
  bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: step.id, stepIndex: step.step_index, status: "failed", tool: step.tool, runtime: step.runtime } });
  publishExecutionDone(session.id, "failed");
  logExecution("SessionRunner", `step ${step.step_index} failed: ${reason}`, "failed");
}

function handleStepFailure(step: StepRow, reason: string, session: SessionRow, retryable?: boolean): void {
  const canRetry = retryable && step.retry_count < step.max_retries;
  if (canRetry) {
    db.prepare(
      `UPDATE action_steps SET status='retrying', retry_count=retry_count+1,
         output_text=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(`RETRY: ${reason}`, step.id);
    bus.publish({ type: "SESSION_STEP_PROGRESS", payload: { sessionId: session.id, stepId: step.id, stepIndex: step.step_index, status: "retrying", tool: step.tool, runtime: step.runtime } });
  } else {
    failStep(step, reason, session);
  }
}

function finalizeSessionIfDone(session: SessionRow): void {
  // Re-fetch — status may have flipped during this tick
  const fresh = db.prepare("SELECT status FROM action_sessions WHERE id=?").get(session.id) as any;
  if (!fresh || fresh.status !== "running") return;

  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('succeeded','skipped') THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','running','retrying','awaiting_approval') THEN 1 ELSE 0 END) AS open,
       COUNT(*) AS total
     FROM action_steps WHERE session_id=?`
  ).get(session.id) as any;

  if (counts.failed > 0 && counts.open === 0) {
    db.prepare("UPDATE action_sessions SET status='failed', updated_at=datetime('now') WHERE id=?").run(session.id);
    publishExecutionDone(session.id, "failed");
    return;
  }
  if (counts.done === counts.total) {
    db.prepare("UPDATE action_sessions SET status='completed', updated_at=datetime('now') WHERE id=?").run(session.id);
    publishExecutionDone(session.id, "completed");
    return;
  }
  // open > 0 → still in progress; tick will revisit
}

function publishExecutionDone(sessionId: string, finalStatus: "completed" | "failed"): void {
  // Match legacy ReAct payload shape so downstream Twin/Evolution learning
  // (handleExecutionDone in handlers.ts) doesn't need any change.
  const steps = db.prepare(
    "SELECT name, tool, status, output_text FROM action_steps WHERE session_id=? ORDER BY step_index ASC"
  ).all(sessionId) as any[];
  const session = db.prepare("SELECT goal FROM action_sessions WHERE id=?").get(sessionId) as any;
  bus.publish({
    type: "EXECUTION_DONE",
    payload: {
      steps_result: steps.map(s => ({
        step: s.tool ?? s.name,
        status: s.status === "succeeded" ? "done" : (s.status === "skipped" ? "skipped" : "error"),
        result: s.output_text ?? "",
      })),
      plan_summary: session?.goal ?? "",
    },
  });
  logExecution("SessionRunner", `session ${sessionId.slice(0, 6)} ${finalStatus}: ${steps.filter(s => s.status === "succeeded").length}/${steps.length} ok`);
}

// ── External: handle approval decision from inbox ────────────────────────
// Called by handlers.ts when APPROVAL_DECIDED with source='step' fires.
export function applyStepApprovalDecision(stepId: string, approved: boolean): void {
  const decision = approved ? "approved" : "rejected";
  // pending → resume by clearing awaiting_approval back to pending
  const targetStatus = approved ? "pending" : "skipped";
  db.prepare(
    `UPDATE action_steps SET approval_decision=?, status=?, updated_at=datetime('now')
       WHERE id=? AND status='awaiting_approval'`
  ).run(decision, targetStatus, stepId);
}
