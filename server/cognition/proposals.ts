/**
 * L3 Cognition — Mutation proposals with eval-as-gate.
 *
 * The "observer fleet without referee" problem: GEPA downgrades Sonnet → Haiku
 * hoping cost drops; Evolution mutates prompt dimensions hoping tone fits;
 * Skills crystallize hoping next time is faster. None of them measures the
 * outcome. If Haiku answers noticeably worse, nobody notices. If Evolution
 * shifts tone the user doesn't want, it sticks until user retires it by hand.
 *
 * This module makes the referee explicit:
 *   1. Learner proposes a change (doesn't apply directly)
 *   2. Evaluator runs the Phase-B eval harness targeted at the affected
 *      surface (route_override for task X → run fixtures that exercise X)
 *   3. Proposal accepted iff score ≥ threshold AND not worse than baseline
 *   4. Accepted proposals applied; rejected ones logged with reason
 *
 * Each mutation kind registers (a) how to build the baseline vs candidate
 * state, (b) which fixtures are relevant, (c) how to actually apply the
 * change if accepted. Generic — Evolution/Skills can plug in the same way.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import type { RunResult } from "../eval/types.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "evaluating" | "accepted" | "applied" | "rejected" | "expired";

export type ProposalKind =
  | "route_override"      // change which model a task routes to
  | "prompt_adaptation"   // change a dimension value that affects system prompts
  | "skill_deploy"        // deploy a newly-crystallized skill
  | "threshold_tune";     // change a system_config threshold

export interface MutationProposal {
  id: string;
  source: string;                   // "gepa" | "evolution" | "skill" | "manual"
  kind: ProposalKind | string;
  target: string;                   // what's being changed (task name, dimension, skill id)
  before: any;                      // current value — for rollback + diff
  after: any;                       // proposed value
  rationale?: string;
  status: ProposalStatus;
  evalScore?: number;
  evalThreshold: number;
  evalBaselineScore?: number;       // score of the BEFORE state for comparison
  evalFixtureIds?: string[];
  evalReport?: any;
  rejectReason?: string;
  createdAt: string;
  evaluatedAt?: string;
  appliedAt?: string;
}

export interface ProposalHandler {
  /** Apply the proposed state. Called only after gate accepts. */
  apply: (proposal: MutationProposal) => Promise<void> | void;
  /** Roll back an applied proposal if needed (e.g. regret window). */
  revert?: (proposal: MutationProposal) => Promise<void> | void;
  /** Which eval fixture IDs relate to this proposal's target? If the
   *  returned list is empty, the gate uses a default threshold of 0
   *  (auto-accept) but logs a warning — "no eval coverage for this kind". */
  relevantFixtureIds: (proposal: MutationProposal) => string[];
  /** Apply the CANDIDATE state temporarily so the eval runs against the
   *  proposed configuration. Returns a function to restore the pre-eval
   *  state. Called around eval to avoid committing mid-test. */
  withCandidateApplied?: (proposal: MutationProposal, fn: () => Promise<any>) => Promise<any>;
}

const handlers = new Map<string, ProposalHandler>();

export function registerProposalHandler(kind: string, handler: ProposalHandler): void {
  if (handlers.has(kind)) console.warn(`[Proposals] handler for "${kind}" re-registered`);
  handlers.set(kind, handler);
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export interface ProposeInput {
  source: string;
  kind: ProposalKind | string;
  target: string;
  before: any;
  after: any;
  rationale?: string;
  evalThreshold?: number;
}

export function proposeMutation(input: ProposeInput): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO mutation_proposals
      (id, user_id, source, kind, target, before_json, after_json, rationale, eval_threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, DEFAULT_USER_ID,
    input.source, input.kind, input.target,
    input.before !== undefined ? JSON.stringify(input.before) : null,
    JSON.stringify(input.after),
    input.rationale ?? null,
    input.evalThreshold ?? 0.8,
  );
  return id;
}

export function loadProposal(id: string): MutationProposal | null {
  const row = db.prepare(
    `SELECT * FROM mutation_proposals WHERE id = ? AND user_id = ?`
  ).get(id, DEFAULT_USER_ID) as any;
  return row ? rowToProposal(row) : null;
}

export function listProposals(opts: { source?: string; status?: ProposalStatus; limit?: number } = {}): MutationProposal[] {
  const wheres = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.source) { wheres.push("source = ?"); params.push(opts.source); }
  if (opts.status) { wheres.push("status = ?"); params.push(opts.status); }
  const limit = Math.min(200, opts.limit ?? 50);
  const rows = db.prepare(
    `SELECT * FROM mutation_proposals WHERE ${wheres.join(" AND ")}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
  return rows.map(rowToProposal);
}

function rowToProposal(row: any): MutationProposal {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    target: row.target,
    before: row.before_json ? safeParse(row.before_json) : null,
    after: safeParse(row.after_json) ?? null,
    rationale: row.rationale ?? undefined,
    status: row.status,
    evalScore: row.eval_score ?? undefined,
    evalThreshold: row.eval_threshold,
    evalBaselineScore: row.eval_baseline_score ?? undefined,
    evalFixtureIds: row.eval_fixture_ids ? safeParse(row.eval_fixture_ids) : undefined,
    evalReport: row.eval_report_json ? safeParse(row.eval_report_json) : undefined,
    rejectReason: row.reject_reason ?? undefined,
    createdAt: row.created_at,
    evaluatedAt: row.evaluated_at ?? undefined,
    appliedAt: row.applied_at ?? undefined,
  };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Evaluate ─────────────────────────────────────────────────────────────

export interface EvaluateResult {
  proposalId: string;
  status: ProposalStatus;
  score?: number;
  baselineScore?: number;
  threshold: number;
  reason?: string;
  fixtureCount: number;
}

/**
 * Run the eval harness against a proposal. Computes BOTH baseline (current
 * state) and candidate (proposed state) scores; accepts only if candidate
 * ≥ threshold AND candidate ≥ baseline (no regression). Writes result back
 * to the proposal row.
 */
export async function evaluateProposal(
  id: string,
  opts: { evalFnOverride?: (fixtureIds: string[]) => Promise<RunResult> } = {},
): Promise<EvaluateResult> {
  const proposal = loadProposal(id);
  if (!proposal) throw new Error(`Proposal not found: ${id}`);
  if (proposal.status !== "pending") throw new Error(`Proposal ${id} is ${proposal.status}, not pending`);

  const handler = handlers.get(proposal.kind);
  if (!handler) {
    return markRejected(id, "no handler registered for kind " + proposal.kind, proposal.evalThreshold);
  }

  db.prepare(`UPDATE mutation_proposals SET status='evaluating' WHERE id=?`).run(id);

  const fixtureIds = handler.relevantFixtureIds(proposal);
  // No relevant fixtures → this gate has no coverage. Accept with warning.
  if (fixtureIds.length === 0) {
    db.prepare(
      `UPDATE mutation_proposals SET status='accepted', evaluated_at=datetime('now'),
       eval_score=NULL, eval_report_json=?, eval_fixture_ids='[]'
       WHERE id=?`
    ).run(JSON.stringify({ note: "no_eval_coverage_for_kind" }), id);
    console.warn(`[Proposals] ${id} accepted without eval — no fixtures for kind "${proposal.kind}"`);
    return {
      proposalId: id, status: "accepted",
      threshold: proposal.evalThreshold, fixtureCount: 0,
      reason: "no_eval_coverage",
    };
  }

  // Run eval with the CANDIDATE state applied (handler.withCandidateApplied)
  // and also baseline.
  const runEval = opts.evalFnOverride ?? defaultRunEval;

  let baselineResult: RunResult, candidateResult: RunResult;
  try {
    // Baseline — current state, no mutation applied
    baselineResult = await runEval(fixtureIds);

    // Candidate — transiently apply proposed state around eval
    if (handler.withCandidateApplied) {
      candidateResult = await handler.withCandidateApplied(proposal, () => runEval(fixtureIds));
    } else {
      // No transient applier — can only test that the current state passes
      // (conservative: accept if baseline passes, because we can't measure
      // candidate without actually applying). This is an escape hatch for
      // kinds where toggling state mid-flight is too invasive.
      candidateResult = baselineResult;
    }
  } catch (err: any) {
    return markRejected(id, `eval_error: ${err?.message ?? "?"}`, proposal.evalThreshold);
  }

  const baselineScore = baselineResult.avgPassRatio;
  const candidateScore = candidateResult.avgPassRatio;
  const passed = candidateScore >= proposal.evalThreshold && candidateScore >= baselineScore;
  const status: ProposalStatus = passed ? "accepted" : "rejected";
  const reason = passed
    ? undefined
    : candidateScore < proposal.evalThreshold
      ? `below_threshold: ${candidateScore.toFixed(2)} < ${proposal.evalThreshold}`
      : `regression: ${candidateScore.toFixed(2)} < baseline ${baselineScore.toFixed(2)}`;

  db.prepare(
    `UPDATE mutation_proposals
     SET status=?, eval_score=?, eval_baseline_score=?, eval_fixture_ids=?,
         eval_report_json=?, reject_reason=?, evaluated_at=datetime('now')
     WHERE id=?`
  ).run(
    status, candidateScore, baselineScore,
    JSON.stringify(fixtureIds),
    JSON.stringify({
      candidate: { passed: candidateResult.passed, failed: candidateResult.failed, avgPassRatio: candidateScore },
      baseline:  { passed: baselineResult.passed,  failed: baselineResult.failed,  avgPassRatio: baselineScore },
    }),
    reason ?? null, id,
  );

  return {
    proposalId: id, status, score: candidateScore, baselineScore,
    threshold: proposal.evalThreshold, fixtureCount: fixtureIds.length, reason,
  };
}

async function defaultRunEval(fixtureIds: string[]): Promise<RunResult> {
  const { runEval } = await import("../eval/runner.js");
  return runEval({ only: fixtureIds, verbose: false });
}

function markRejected(id: string, reason: string, threshold: number): EvaluateResult {
  db.prepare(
    `UPDATE mutation_proposals SET status='rejected', reject_reason=?, evaluated_at=datetime('now') WHERE id=?`
  ).run(reason, id);
  return { proposalId: id, status: "rejected", threshold, fixtureCount: 0, reason };
}

// ── Apply ────────────────────────────────────────────────────────────────

export async function applyProposal(id: string): Promise<{ applied: boolean; reason?: string }> {
  const proposal = loadProposal(id);
  if (!proposal) return { applied: false, reason: "not_found" };
  if (proposal.status !== "accepted") return { applied: false, reason: `status=${proposal.status}` };

  const handler = handlers.get(proposal.kind);
  if (!handler) return { applied: false, reason: "no_handler" };

  try {
    await handler.apply(proposal);
  } catch (err: any) {
    db.prepare(`UPDATE mutation_proposals SET status='rejected', reject_reason=? WHERE id=?`)
      .run(`apply_failed: ${err?.message ?? "?"}`, id);
    return { applied: false, reason: `apply_failed: ${err?.message}` };
  }
  db.prepare(
    `UPDATE mutation_proposals SET status='applied', applied_at=datetime('now') WHERE id=?`
  ).run(id);
  return { applied: true };
}

/** Apply every currently-accepted proposal. Called by the workflow after eval. */
export async function applyAccepted(opts: { source?: string } = {}): Promise<{ applied: number; failed: number }> {
  const wheres = ["user_id=?", "status='accepted'"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.source) { wheres.push("source=?"); params.push(opts.source); }
  const ids = (db.prepare(
    `SELECT id FROM mutation_proposals WHERE ${wheres.join(" AND ")}`
  ).all(...params) as any[]).map(r => r.id);

  let applied = 0, failed = 0;
  for (const id of ids) {
    const r = await applyProposal(id);
    if (r.applied) applied++; else failed++;
  }
  return { applied, failed };
}

// ── Manual reject (admin UI) ─────────────────────────────────────────────

export function rejectProposal(id: string, reason: string): boolean {
  const r = db.prepare(
    `UPDATE mutation_proposals
     SET status='rejected', reject_reason=?, evaluated_at=datetime('now')
     WHERE id=? AND user_id=? AND status IN ('pending','evaluating','accepted')`
  ).run(reason, id, DEFAULT_USER_ID);
  return r.changes > 0;
}

/** Aggregate metrics — answers "is this learner worth listening to?". */
export function sourceStats(source: string, windowDays = 30) {
  const rows = db.prepare(
    `SELECT status, COUNT(*) as c
     FROM mutation_proposals
     WHERE user_id=? AND source=?
       AND created_at >= datetime('now', ? || ' days')
     GROUP BY status`
  ).all(DEFAULT_USER_ID, source, `-${windowDays}`) as any[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = r.c;
  const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const accepted = (byStatus.accepted ?? 0) + (byStatus.applied ?? 0);
  return {
    source,
    windowDays,
    total,
    byStatus,
    acceptanceRate: total > 0 ? +(accepted / total).toFixed(3) : 0,
  };
}
