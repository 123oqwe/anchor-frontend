/**
 * Implicit Feedback ledger.
 *
 * Explicit user feedback (thumbs) is <1% of interactions in every
 * personal-AI product shipped at scale (Cursor Bugbot, Zed Zeta2).
 * The 99% signal lives in *implicit* behavior:
 *   edit_distance      user rewrote agent's output before using it
 *   re_prompt          user asked the same agent a similar thing <N minutes later
 *   abandonment        run completed, user never came back
 *   tool_rejection     permission gate denied a tool; user didn't retry
 *   regeneration       user explicitly hit "try again"
 *   thumbs_up/down     rare but authoritative
 *
 * Every event is stored as a typed row + numeric signal in [-1, +1].
 * Downstream (a future RLHF/DPO pipeline) can weight and aggregate.
 *
 * Design principle: the detector is NON-INVASIVE. It never blocks the
 * main agent flow. Detection is either event-driven (recordEdit when UI
 * sends a diff) or a cron job that scans agent_runs/agent_executions
 * retroactively for patterns.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

export type FeedbackKind =
  | "edit_distance"
  | "re_prompt"
  | "abandonment"
  | "tool_rejection"
  | "regeneration"
  | "thumbs_up"
  | "thumbs_down";

export type FeedbackSubjectType =
  | "agent_output"
  | "tool_call"
  | "portrait_claim"
  | "graph_inference";

export interface FeedbackEvent {
  id: string;
  kind: FeedbackKind;
  subjectType: FeedbackSubjectType;
  subjectId?: string;
  agentId?: string;
  runId?: string;
  signal: number;
  payload?: any;
  source: "ui" | "cli" | "implicit_detector" | "cron";
  createdAt: string;
}

export interface RecordFeedbackInput {
  kind: FeedbackKind;
  subjectType: FeedbackSubjectType;
  subjectId?: string;
  agentId?: string;
  runId?: string;
  signal?: number;
  payload?: any;
  source?: FeedbackEvent["source"];
}

export function recordFeedback(input: RecordFeedbackInput): string {
  const id = nanoid();
  const signal = input.signal ?? defaultSignalForKind(input.kind);
  db.prepare(
    `INSERT INTO feedback_events
      (id, user_id, kind, subject_type, subject_id, agent_id, run_id, signal, payload, source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, DEFAULT_USER_ID,
    input.kind, input.subjectType,
    input.subjectId ?? null,
    input.agentId ?? null,
    input.runId ?? null,
    signal,
    input.payload ? JSON.stringify(input.payload) : null,
    input.source ?? "implicit_detector",
  );
  return id;
}

/** Default signal magnitudes per feedback kind — calibrated for downstream
 *  weighted aggregation. Overridable via explicit signal on recordFeedback. */
function defaultSignalForKind(kind: FeedbackKind): number {
  switch (kind) {
    case "thumbs_up":       return  1.0;
    case "thumbs_down":     return -1.0;
    case "tool_rejection":  return -0.6;
    case "regeneration":    return -0.5;   // user hit "try again" — the prior output wasn't acceptable
    case "re_prompt":       return -0.3;   // asked again with different phrasing — mild dissatisfaction
    case "abandonment":     return -0.2;   // ran once, never came back — weak signal
    case "edit_distance":   return  0.0;   // magnitude depends on payload.similarity; recorder sets it
  }
}

// ── Specific capture helpers ─────────────────────────────────────────────

/**
 * User edited the agent's output in the UI before using it. Signal is
 * computed from similarity — near-identical = +0.3 (agent nailed it),
 * major rewrite = -0.7 (agent was off).
 */
export function recordEditDistance(opts: {
  runId: string;
  agentId?: string;
  original: string;
  modified: string;
}): string {
  const similarity = jaccardSimilarity(opts.original, opts.modified);
  // similarity 1.0 → signal +0.4 (minor tweaks are normal, mildly positive)
  // similarity 0.0 → signal -0.8 (full rewrite; agent output was discarded)
  const signal = -0.8 + similarity * 1.2;
  const editDistance = levenshteinDistance(
    opts.original.slice(0, 2000),
    opts.modified.slice(0, 2000),
  );
  return recordFeedback({
    kind: "edit_distance",
    subjectType: "agent_output",
    subjectId: opts.runId,
    agentId: opts.agentId,
    runId: opts.runId,
    signal,
    source: "ui",
    payload: {
      similarity: +similarity.toFixed(3),
      editDistance,
      originalLen: opts.original.length,
      modifiedLen: opts.modified.length,
    },
  });
}

export function recordToolRejection(opts: {
  runId?: string;
  agentId?: string;
  toolName: string;
  toolUseId?: string;
  reason?: string;
}): string {
  return recordFeedback({
    kind: "tool_rejection",
    subjectType: "tool_call",
    subjectId: opts.toolUseId,
    agentId: opts.agentId,
    runId: opts.runId,
    source: "implicit_detector",
    payload: { toolName: opts.toolName, reason: opts.reason },
  });
}

export function recordThumbs(opts: {
  up: boolean;
  runId?: string;
  agentId?: string;
  subjectType?: FeedbackSubjectType;
  subjectId?: string;
}): string {
  return recordFeedback({
    kind: opts.up ? "thumbs_up" : "thumbs_down",
    subjectType: opts.subjectType ?? "agent_output",
    subjectId: opts.subjectId ?? opts.runId,
    agentId: opts.agentId,
    runId: opts.runId,
    source: "ui",
  });
}

// ── Retroactive detectors (cron-friendly) ────────────────────────────────

/**
 * Scan recent agent_runs for re-prompt patterns: same user + same agent
 * asked something similar within N minutes of a prior run. Jaccard ≥
 * 0.4 on user_message content counts as similar.
 */
export function detectRePrompts(opts: { windowMinutes?: number; sinceMinutes?: number } = {}): number {
  const windowMin = opts.windowMinutes ?? 15;
  const sinceMin = opts.sinceMinutes ?? 60 * 24;  // last 24h by default
  const rows = db.prepare(
    `SELECT id, agent_id, user_message, created_at
     FROM agent_runs
     WHERE user_id=? AND created_at >= datetime('now', ? || ' minutes')
     ORDER BY agent_id, created_at ASC`
  ).all(DEFAULT_USER_ID, `-${sinceMin}`) as any[];

  // Skip re-detection for runs already tagged
  const existing = db.prepare(
    `SELECT subject_id FROM feedback_events
     WHERE user_id=? AND kind='re_prompt' AND subject_id IS NOT NULL`
  ).all(DEFAULT_USER_ID) as any[];
  const alreadyTagged = new Set(existing.map((r: any) => r.subject_id));

  let recorded = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (prev.agent_id !== curr.agent_id) continue;
    if (alreadyTagged.has(curr.id)) continue;
    const dtMs = new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime();
    if (dtMs > windowMin * 60_000) continue;
    const sim = jaccardSimilarity(prev.user_message ?? "", curr.user_message ?? "");
    if (sim < 0.4) continue;
    recordFeedback({
      kind: "re_prompt",
      subjectType: "agent_output",
      subjectId: curr.id,
      agentId: curr.agent_id,
      runId: curr.id,
      source: "cron",
      payload: {
        previousRunId: prev.id,
        similarity: +sim.toFixed(3),
        gapMinutes: +(dtMs / 60_000).toFixed(1),
      },
    });
    recorded++;
  }
  return recorded;
}

/**
 * Scan completed runs that had no follow-up engagement within N hours.
 * Proxy for "user didn't find this useful enough to act on."
 */
export function detectAbandonment(opts: { staleHours?: number; sinceHours?: number } = {}): number {
  const stale = opts.staleHours ?? 24;
  const since = opts.sinceHours ?? 72;
  const rows = db.prepare(
    `SELECT id, agent_id, updated_at FROM agent_runs
     WHERE user_id=? AND status='completed'
       AND created_at >= datetime('now', ? || ' hours')
       AND julianday('now') - julianday(updated_at) > ?`
  ).all(DEFAULT_USER_ID, `-${since}`, stale / 24) as any[];

  const existing = db.prepare(
    `SELECT subject_id FROM feedback_events WHERE user_id=? AND kind='abandonment'`
  ).all(DEFAULT_USER_ID) as any[];
  const alreadyTagged = new Set(existing.map((r: any) => r.subject_id));

  let recorded = 0;
  for (const r of rows) {
    if (alreadyTagged.has(r.id)) continue;
    // Check for any subsequent feedback / tool action on this run
    const followup = db.prepare(
      `SELECT 1 FROM feedback_events WHERE run_id=? AND created_at > ?`
    ).get(r.id, r.updated_at);
    if (followup) continue;
    recordFeedback({
      kind: "abandonment",
      subjectType: "agent_output",
      subjectId: r.id,
      agentId: r.agent_id,
      runId: r.id,
      source: "cron",
      payload: { staleHours: stale },
    });
    recorded++;
  }
  return recorded;
}

// ── Aggregation ─────────────────────────────────────────────────────────

export interface AgentFeedbackSummary {
  agentId: string;
  windowDays: number;
  totalEvents: number;
  avgSignal: number;
  byKind: Record<string, { count: number; avgSignal: number }>;
  rejectionRate: number;
  editSimilarityAvg: number | null;
}

export function aggregateForAgent(agentId: string, windowDays = 30): AgentFeedbackSummary {
  const rows = db.prepare(
    `SELECT kind, signal, payload FROM feedback_events
     WHERE user_id=? AND agent_id=?
       AND created_at >= datetime('now', ? || ' days')`
  ).all(DEFAULT_USER_ID, agentId, `-${windowDays}`) as any[];

  const byKind: Record<string, { count: number; totalSignal: number }> = {};
  let totalSignal = 0;
  const editSimilarities: number[] = [];
  let toolCallCount = 0;
  let toolRejectionCount = 0;

  for (const r of rows) {
    totalSignal += r.signal;
    if (!byKind[r.kind]) byKind[r.kind] = { count: 0, totalSignal: 0 };
    byKind[r.kind].count++;
    byKind[r.kind].totalSignal += r.signal;
    if (r.kind === "tool_rejection") toolRejectionCount++;
    if (r.kind === "edit_distance" && r.payload) {
      try {
        const p = JSON.parse(r.payload);
        if (typeof p.similarity === "number") editSimilarities.push(p.similarity);
      } catch {}
    }
  }
  toolCallCount = byKind.tool_rejection?.count ?? 0;

  // Rejection rate requires knowing total tool calls for this agent
  const toolTotals = db.prepare(
    `SELECT COUNT(*) as c FROM agent_executions
     WHERE user_id=? AND agent LIKE ? AND created_at >= datetime('now', ? || ' days')`
  ).get(DEFAULT_USER_ID, `Custom: %${agentId}%`, `-${windowDays}`) as any;
  const totalToolCalls = toolTotals?.c ?? 0;

  const editAvg = editSimilarities.length > 0
    ? editSimilarities.reduce((s, x) => s + x, 0) / editSimilarities.length
    : null;

  return {
    agentId,
    windowDays,
    totalEvents: rows.length,
    avgSignal: rows.length > 0 ? +(totalSignal / rows.length).toFixed(3) : 0,
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, {
        count: v.count,
        avgSignal: +(v.totalSignal / v.count).toFixed(3),
      }])
    ),
    rejectionRate: totalToolCalls > 0 ? +(toolRejectionCount / totalToolCalls).toFixed(3) : 0,
    editSimilarityAvg: editAvg !== null ? +editAvg.toFixed(3) : null,
  };
}

export function listRecentFeedback(opts: { agentId?: string; kind?: FeedbackKind; limit?: number } = {}): FeedbackEvent[] {
  const wheres = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.agentId) { wheres.push("agent_id = ?"); params.push(opts.agentId); }
  if (opts.kind) { wheres.push("kind = ?"); params.push(opts.kind); }
  const limit = Math.min(500, opts.limit ?? 100);
  const rows = db.prepare(
    `SELECT id, kind, subject_type as subjectType, subject_id as subjectId,
            agent_id as agentId, run_id as runId, signal, payload, source,
            created_at as createdAt
     FROM feedback_events WHERE ${wheres.join(" AND ")}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
  return rows.map(r => ({
    ...r,
    payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return null; } })() : null,
  }));
}

// ── Similarity helpers ──────────────────────────────────────────────────

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .split(/[\s\-_\/.,;:!?()\[\]{}"']+/)
      .filter(t => t.length >= 3),
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a), tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach(t => { if (tb.has(t)) inter++; });
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Levenshtein — bounded at 2000 chars to keep O(n²) tractable on big outputs. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return curr[b.length];
}
