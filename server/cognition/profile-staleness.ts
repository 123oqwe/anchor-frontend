/**
 * L3 Cognition — Profile staleness detection + auto-refresh trigger.
 *
 * InferredProfile is version-stamped but, until now, only regenerated
 * when the user clicked something. Result: Oracle Portraits reflect a
 * graph snapshot that may be weeks old while the live graph has drifted
 * substantially (new people, new projects, shifted weights).
 *
 * This module computes staleness reasons from multiple independent
 * signals (node growth, person growth, timeline activity, age) and
 * queues a refresh via the workflow DAG when any threshold is crossed.
 * User-visible via GET /api/profile/staleness — frontend can banner
 * "Your Portrait is 3 weeks old, 47 new graph nodes. Refresh now?"
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

// Tunable thresholds. Values err on the side of "not nagging" —
// daily cron checks, but refresh only when any ONE threshold crosses.
const THRESHOLDS = {
  NODES_GROWTH: 20,          // new graph nodes since profile → refresh
  PERSONS_GROWTH: 3,          // new person nodes specifically → social circle shift
  TIMELINE_GROWTH: 50,        // new timeline events → activity surge
  MAX_AGE_DAYS: 30,           // hard upper bound — refresh at least monthly
  SOFT_AGE_DAYS: 14,          // flag as "getting stale" for UI but don't trigger
};

export interface StalenessResult {
  isStale: boolean;
  reasons: string[];             // human-readable "why refresh"
  ageDays: number;
  profileVersion: number | null;
  profileCreatedAt: string | null;
  signals: {
    nodesAdded: number;
    personsAdded: number;
    timelineEventsAdded: number;
  };
  shouldAutoRefresh: boolean;    // true = cron should queue; false = wait
  alreadyRunning: boolean;       // prevent re-queue if refresh in flight
}

export function computeStaleness(): StalenessResult {
  const latest = db.prepare(
    `SELECT version, created_at FROM inferred_profiles WHERE user_id=? ORDER BY version DESC LIMIT 1`
  ).get(DEFAULT_USER_ID) as any;

  if (!latest) {
    return {
      isStale: true,
      reasons: ["no profile yet"],
      ageDays: Infinity,
      profileVersion: null,
      profileCreatedAt: null,
      signals: { nodesAdded: 0, personsAdded: 0, timelineEventsAdded: 0 },
      shouldAutoRefresh: true,
      alreadyRunning: isRefreshInFlight(),
    };
  }

  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  const ageDays = ageMs / 86_400_000;

  // Counts since profile was created — uses `datetime()` normalization
  // because SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" but JS
  // may pass ISO-with-T. (Same T-vs-space bug we caught in Phase D.)
  const nodesAdded = (db.prepare(
    `SELECT COUNT(*) as c FROM graph_nodes
     WHERE user_id=? AND datetime(created_at) > datetime(?)`
  ).get(DEFAULT_USER_ID, latest.created_at) as any).c;

  const personsAdded = (db.prepare(
    `SELECT COUNT(*) as c FROM graph_nodes
     WHERE user_id=? AND type='person' AND datetime(created_at) > datetime(?)`
  ).get(DEFAULT_USER_ID, latest.created_at) as any).c;

  const timelineEventsAdded = (db.prepare(
    `SELECT COUNT(*) as c FROM timeline_events
     WHERE user_id=? AND datetime(created_at) > datetime(?)`
  ).get(DEFAULT_USER_ID, latest.created_at) as any).c;

  const reasons: string[] = [];
  if (ageDays > THRESHOLDS.MAX_AGE_DAYS) {
    reasons.push(`${Math.floor(ageDays)} days since last profile (max ${THRESHOLDS.MAX_AGE_DAYS})`);
  }
  if (nodesAdded >= THRESHOLDS.NODES_GROWTH) {
    reasons.push(`${nodesAdded} new graph nodes (threshold ${THRESHOLDS.NODES_GROWTH})`);
  }
  if (personsAdded >= THRESHOLDS.PERSONS_GROWTH) {
    reasons.push(`${personsAdded} new people in graph (threshold ${THRESHOLDS.PERSONS_GROWTH})`);
  }
  if (timelineEventsAdded >= THRESHOLDS.TIMELINE_GROWTH) {
    reasons.push(`${timelineEventsAdded} new timeline events (threshold ${THRESHOLDS.TIMELINE_GROWTH})`);
  }

  const shouldAutoRefresh = reasons.length > 0;
  const isStale = shouldAutoRefresh || ageDays > THRESHOLDS.SOFT_AGE_DAYS;

  return {
    isStale,
    reasons,
    ageDays: +ageDays.toFixed(1),
    profileVersion: latest.version,
    profileCreatedAt: latest.created_at,
    signals: { nodesAdded, personsAdded, timelineEventsAdded },
    shouldAutoRefresh,
    alreadyRunning: isRefreshInFlight(),
  };
}

/**
 * Is a refresh already in flight? Check workflow_runs for any pending
 * or running run of profile_auto_refresh started in the last 30 minutes.
 */
function isRefreshInFlight(): boolean {
  const row = db.prepare(
    `SELECT id FROM workflow_runs
     WHERE user_id=? AND workflow_id='profile_auto_refresh'
       AND status='running'
       AND datetime(started_at) > datetime('now', '-30 minutes')
     LIMIT 1`
  ).get(DEFAULT_USER_ID) as any;
  return !!row;
}

export { THRESHOLDS };
