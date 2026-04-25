/**
 * Contact aggregates — per-scan snapshots of per-person interaction counts.
 *
 * Why this module exists: scanners produce aggregate summaries (top senders
 * with total counts), not per-message event streams. Cooling/warming needs
 * TIME-DIFFERENTIATED data — "what was this person's count 30 days ago vs
 * today." A single scan run only gives "current total"; we need a scan run
 * from 30 days ago to compare against.
 *
 * Solution: every scan writes a contact_aggregates row per (contact, source,
 * direction). Over time these rows form a time series we can diff. This is
 * purely additive — each scan appends, never mutates.
 *
 * Replay property: snapshots are DERIVED state, not ground truth. If needed
 * they can be regenerated from scanner_events (if per-scan events are
 * logged). For now, treat them as first-class persistent state.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

export interface ContactAggregateInput {
  contactNodeId?: string;       // resolved person node if we matched it
  contactHandle: string;        // email or phone or raw identifier
  contactDisplayName?: string;
  source: "mail" | "messages" | "calendar";
  direction?: "received" | "sent" | "both";
  countInWindow: number;
  windowDays: number;           // what window this aggregate covers (e.g., 30)
  firstAt?: string;
  lastAt?: string;
  metadata?: Record<string, unknown>;
  /** Override snapshot_at — used by demo-seed to backdate synthetic rows */
  snapshotAt?: string;
}

export function writeContactAggregate(input: ContactAggregateInput): string {
  const userId = DEFAULT_USER_ID;
  const id = nanoid();
  // INSERT OR IGNORE: the UNIQUE index on (user_id, contact_handle, source,
  // direction, snapshot_at) means re-seeding or scanner double-firing within
  // the same second won't create duplicate snapshots. We still return the id
  // the caller would have gotten; if conflict, no row was created but
  // existing snapshot is intact.
  db.prepare(
    `INSERT OR IGNORE INTO contact_aggregates
     (id, user_id, snapshot_at, contact_node_id, contact_handle, contact_display_name,
      source, direction, count_in_window, window_days, first_at, last_at, metadata_json)
     VALUES (?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, userId, input.snapshotAt ?? null,
    input.contactNodeId ?? null, input.contactHandle, input.contactDisplayName ?? null,
    input.source, input.direction ?? null,
    input.countInWindow, input.windowDays,
    input.firstAt ?? null, input.lastAt ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
  return id;
}

/**
 * Get the most recent aggregate per (contact, source, direction) — this is
 * what "currently accepted knowledge" looks like for each person. Different
 * from "all history" which you'd read via a time-series query.
 */
export function latestAggregates(opts: { windowDays?: number } = {}): any[] {
  const where: string[] = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.windowDays !== undefined) {
    where.push("window_days = ?");
    params.push(opts.windowDays);
  }
  return db.prepare(
    `SELECT a.*
     FROM contact_aggregates a
     INNER JOIN (
       SELECT contact_handle, source, COALESCE(direction, '') as dir_key, MAX(snapshot_at) as max_at
       FROM contact_aggregates
       WHERE ${where.join(" AND ")}
       GROUP BY contact_handle, source, COALESCE(direction, '')
     ) latest
       ON a.contact_handle = latest.contact_handle
      AND a.source = latest.source
      AND COALESCE(a.direction, '') = latest.dir_key
      AND a.snapshot_at = latest.max_at
     WHERE a.user_id = ?
     ORDER BY a.count_in_window DESC`
  ).all(...params, DEFAULT_USER_ID) as any[];
}

/**
 * Get the most recent aggregate per contact AS OF a specific timestamp.
 * Returns snapshots whose snapshot_at <= asOf. Used by cooling/warming to
 * pick the "30-days-ago" comparison point.
 */
export function aggregatesAsOf(asOf: string): any[] {
  return db.prepare(
    `SELECT a.*
     FROM contact_aggregates a
     INNER JOIN (
       SELECT contact_handle, source, COALESCE(direction, '') as dir_key, MAX(snapshot_at) as max_at
       FROM contact_aggregates
       WHERE user_id = ? AND datetime(snapshot_at) <= datetime(?)
       GROUP BY contact_handle, source, COALESCE(direction, '')
     ) latest
       ON a.contact_handle = latest.contact_handle
      AND a.source = latest.source
      AND COALESCE(a.direction, '') = latest.dir_key
      AND a.snapshot_at = latest.max_at
     WHERE a.user_id = ?`
  ).all(DEFAULT_USER_ID, asOf, DEFAULT_USER_ID) as any[];
}

export function countAggregates(): number {
  return (db.prepare("SELECT COUNT(*) as c FROM contact_aggregates WHERE user_id=?").get(DEFAULT_USER_ID) as any).c;
}
