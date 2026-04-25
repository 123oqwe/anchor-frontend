/**
 * L3 Cognition — Killer Queries.
 *
 * These are the structurally-differentiated questions Anchor can answer and
 * competitor AI memory systems (Claude Memory, ChatGPT Memory, Mem0, Zep)
 * structurally CAN'T — because they don't have 7 local scanners producing
 * ground-truth timeline data. Each function is a pure SQL-driven analysis;
 * Portrait/Council narration runs downstream of the raw numbers.
 *
 * Design notes:
 *  - All queries use bi-temporal node lookup (valid_to IS NULL = currently
 *    active identity). A person who "left" the user's circle gets valid_to
 *    set and quietly drops out of these analyses.
 *  - timeline_events.related_node_ids is a JSON array; membership check via
 *    LIKE '%"<id>"%'. This is slow for > 50k events — upgrade to
 *    json_each() when scale demands.
 *  - "Noise floor" thresholds (minInteractions) prevent reporting on
 *    acquaintances with 1-2 interactions as "cooling" — volatility isn't
 *    signal.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { countAggregates, latestAggregates, aggregatesAsOf } from "../graph/contact-aggregates.js";

// ──────────────────────────────────────────────────────────────────────────
// Killer Query #4 — Cooling / Warming Network
// ──────────────────────────────────────────────────────────────────────────

export interface ContactTrend {
  nodeId: string;
  label: string;
  recentWeeklyAvg: number;
  priorWeeklyAvg: number;
  changeRatio: number;     // recent / prior; >1 = warming, <1 = cooling
  classification: "cooling" | "warming";
  recentCount: number;
  priorCount: number;
  lastInteraction: string | null;
  sources: Record<string, number>;  // breakdown by source (mail/calendar/etc)
}

/**
 * Who in the user's network is cooling (communication dropping) or warming
 * (communication surging) compared to their baseline? Competitor memory
 * systems can't answer this — they have no timeline, only conversation
 * snippets. Anchor has every email/message/calendar event timestamped and
 * linked to person nodes.
 *
 * Method: per-person, compute mean weekly events in the recent window (last
 * 30 days) vs the prior window (31-180 days). Classify as cooling if the
 * ratio < coolingThreshold, warming if > warmingThreshold. Ignore contacts
 * below the noise floor to avoid "cooling" on people with 1-2 interactions.
 */
export function coolingWarmingNetwork(opts: {
  coolingThreshold?: number;      // ratio below which = cooling
  warmingThreshold?: number;      // ratio above which = warming
  minInteractionsPrior?: number;  // noise floor — skip contacts below this
  comparisonLagDays?: number;     // "prior" snapshot must be at least this old
} = {}): ContactTrend[] {
  const coolingThreshold = opts.coolingThreshold ?? 0.4;
  const warmingThreshold = opts.warmingThreshold ?? 2.0;
  const minPrior = opts.minInteractionsPrior ?? 4;
  const lagDays = opts.comparisonLagDays ?? 30;

  // Snapshot-based diff is the only correct path: aggregate scanners don't
  // emit per-message streams, so we need two snapshots over time to compute
  // trends. Inner function returns [] when no prior snapshot ≥ lagDays old
  // (insufficient history) — that empty result is correct, not a fallback.
  return coolingWarmingFromSnapshots({ coolingThreshold, warmingThreshold, minPrior, lagDays });
}

/**
 * Snapshot-based cooling/warming. Compares latest aggregate per contact
 * against the most-recent snapshot from ≥lagDays ago. If no prior snapshot
 * exists (contact is new), treat as warming. If contact vanished from
 * latest scan but existed in prior, synthesize a 0-count current row.
 */
function coolingWarmingFromSnapshots(opts: {
  coolingThreshold: number; warmingThreshold: number; minPrior: number; lagDays: number;
}): ContactTrend[] {
  const latest = latestAggregates();
  const asOfPrior = new Date(Date.now() - opts.lagDays * 86_400_000).toISOString();
  const prior = aggregatesAsOf(asOfPrior);

  // Edge case: no snapshots exist from ≥lagDays ago → we literally don't
  // have a baseline to compare against. Without a prior reference point,
  // EVERY contact would appear "warming (new)" which is misleading — it
  // really means "we only have one snapshot's worth of history." Return
  // empty; frontend shows the "not enough history" empty state.
  if (prior.length === 0) return [];

  // Index prior by (handle, source, direction) for lookup
  const priorKey = (r: any) => `${r.contact_handle}|${r.source}|${r.direction ?? ""}`;
  const priorIdx = new Map<string, any>();
  for (const p of prior) priorIdx.set(priorKey(p), p);

  // Sum across sources per contact — we want "total communication" not per-channel
  type Sum = { nodeId: string | null; label: string; recent: number; prior: number; sources: Record<string, number>; lastAt: string | null };
  const byContact = new Map<string, Sum>();
  const resolveKey = (row: any) => row.contact_node_id ?? `handle:${row.contact_handle}`;

  for (const l of latest) {
    const k = resolveKey(l);
    const existing: Sum = byContact.get(k) ?? {
      nodeId: l.contact_node_id,
      label: l.contact_display_name ?? l.contact_handle,
      recent: 0, prior: 0, sources: {} as Record<string, number>, lastAt: null,
    };
    existing.recent += l.count_in_window;
    existing.sources[l.source as string] = (existing.sources[l.source as string] ?? 0) + l.count_in_window;
    if (!existing.lastAt || (l.last_at && l.last_at > existing.lastAt)) existing.lastAt = l.last_at;
    const p = priorIdx.get(priorKey(l));
    if (p) existing.prior += p.count_in_window;
    byContact.set(k, existing);
  }
  // Also include contacts that vanished from latest but existed in prior
  for (const p of prior) {
    const k = p.contact_node_id ?? `handle:${p.contact_handle}`;
    if (byContact.has(k)) continue;
    byContact.set(k, {
      nodeId: p.contact_node_id,
      label: p.contact_display_name ?? p.contact_handle,
      recent: 0, prior: p.count_in_window,
      sources: { [p.source]: p.count_in_window },
      lastAt: p.last_at,
    });
  }

  const results: ContactTrend[] = [];
  for (const s of Array.from(byContact.values())) {
    // Noise floor — need meaningful signal on at least one side
    if (s.prior < opts.minPrior && s.recent < opts.minPrior) continue;

    // Ratio semantics: prior=0 = new contact (warming); recent=0 = went silent (cooling)
    let ratio: number;
    if (s.prior === 0 && s.recent === 0) continue;
    else if (s.prior === 0) ratio = Infinity;
    else ratio = s.recent / s.prior;

    let classification: "cooling" | "warming" | null = null;
    if (ratio < opts.coolingThreshold) classification = "cooling";
    else if (ratio > opts.warmingThreshold) classification = "warming";
    if (!classification) continue;

    // Normalize to weekly averages for display consistency with old shape.
    // windowDays for mail is 30; use that. Approximate messages' as 30 too
    // since we can't know the true scanner window.
    const perWeekRecent = +(s.recent / (30 / 7)).toFixed(2);
    const perWeekPrior = +(s.prior / (30 / 7)).toFixed(2);

    results.push({
      nodeId: s.nodeId ?? `handle:${Object.keys(s.sources).join("-")}`,
      label: s.label,
      recentWeeklyAvg: perWeekRecent,
      priorWeeklyAvg: perWeekPrior,
      changeRatio: ratio === Infinity ? Infinity : +ratio.toFixed(2),
      classification,
      recentCount: s.recent,
      priorCount: s.prior,
      lastInteraction: s.lastAt,
      sources: s.sources,
    });
  }

  return results.sort((a, b) => {
    const magA = a.changeRatio === Infinity ? 10 : Math.abs(Math.log(a.changeRatio || 0.001));
    const magB = b.changeRatio === Infinity ? 10 : Math.abs(Math.log(b.changeRatio || 0.001));
    return magB - magA;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Killer Query #1 — Top Actual Contacts (with source breakdown)
// ──────────────────────────────────────────────────────────────────────────

export interface TopContact {
  nodeId: string;
  label: string;
  totalInteractions: number;
  sourceBreakdown: Record<string, number>;  // mail: 42, calendar: 8, ...
  lastInteraction: string | null;
  firstInteractionInWindow: string | null;
}

/**
 * The user's top N contacts ranked by real communication volume across all
 * channels, with a source-by-source breakdown. Surfaces the gap between
 * "who user thinks they talk to most" vs "who they actually talk to most."
 * The comparison to Portrait's key_relationships is done at the narration
 * layer (frontend / LLM prompt), not here.
 */
export function topActualContacts(opts: {
  windowDays?: number;
  limit?: number;
} = {}): TopContact[] {
  const windowDays = opts.windowDays ?? 90;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));

  // Snapshot-first: latest aggregate per contact, rank by total across sources.
  // Falls back to timeline scan when no aggregates exist (pre-first-scan state).
  if (countAggregates() > 0) {
    const latest = latestAggregates();
    type Agg = { nodeId: string | null; label: string; total: number; sources: Record<string, number>; last: string | null; first: string | null };
    const by = new Map<string, Agg>();
    for (const l of latest) {
      const key = l.contact_node_id ?? `handle:${l.contact_handle}`;
      const existing: Agg = by.get(key) ?? {
        nodeId: l.contact_node_id,
        label: l.contact_display_name ?? l.contact_handle,
        total: 0, sources: {} as Record<string, number>, last: null, first: null,
      };
      existing.total += l.count_in_window;
      existing.sources[l.source as string] = (existing.sources[l.source as string] ?? 0) + l.count_in_window;
      if (!existing.last || (l.last_at && l.last_at > existing.last)) existing.last = l.last_at;
      if (!existing.first || (l.first_at && l.first_at < existing.first)) existing.first = l.first_at;
      by.set(key, existing);
    }
    return Array.from(by.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, limit)
      .map(a => ({
        nodeId: a.nodeId ?? `handle:${a.label}`,
        label: a.label,
        totalInteractions: a.total,
        sourceBreakdown: a.sources,
        lastInteraction: a.last,
        firstInteractionInWindow: a.first,
      }));
  }

  const persons = db.prepare(
    `SELECT id, label FROM graph_nodes
     WHERE user_id = ? AND type = 'person' AND valid_to IS NULL`
  ).all(DEFAULT_USER_ID) as any[];

  const results: TopContact[] = [];

  for (const p of persons) {
    const like = `%"${p.id}"%`;
    const stats = db.prepare(
      `SELECT COALESCE(SUM(COALESCE(json_extract(metadata, '$.count'), 1)), 0) as total,
              MIN(occurred_at) as first,
              MAX(occurred_at) as last
       FROM timeline_events
       WHERE user_id = ? AND related_node_ids LIKE ?
         AND datetime(occurred_at) >= datetime('now', '-' || ? || ' days')`
    ).get(DEFAULT_USER_ID, like, windowDays) as any;

    if (stats.total === 0) continue;

    const bySource = db.prepare(
      `SELECT source, COALESCE(SUM(COALESCE(json_extract(metadata, '$.count'), 1)), 0) as c
       FROM timeline_events
       WHERE user_id = ? AND related_node_ids LIKE ?
         AND datetime(occurred_at) >= datetime('now', '-' || ? || ' days')
       GROUP BY source`
    ).all(DEFAULT_USER_ID, like, windowDays) as any[];
    const sourceBreakdown: Record<string, number> = {};
    for (const s of bySource) sourceBreakdown[s.source] = s.c;

    results.push({
      nodeId: p.id,
      label: p.label,
      totalInteractions: stats.total,
      sourceBreakdown,
      lastInteraction: stats.last,
      firstInteractionInWindow: stats.first,
    });
  }

  return results
    .sort((a, b) => b.totalInteractions - a.totalInteractions)
    .slice(0, limit);
}

// ──────────────────────────────────────────────────────────────────────────
// Killer Query #3 — Attention Shift Over Time
// ──────────────────────────────────────────────────────────────────────────

export interface AttentionBucket {
  /** ISO period label, e.g. "2026-Q1" or "2026-04" */
  period: string;
  /** Top domains in this period with event counts */
  domains: { domain: string; count: number; pctOfTotal: number }[];
  totalEvents: number;
}

/**
 * How has the user's attention (by graph-domain breakdown) shifted over
 * the lookback window? Buckets timeline events by month, computes domain
 * distribution for each month. Frontend can plot this as a stacked-area
 * chart: narrow ones = focused, wide ones = scattered.
 */
export function attentionShift(opts: {
  months?: number;
} = {}): AttentionBucket[] {
  const months = Math.min(24, Math.max(1, opts.months ?? 6));
  const buckets: AttentionBucket[] = [];

  for (let i = 0; i < months; i++) {
    // Month i ago — SQLite strftime. SQLite rejects `-(-N) months` (evaluates
    // to NULL); must use explicit '+N' when offset becomes positive.
    const startOffset = i === 0 ? "-0" : `-${i}`;
    const endOffset = i - 1 <= 0 ? (i - 1 === 0 ? "-0" : `+${Math.abs(i - 1)}`) : `-${i - 1}`;
    const start = `datetime('now', 'start of month', '${startOffset} months')`;
    const end = `datetime('now', 'start of month', '${endOffset} months')`;

    const rows = db.prepare(
      `SELECT n.domain as domain, COUNT(*) as c
       FROM timeline_events t, json_each(t.related_node_ids) j
       JOIN graph_nodes n ON n.id = j.value
       WHERE t.user_id = ?
         AND datetime(t.occurred_at) >= ${start}
         AND datetime(t.occurred_at) < ${end}
         AND n.valid_to IS NULL
       GROUP BY n.domain
       ORDER BY c DESC`
    ).all(DEFAULT_USER_ID) as any[];

    const total = rows.reduce((s, r) => s + r.c, 0);
    if (total === 0) continue;

    const domains = rows.map((r: any) => ({
      domain: r.domain as string,
      count: r.c as number,
      pctOfTotal: +((r.c / total) * 100).toFixed(1),
    }));

    const period = new Date();
    period.setMonth(period.getMonth() - i, 1);
    const periodLabel = period.toISOString().slice(0, 7);

    buckets.unshift({ period: periodLabel, domains, totalEvents: total });
  }

  return buckets;
}

// ──────────────────────────────────────────────────────────────────────────
// Killer Query #2 — Commitments vs Execution
// ──────────────────────────────────────────────────────────────────────────

export interface CommitmentStatus {
  nodeId: string;
  label: string;
  status: string;           // 'pending' / 'done' / 'blocked' etc.
  domain: string;
  createdAt: string;
  ageDays: number;
  lastActivityAt: string | null;
  activityCount: number;    // timeline events referencing this node
}

/**
 * Commitments = nodes of type 'task' or 'goal' that are still pending
 * after their creation window. For each, count recent timeline activity
 * referencing the node — low activity + old age = commitment drift.
 *
 * Simplified v1: reports pending tasks older than `staleDays` with zero
 * or few timeline references. Future: classify by domain (work commitments
 * cool faster than personal), correlate with mood/energy from user_state.
 */
export function commitmentsVsExecution(opts: {
  staleDays?: number;
  limit?: number;
} = {}): CommitmentStatus[] {
  const staleDays = opts.staleDays ?? 14;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));

  const commitments = db.prepare(
    `SELECT id, label, status, domain, created_at
     FROM graph_nodes
     WHERE user_id = ?
       AND type IN ('task', 'goal', 'project')
       AND status IN ('pending', 'in_progress', 'active', 'open')
       AND valid_to IS NULL
       AND julianday('now') - julianday(created_at) >= ?
     ORDER BY created_at ASC`
  ).all(DEFAULT_USER_ID, staleDays) as any[];

  const results: CommitmentStatus[] = [];
  for (const c of commitments) {
    const like = `%"${c.id}"%`;
    const activity = db.prepare(
      `SELECT COUNT(*) as c, MAX(occurred_at) as last
       FROM timeline_events WHERE user_id = ? AND related_node_ids LIKE ?`
    ).get(DEFAULT_USER_ID, like) as any;

    const ageDays = Math.floor(
      (Date.now() - new Date(c.created_at).getTime()) / 86_400_000
    );
    results.push({
      nodeId: c.id,
      label: c.label,
      status: c.status,
      domain: c.domain,
      createdAt: c.created_at,
      ageDays,
      lastActivityAt: activity.last,
      activityCount: activity.c,
    });
  }

  // Rank by "drift score" — higher age + lower activity = more drifted
  return results
    .map(r => ({ r, drift: r.ageDays / Math.max(1, r.activityCount) }))
    .sort((a, b) => b.drift - a.drift)
    .slice(0, limit)
    .map(x => x.r);
}

// ──────────────────────────────────────────────────────────────────────────
// Bundle — single call for Killer Query dashboard
// ──────────────────────────────────────────────────────────────────────────

export function runAllKillerQueries() {
  return {
    topContacts: topActualContacts({ windowDays: 90, limit: 10 }),
    coolingWarming: coolingWarmingNetwork(),
    attentionShift: attentionShift({ months: 6 }),
    commitmentDrift: commitmentsVsExecution(),
  };
}
