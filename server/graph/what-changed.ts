/**
 * L1 Graph — What-Changed queries.
 *
 * The Human Graph has bi-temporal edges (valid_from / valid_to) since
 * Graph #2. That infrastructure is pointless if nothing surfaces the
 * diff to users. This module turns those edges into the answer to
 * "how has my Human Graph changed between date A and date B?"
 *
 * Primary use cases:
 *   - Dashboards / growth cards ("3 new relationships this week")
 *   - Oracle / agent reflection ("you shifted focus from X to Y last month")
 *   - Debugging a profile-inference change that rewrote edges
 *
 * All queries are scoped to the default user and run directly against
 * graph_edges + graph_nodes without joins across time-slice views.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

export interface EdgeChange {
  edgeId: string;
  fromId: string;
  toId: string;
  fromLabel: string;
  toLabel: string;
  type: string;
  weight: number;
  validFrom: string;
  validTo: string | null;
  metadata: any;
}

export interface WeightChange {
  fromId: string;
  toId: string;
  fromLabel: string;
  toLabel: string;
  type: string;
  previousWeight: number;
  newWeight: number;
  changedAt: string;
  delta: number;
}

export interface NodeChange {
  id: string;
  label: string;
  type: string;
  domain: string;
  createdAt: string;
  captured: string;
}

export interface ChangesResult {
  windowStart: string;
  windowEnd: string;
  newEdges: EdgeChange[];
  closedEdges: EdgeChange[];
  weightChanges: WeightChange[];
  newNodes: NodeChange[];
  summary: {
    newRelationships: number;
    relationshipsEnded: number;
    newProjects: number;
    newContacts: number;
    totalActiveEdges: number;
  };
}

/**
 * Compute the changes to the Human Graph in [from, to). If nodeId is
 * provided, filter to edges touching that node. Uses bi-temporal columns
 * so historical (soft-closed) edges are visible in the diff.
 */
export function computeChanges(opts: {
  from: string;                   // ISO timestamp
  to: string;                     // ISO timestamp (exclusive)
  nodeId?: string;                // optional scope to edges touching this node
}): ChangesResult {
  const nodeFilter = opts.nodeId
    ? " AND (e.from_node_id = ? OR e.to_node_id = ?)"
    : "";
  const nodeParams = opts.nodeId ? [opts.nodeId, opts.nodeId] : [];

  // Note: SQLite's datetime('now') stores timestamps as 'YYYY-MM-DD HH:MM:SS'
  // while JS toISOString() emits 'YYYY-MM-DDTHH:MM:SS.sssZ'. String-compare
  // fails because 'T' (0x54) sorts above ' ' (0x20). Wrapping both sides
  // in datetime(...) normalizes for correct comparison.

  // 1) Edges that OPENED during the window
  const newEdgesSql = `
    SELECT e.id, e.from_node_id as fromId, e.to_node_id as toId, e.type, e.weight, e.metadata,
           e.valid_from as validFrom, e.valid_to as validTo,
           f.label as fromLabel, t.label as toLabel
    FROM graph_edges e
    JOIN graph_nodes f ON e.from_node_id = f.id
    JOIN graph_nodes t ON e.to_node_id   = t.id
    WHERE e.user_id = ?
      AND datetime(e.valid_from) >= datetime(?) AND datetime(e.valid_from) < datetime(?)
      ${nodeFilter}
    ORDER BY e.valid_from DESC`;
  const newEdges = db.prepare(newEdgesSql).all(DEFAULT_USER_ID, opts.from, opts.to, ...nodeParams) as any[];

  // 2) Edges that CLOSED (soft-deleted / invalidated) during the window
  const closedEdgesSql = `
    SELECT e.id, e.from_node_id as fromId, e.to_node_id as toId, e.type, e.weight, e.metadata,
           e.valid_from as validFrom, e.valid_to as validTo,
           f.label as fromLabel, t.label as toLabel
    FROM graph_edges e
    JOIN graph_nodes f ON e.from_node_id = f.id
    JOIN graph_nodes t ON e.to_node_id   = t.id
    WHERE e.user_id = ?
      AND datetime(e.valid_to) >= datetime(?) AND datetime(e.valid_to) < datetime(?)
      ${nodeFilter}
    ORDER BY e.valid_to DESC`;
  const closedEdges = db.prepare(closedEdgesSql).all(DEFAULT_USER_ID, opts.from, opts.to, ...nodeParams) as any[];

  // 3) Weight changes: when replaceEdgeVersion opens a new edge that
  //    replaces a same (from, to, type) triplet. Pair new-version with
  //    the previous version (which was soft-closed at the same moment).
  const weightChanges: WeightChange[] = [];
  const seenPairs = new Set<string>();
  for (const newE of newEdges) {
    const key = `${newE.fromId}|${newE.toId}|${newE.type}`;
    if (seenPairs.has(key)) continue;
    const prev = db.prepare(
      `SELECT weight, valid_to as validTo FROM graph_edges
       WHERE user_id=? AND from_node_id=? AND to_node_id=? AND type=?
         AND valid_to = ?`
    ).get(DEFAULT_USER_ID, newE.fromId, newE.toId, newE.type, newE.validFrom) as any;
    if (prev && Math.abs(prev.weight - newE.weight) >= 0.01) {
      weightChanges.push({
        fromId: newE.fromId, toId: newE.toId,
        fromLabel: newE.fromLabel, toLabel: newE.toLabel,
        type: newE.type,
        previousWeight: prev.weight,
        newWeight: newE.weight,
        changedAt: newE.validFrom,
        delta: +(newE.weight - prev.weight).toFixed(3),
      });
      seenPairs.add(key);
    }
  }

  // 4) Nodes created in window
  const nodeFilterNode = opts.nodeId ? " AND n.id = ?" : "";
  const nodeParamsNode = opts.nodeId ? [opts.nodeId] : [];
  const newNodes = db.prepare(
    `SELECT id, label, type, domain, created_at as createdAt, captured
     FROM graph_nodes n
     WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) ${nodeFilterNode}
     ORDER BY created_at DESC`
  ).all(DEFAULT_USER_ID, opts.from, opts.to, ...nodeParamsNode) as any[];

  // 5) Counts for summary
  const newRelationships = newEdges.filter((e: any) =>
    e.type === "contextual" || e.type === "supports").length;
  const relationshipsEnded = closedEdges.filter((e: any) =>
    e.type === "contextual" || e.type === "supports").length;
  const newProjects = newNodes.filter(n => n.type === "project" || n.type === "goal").length;
  const newContacts = newNodes.filter(n => n.type === "person").length;
  const totalActiveEdges = (db.prepare(
    `SELECT COUNT(*) as c FROM graph_edges WHERE user_id=? AND valid_to IS NULL`
  ).get(DEFAULT_USER_ID) as any).c;

  const parseMeta = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

  return {
    windowStart: opts.from,
    windowEnd: opts.to,
    newEdges: newEdges.map((e: any) => ({ ...e, metadata: parseMeta(e.metadata) })),
    closedEdges: closedEdges.map((e: any) => ({ ...e, metadata: parseMeta(e.metadata) })),
    weightChanges,
    newNodes,
    summary: {
      newRelationships,
      relationshipsEnded,
      newProjects,
      newContacts,
      totalActiveEdges,
    },
  };
}

// ── Growth card generator (rule-based; LLM optional) ─────────────────────

export interface GrowthCard {
  headline: string;
  bullets: string[];
  windowStart: string;
  windowEnd: string;
  summary: ChangesResult["summary"];
  timelineDelta: {                 // last N days vs prior N days
    activityChange: number;         // ratio (current / prior)
    topGainingKind: string | null;
    topGainingKindCount: number;
  };
}

/**
 * Rule-based growth card — no LLM required. Produces a short, specific
 * changelog over the last 7 days. Called by the weekly cron; result is
 * written as a timeline event with kind="weekly_card" so it surfaces
 * alongside commits / meetings in the timeline view.
 */
export function generateWeeklyGrowthCard(): GrowthCard {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86_400_000);
  const windowStart = weekAgo.toISOString();
  const windowEnd = now.toISOString();

  const changes = computeChanges({ from: windowStart, to: windowEnd });

  // Compare this week's timeline activity vs last week's
  const thisWeek = db.prepare(
    `SELECT kind, COUNT(*) as c FROM timeline_events
     WHERE user_id=? AND datetime(occurred_at) >= datetime(?) AND datetime(occurred_at) < datetime(?)
     GROUP BY kind`
  ).all(DEFAULT_USER_ID, windowStart, windowEnd) as any[];
  const priorWeek = db.prepare(
    `SELECT COUNT(*) as c FROM timeline_events
     WHERE user_id=? AND datetime(occurred_at) >= datetime(?) AND datetime(occurred_at) < datetime(?)`
  ).get(DEFAULT_USER_ID, twoWeeksAgo.toISOString(), windowStart) as any;

  const thisWeekTotal = thisWeek.reduce((s: number, r: any) => s + r.c, 0);
  const activityChange = priorWeek?.c > 0 ? +(thisWeekTotal / priorWeek.c).toFixed(2) : 0;
  const topKind = thisWeek.sort((a: any, b: any) => b.c - a.c)[0];

  // Rule-based bullets — specific, unambiguous, no LLM variability
  const bullets: string[] = [];
  if (changes.summary.newContacts > 0) bullets.push(`${changes.summary.newContacts} new ${changes.summary.newContacts === 1 ? "person" : "people"} entered your graph`);
  if (changes.summary.newProjects > 0) bullets.push(`${changes.summary.newProjects} new ${changes.summary.newProjects === 1 ? "project/goal" : "projects/goals"} surfaced`);
  if (changes.summary.relationshipsEnded > 0) bullets.push(`${changes.summary.relationshipsEnded} relationship ${changes.summary.relationshipsEnded === 1 ? "edge closed" : "edges closed"} (decay or contradicted)`);
  if (topKind) bullets.push(`${topKind.c} ${topKind.kind} event${topKind.c === 1 ? "" : "s"}`);
  if (activityChange > 1.2) bullets.push(`activity up ${Math.round((activityChange - 1) * 100)}% vs prior week`);
  else if (activityChange > 0 && activityChange < 0.8) bullets.push(`activity down ${Math.round((1 - activityChange) * 100)}% vs prior week`);
  if (changes.weightChanges.length > 0) bullets.push(`${changes.weightChanges.length} relationship weight${changes.weightChanges.length === 1 ? "" : "s"} shifted`);

  let headline = "A quiet week";
  if (changes.summary.newContacts + changes.summary.newProjects >= 3) headline = "A busy week for new connections and directions";
  else if (changes.summary.relationshipsEnded > 0 && changes.summary.newRelationships === 0) headline = "A pruning week — ties closed, nothing new opened";
  else if (activityChange > 1.5) headline = "Above-baseline week — significantly more activity than usual";
  else if (activityChange > 0 && activityChange < 0.6) headline = "Below-baseline week — noticeably quieter";
  else if (changes.summary.newProjects > 0) headline = `${changes.summary.newProjects} new direction${changes.summary.newProjects === 1 ? "" : "s"} appeared`;

  return {
    headline,
    bullets,
    windowStart, windowEnd,
    summary: changes.summary,
    timelineDelta: {
      activityChange,
      topGainingKind: topKind?.kind ?? null,
      topGainingKindCount: topKind?.c ?? 0,
    },
  };
}
