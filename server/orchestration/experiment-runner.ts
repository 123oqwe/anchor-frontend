/**
 * L4 Orchestration — Prompt A/B experiment runner (Sprint A — #7).
 *
 * Override-on-top model: code-path prompts stay as fallback. When an
 * experiment row exists for `key` with status='running', we
 *   1. pick variant deterministically (hash(key + assignmentBucket) % 100)
 *   2. record an assignment row tied to a context_ref (so the outcome
 *      handler can attribute later satisfaction signals)
 *   3. return the variant's value
 * No experiment → return fallback, write nothing, zero overhead.
 *
 * Outcome attribution flows through handlers.ts:
 *   USER_CONFIRMED / EXECUTION_DONE → recordOutcome(context_ref, signal, value)
 *   → finds open assignments with same context_ref → fills outcome_*.
 *
 * Winner judgment is computed on demand (routes/experiments.ts) by
 * grouping assignments by variant + averaging outcome_value.
 */
import { createHash } from "crypto";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

interface ExperimentRow {
  id: string;
  key: string;
  variant_a_value: string;
  variant_b_value: string;
  traffic_split: number;
  status: string;
  success_metric: string;
}

/**
 * Pick a variant for `key`. Returns the active variant value if an experiment
 * is running, else the supplied fallback. Records an assignment when a
 * `contextRef` is given so the outcome can later be attributed.
 *
 * Hash bucket = sha256(key + (contextRef || "")). Same context always sees
 * same variant (stable on retries / re-renders). No contextRef → random
 * bucket every call (intentional — anonymous look-ups don't anchor).
 */
export function pickVariant(opts: {
  key: string;
  fallback: string;
  contextRef?: string;
}): { value: string; assignmentId: string | null; variant: "a" | "b" | "fallback" } {
  const exp = db.prepare(
    "SELECT id, key, variant_a_value, variant_b_value, traffic_split, status, success_metric FROM experiments WHERE user_id=? AND key=? AND status='running' LIMIT 1"
  ).get(DEFAULT_USER_ID, opts.key) as ExperimentRow | undefined;

  if (!exp) {
    return { value: opts.fallback, assignmentId: null, variant: "fallback" };
  }

  const seed = `${opts.key}|${opts.contextRef ?? Math.random()}`;
  const bucket = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) / 0xffffffff;
  const variant: "a" | "b" = bucket < exp.traffic_split ? "a" : "b";
  const value = variant === "a" ? exp.variant_a_value : exp.variant_b_value;

  let assignmentId: string | null = null;
  if (opts.contextRef) {
    assignmentId = nanoid();
    try {
      db.prepare(
        "INSERT INTO experiment_assignments (id, experiment_id, variant, context_ref) VALUES (?,?,?,?)"
      ).run(assignmentId, exp.id, variant, opts.contextRef);
    } catch {
      // Assignment write failure is non-fatal — variant still applies.
      assignmentId = null;
    }
  }
  return { value, assignmentId, variant };
}

/**
 * Attribute a satisfaction signal back to any open assignment with the same
 * context_ref. Called from handlers.ts when USER_CONFIRMED / EXECUTION_DONE
 * fires. Only attributes once per (assignment, signal) pair — re-fires no-op.
 */
export function recordOutcome(opts: {
  contextRef: string;
  signalType: string;
  value: number;
}): number {
  const r = db.prepare(
    `UPDATE experiment_assignments
       SET outcome_signal=?, outcome_value=?, outcome_at=datetime('now')
     WHERE context_ref=? AND outcome_signal IS NULL`
  ).run(opts.signalType, opts.value, opts.contextRef);
  return r.changes;
}

// ── Read helpers (used by routes/experiments.ts) ──────────────────────────

export interface ExperimentSummary {
  id: string;
  key: string;
  description: string;
  status: string;
  successMetric: string;
  trafficSplit: number;
  startedAt: string;
  endedAt: string | null;
  winner: string | null;
  totals: { a: number; b: number; aWithOutcome: number; bWithOutcome: number };
  averages: { a: number | null; b: number | null };
  notes: string;
}

export function listExperiments(): ExperimentSummary[] {
  const exps = db.prepare(
    "SELECT * FROM experiments WHERE user_id=? ORDER BY started_at DESC"
  ).all(DEFAULT_USER_ID) as any[];
  return exps.map(e => summarize(e));
}

export function getExperiment(id: string): ExperimentSummary | null {
  const e = db.prepare("SELECT * FROM experiments WHERE user_id=? AND id=?").get(DEFAULT_USER_ID, id) as any;
  return e ? summarize(e) : null;
}

function summarize(e: any): ExperimentSummary {
  const counts = db.prepare(
    `SELECT variant,
            COUNT(*) AS total,
            SUM(CASE WHEN outcome_signal IS NOT NULL THEN 1 ELSE 0 END) AS with_outcome,
            AVG(CASE WHEN outcome_signal IS NOT NULL THEN outcome_value ELSE NULL END) AS avg_value
     FROM experiment_assignments WHERE experiment_id=? GROUP BY variant`
  ).all(e.id) as any[];
  const a = counts.find((c: any) => c.variant === "a");
  const b = counts.find((c: any) => c.variant === "b");
  return {
    id: e.id,
    key: e.key,
    description: e.description,
    status: e.status,
    successMetric: e.success_metric,
    trafficSplit: e.traffic_split,
    startedAt: e.started_at,
    endedAt: e.ended_at,
    winner: e.winner,
    totals: {
      a: a?.total ?? 0,
      b: b?.total ?? 0,
      aWithOutcome: a?.with_outcome ?? 0,
      bWithOutcome: b?.with_outcome ?? 0,
    },
    averages: {
      a: a?.avg_value ?? null,
      b: b?.avg_value ?? null,
    },
    notes: e.notes,
  };
}

export interface CreateExperimentInput {
  key: string;
  variantAValue: string;
  variantBValue: string;
  description?: string;
  trafficSplit?: number;
  successMetric?: string;
}

export function createExperiment(input: CreateExperimentInput): string {
  // Stop any prior running experiment on the same key — keep history but
  // only one active variant per key (the unique partial index enforces it
  // at the DB level too; this gives a friendly error path).
  db.prepare(
    "UPDATE experiments SET status='stopped', ended_at=datetime('now') WHERE user_id=? AND key=? AND status='running'"
  ).run(DEFAULT_USER_ID, input.key);
  const id = nanoid();
  db.prepare(
    `INSERT INTO experiments (id, user_id, key, description, variant_a_value, variant_b_value, traffic_split, success_metric)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id, DEFAULT_USER_ID, input.key, input.description ?? "",
    input.variantAValue, input.variantBValue,
    input.trafficSplit ?? 0.5,
    input.successMetric ?? "plan_confirmed",
  );
  return id;
}

export function stopExperiment(id: string, winner?: "a" | "b"): boolean {
  const status = winner === "a" ? "promoted_a" : winner === "b" ? "promoted_b" : "stopped";
  const r = db.prepare(
    "UPDATE experiments SET status=?, winner=?, ended_at=datetime('now') WHERE user_id=? AND id=?"
  ).run(status, winner ?? null, DEFAULT_USER_ID, id);
  return r.changes > 0;
}
