/**
 * L6 Permission — Unified approval queue (Sprint B — #4).
 *
 * Mirror layer over the 4 historical approval mechanisms:
 *   1. L6 gate.ts checkPermission → "require_confirmation"
 *   2. bridges/app-approval.ts → app_approvals.status='pending'
 *   3. cognition/proposals.ts → proposals.status='pending'
 *   4. execution/checkpoint.ts → agent_runs.status='interrupted'
 *
 * Each existing mechanism keeps its own state; in parallel they enqueue a
 * row here so a single inbox surfaces the union to the UI. When the user
 * decides, this layer fires NOTIFICATION + APPROVAL_DECIDED events; the
 * relevant source modules subscribe to those and reconcile their own state.
 *
 * Why dual-write instead of single-source migration:
 * Karpathy principle 3 (surgical changes). The 4 sources have working UIs
 * and tested code paths. A single inbox UI ships value immediately; deeper
 * refactor (one true source of truth) is opt-in later.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { bus } from "../orchestration/bus.js";

export type ApprovalSource = "gate" | "app" | "proposal" | "run" | "step";
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "dismissed";

export interface EnqueueInput {
  source: ApprovalSource;
  sourceRefId: string;             // back-pointer for source-specific reconciliation
  title: string;
  summary?: string;
  detail?: Record<string, unknown>;
  riskLevel?: ApprovalRiskLevel;
  expiresInSeconds?: number;       // optional auto-expire (e.g. 24h for low-risk gates)
}

export interface ApprovalRow {
  id: string;
  source: ApprovalSource;
  source_ref_id: string;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  risk_level: ApprovalRiskLevel;
  status: ApprovalStatus;
  decided_by: string | null;
  decision_reason: string | null;
  expires_at: string | null;
  created_at: string;
  decided_at: string | null;
}

/**
 * Enqueue a pending approval. Idempotent on (source, source_ref_id) while
 * status='pending' (DB unique partial index enforces). Re-enqueueing a
 * resolved row creates a new entry — this matches "user re-tried" semantics.
 */
export function enqueueApproval(input: EnqueueInput): string {
  // Idempotency: if a pending row already exists for this source_ref, return it.
  const existing = db.prepare(
    "SELECT id FROM approval_queue WHERE source=? AND source_ref_id=? AND status='pending'"
  ).get(input.source, input.sourceRefId) as any;
  if (existing) return existing.id;

  const id = nanoid();
  const expiresAt = input.expiresInSeconds
    ? new Date(Date.now() + input.expiresInSeconds * 1000).toISOString()
    : null;

  db.prepare(
    `INSERT INTO approval_queue
       (id, user_id, source, source_ref_id, title, summary, detail_json, risk_level, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id, DEFAULT_USER_ID, input.source, input.sourceRefId,
    input.title.slice(0, 200),
    (input.summary ?? "").slice(0, 500),
    JSON.stringify(input.detail ?? {}),
    input.riskLevel ?? "medium",
    expiresAt,
  );

  bus.publish({
    type: "NOTIFICATION",
    payload: {
      id: `approval-${id}`,
      type: "approval_pending",
      title: input.title,
      body: input.summary ?? "Awaiting your decision",
      priority: input.riskLevel === "critical" || input.riskLevel === "high" ? "high" : "normal",
      action: { label: "Review", type: "navigate", payload: { path: "/approvals", id } },
    },
  });

  return id;
}

/**
 * User decision. Fires APPROVAL_DECIDED event so source modules can
 * reconcile their own state (approve the actual proposal, resume the
 * actual run, etc).
 */
export function decideApproval(opts: {
  id: string;
  approve: boolean;
  reason?: string;
  decidedBy?: string;
}): { ok: boolean; row?: ApprovalRow; reason?: string } {
  const row = getApproval(opts.id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: "already_decided" };
  // Informational rows have no caller waiting on the decision — refuse so
  // the UI doesn't lie about acting on them. The row stays pending forever
  // (or until expire); UI must render it as audit-only.
  if (row.detail?.informational === true) {
    return { ok: false, reason: "informational" };
  }

  const newStatus = opts.approve ? "approved" : "rejected";
  db.prepare(
    "UPDATE approval_queue SET status=?, decision_reason=?, decided_by=?, decided_at=datetime('now') WHERE id=?"
  ).run(newStatus, opts.reason ?? null, opts.decidedBy ?? "user", opts.id);

  bus.publish({
    type: "APPROVAL_DECIDED",
    payload: {
      id: opts.id,
      source: row.source,
      sourceRefId: row.source_ref_id,
      approved: opts.approve,
      reason: opts.reason,
    },
  });

  return { ok: true, row: { ...row, status: newStatus, decision_reason: opts.reason ?? null } };
}

export function getApproval(id: string): ApprovalRow | null {
  const row = db.prepare(
    "SELECT * FROM approval_queue WHERE user_id=? AND id=?"
  ).get(DEFAULT_USER_ID, id) as any;
  return row ? rowToTyped(row) : null;
}

export function listApprovals(opts: {
  status?: ApprovalStatus | ApprovalStatus[];
  source?: ApprovalSource;
  limit?: number;
} = {}): ApprovalRow[] {
  const wheres: string[] = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.status) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
    wheres.push(`status IN (${arr.map(() => "?").join(",")})`);
    params.push(...arr);
  }
  if (opts.source) {
    wheres.push("source = ?");
    params.push(opts.source);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = db.prepare(
    `SELECT * FROM approval_queue WHERE ${wheres.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
  return rows.map(rowToTyped);
}

export function inboxStats(): { pending: number; pendingByRisk: Record<ApprovalRiskLevel, number>; pendingBySource: Record<ApprovalSource, number> } {
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM approval_queue WHERE user_id=? AND status='pending'").get(DEFAULT_USER_ID) as any;
  const byRisk = db.prepare("SELECT risk_level, COUNT(*) AS c FROM approval_queue WHERE user_id=? AND status='pending' GROUP BY risk_level").all(DEFAULT_USER_ID) as any[];
  const bySource = db.prepare("SELECT source, COUNT(*) AS c FROM approval_queue WHERE user_id=? AND status='pending' GROUP BY source").all(DEFAULT_USER_ID) as any[];
  const pendingByRisk: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of byRisk) pendingByRisk[r.risk_level] = r.c;
  const pendingBySource: Record<string, number> = { gate: 0, app: 0, proposal: 0, run: 0, step: 0 };
  for (const r of bySource) pendingBySource[r.source] = r.c;
  return {
    pending: totalRow?.c ?? 0,
    pendingByRisk: pendingByRisk as Record<ApprovalRiskLevel, number>,
    pendingBySource: pendingBySource as Record<ApprovalSource, number>,
  };
}

/** Sweep: mark expired pendings as 'expired'. Cron-callable. */
export function expireStaleApprovals(): number {
  const r = db.prepare(
    `UPDATE approval_queue
       SET status='expired', decided_by='auto_expire', decided_at=datetime('now')
     WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`
  ).run();
  return r.changes;
}

function rowToTyped(row: any): ApprovalRow {
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(row.detail_json ?? "{}"); } catch {}
  return {
    id: row.id,
    source: row.source,
    source_ref_id: row.source_ref_id,
    title: row.title,
    summary: row.summary,
    detail,
    risk_level: row.risk_level,
    status: row.status,
    decided_by: row.decided_by,
    decision_reason: row.decision_reason,
    expires_at: row.expires_at,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}
