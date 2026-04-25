/**
 * L2 Storage — Event-sourced core.
 *
 * scanner_events is Anchor's append-only ground truth. All scanners emit
 * events here; graph/memories/timeline are materialized views. This file
 * owns the operations on that log: append (with hash chain + dedup),
 * manifest management, replay, and integrity audit.
 *
 * Non-goals: this module does NOT know how to derive graph state from
 * events. That's the scanner-specific derivation handlers' job (see
 * integrations/*). Keeping derivation out of storage lets us swap
 * derivation logic (model upgrades, prompt changes) without touching
 * the log.
 */
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "./db.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ScannerSource =
  | "mail" | "calendar" | "imessage" | "telegram"
  | "notes" | "safari" | "contacts" | "code" | "manual"
  | "tool_call";   // Agent tool invocations are events too — enables replay of agent behavior.

export interface ManifestInput {
  scanner: string;
  modelId?: string;       // null for scanners that don't use LLMs
  promptHash?: string;    // sha256 of the prompt template
  temperature?: number;
  config?: Record<string, unknown>;
}

export interface AppendEventInput {
  source: ScannerSource;
  kind: string;            // source-scoped event kind
  payload: unknown;        // arbitrary JSON; gets JSON.stringify'd
  /** When the event actually happened (valid time). ISO string. */
  occurredAt: string;
  /** Stable fields that identify "the same event" across re-runs. If omitted,
   *  we hash the full payload — safer but means any payload change creates a
   *  new event. Scanners should pass explicit fields for stable dedup. */
  stableFields?: Record<string, string | number>;
  manifestId?: string;     // leave null if scanner wasn't tracked
}

export interface ScannerEvent {
  seq: number;
  id: string;
  userId: string;
  source: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
  recordedAt: string;
  prevHash: string | null;
  thisHash: string;
  manifestId: string | null;
}

// ── Stable ID computation ──────────────────────────────────────────────────

/**
 * The event's stable id is sha256 over the fields a scanner considers
 * canonical for "this is the same event." A mail scanner would use
 * {messageId, folder}; a calendar scanner would use {uid, seq}.
 *
 * This id is what enforces idempotency across scanner re-runs — the
 * UNIQUE constraint on scanner_events.id rejects duplicates at the
 * storage layer, so scanners don't need to remember what they already
 * ingested.
 */
function computeStableId(source: string, kind: string, occurredAt: string, stableFields?: Record<string, string | number>): string {
  const h = createHash("sha256");
  h.update(source);
  h.update("\x00");
  h.update(kind);
  h.update("\x00");
  h.update(occurredAt);
  if (stableFields) {
    // Sort keys for stability across runs
    const keys = Object.keys(stableFields).sort();
    for (const k of keys) {
      h.update("\x00");
      h.update(k);
      h.update("\x00");
      h.update(String(stableFields[k]));
    }
  }
  return h.digest("hex");
}

/** Hash chain: sha256(prev_hash || id || canonicalized_payload) */
function computeThisHash(prevHash: string | null, id: string, payloadJson: string): string {
  const h = createHash("sha256");
  if (prevHash) h.update(prevHash);
  h.update("\x01");
  h.update(id);
  h.update("\x01");
  h.update(payloadJson);
  return h.digest("hex");
}

// ── Manifest management ────────────────────────────────────────────────────

/**
 * Manifests are deduped by (scanner, model_id, prompt_hash, temperature).
 * A new row is created only when the tuple changes. This means "mail
 * scanner ran 10,000 times today" produces 1 manifest row, referenced by
 * 10,000 events — efficient AND auditable.
 */
export function getOrCreateManifest(input: ManifestInput): string {
  const modelId = input.modelId ?? null;
  const promptHash = input.promptHash ?? null;
  const temp = input.temperature ?? 0;

  const existing = db.prepare(
    `SELECT id FROM derivation_manifest
     WHERE scanner = ? AND
           COALESCE(model_id, '') = COALESCE(?, '') AND
           COALESCE(prompt_hash, '') = COALESCE(?, '') AND
           temperature = ?
     LIMIT 1`
  ).get(input.scanner, modelId, promptHash, temp) as any;

  if (existing) return existing.id;

  const id = nanoid();
  db.prepare(
    `INSERT INTO derivation_manifest (id, scanner, model_id, prompt_hash, temperature, config_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.scanner, modelId, promptHash, temp, JSON.stringify(input.config ?? {}));
  return id;
}

// ── Append ────────────────────────────────────────────────────────────────

/**
 * Append an event to the log. Returns { seq, id, duplicate }. If the event
 * is a duplicate (same stable id already exists), returns the existing
 * seq/id without modification. Scanners should treat duplicate=true as
 * "already ingested — carry on."
 *
 * Hash chain and UNIQUE insertion are done in a single transaction to avoid
 * races: two concurrent appends can't both see the same "current tip" and
 * both write a chain branch.
 */
export function appendEvent(input: AppendEventInput): { seq: number; id: string; duplicate: boolean } {
  const userId = DEFAULT_USER_ID;
  const id = computeStableId(input.source, input.kind, input.occurredAt, input.stableFields);
  const payloadJson = JSON.stringify(input.payload);

  return db.transaction(() => {
    // Dedup check
    const existing = db.prepare("SELECT seq, id FROM scanner_events WHERE id = ?").get(id) as any;
    if (existing) return { seq: existing.seq, id: existing.id, duplicate: true };

    // Get chain tip (last this_hash for this user) — nullable on first event.
    const tip = db.prepare(
      "SELECT this_hash FROM scanner_events WHERE user_id = ? ORDER BY seq DESC LIMIT 1"
    ).get(userId) as any;
    const prevHash = tip?.this_hash ?? null;
    const thisHash = computeThisHash(prevHash, id, payloadJson);

    const result = db.prepare(
      `INSERT INTO scanner_events
       (id, user_id, source, kind, payload_json, occurred_at, prev_hash, this_hash, manifest_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId, input.source, input.kind, payloadJson, input.occurredAt, prevHash, thisHash, input.manifestId ?? null);

    return { seq: Number(result.lastInsertRowid), id, duplicate: false };
  })();
}

/**
 * Shadow emit — fire-and-forget convenience wrapper used by local scanners
 * to drop a single summary event into the chain after each scan run, without
 * disrupting the scanner if anything in the event-storage layer is unhealthy.
 *
 * The dedup contract is the caller's responsibility via stableFields: pass
 * something like `{ scanDay: "2026-04-23" }` so re-running the same scanner
 * twice in one day collapses to a single event.
 */
export function shadowEmit(input: {
  scanner: string;
  source: ScannerSource;
  kind: string;
  occurredAt?: string;
  stableFields: Record<string, string | number>;
  payload: unknown;
  modelId?: string;
}): void {
  try {
    const manifestId = getOrCreateManifest({ scanner: input.scanner, modelId: input.modelId });
    appendEvent({
      source: input.source,
      kind: input.kind,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      stableFields: input.stableFields,
      payload: input.payload,
      manifestId,
    });
  } catch (err: any) {
    console.error(`[shadowEmit] ${input.scanner} failed:`, err?.message ?? err);
  }
}

/**
 * Verbatim import — insert an event with its original id / prev_hash /
 * this_hash preserved. Used by sync/import to reproduce the sender's chain
 * exactly (so hashes match across devices). Validates integrity before
 * inserting:
 *   - thisHash must equal sha256(prevHash || id || payload)
 *   - prevHash must equal the current local tip (caller enforces this;
 *     here we only check the payload→hash binding).
 * Returns { duplicate: true } if an event with this id already exists.
 *
 * This is deliberately separate from appendEvent — appendEvent computes id
 * and hash from scratch (for local scanners); importEventVerbatim accepts
 * both and verifies them (for replicated events from peers).
 */
export function importEventVerbatim(event: {
  id: string;
  userId: string;
  source: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
  prevHash: string | null;
  thisHash: string;
  manifestId?: string | null;
}): { inserted: boolean; reason?: string } {
  const payloadJson = JSON.stringify(event.payload);
  const recomputed = computeThisHash(event.prevHash, event.id, payloadJson);
  if (recomputed !== event.thisHash) {
    return { inserted: false, reason: "hash_mismatch_payload_tampered" };
  }

  // Dedup by id (UNIQUE constraint would also catch, but pre-check is cleaner)
  const existing = db.prepare("SELECT 1 FROM scanner_events WHERE id = ?").get(event.id);
  if (existing) return { inserted: false, reason: "duplicate" };

  db.prepare(
    `INSERT INTO scanner_events
     (id, user_id, source, kind, payload_json, occurred_at, prev_hash, this_hash, manifest_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(event.id, event.userId, event.source, event.kind, payloadJson, event.occurredAt,
        event.prevHash, event.thisHash, event.manifestId ?? null);
  return { inserted: true };
}

// ── Read / replay ─────────────────────────────────────────────────────────

export interface GetEventsOptions {
  source?: ScannerSource | ScannerSource[];
  kind?: string;
  /** Events whose occurred_at >= from */
  occurredFrom?: string;
  /** Events whose occurred_at < to */
  occurredTo?: string;
  /** Events recorded by Anchor by this transaction-time (for replay-at-knownAt) */
  knownBy?: string;
  /** Start from this seq (exclusive). For incremental sync. */
  afterSeq?: number;
  limit?: number;
}

export function getEvents(opts: GetEventsOptions = {}): ScannerEvent[] {
  const userId = DEFAULT_USER_ID;
  const wheres: string[] = ["user_id = ?"];
  const params: any[] = [userId];

  if (opts.source) {
    const sources = Array.isArray(opts.source) ? opts.source : [opts.source];
    wheres.push(`source IN (${sources.map(() => "?").join(",")})`);
    params.push(...sources);
  }
  if (opts.kind) { wheres.push("kind = ?"); params.push(opts.kind); }
  if (opts.occurredFrom) { wheres.push("datetime(occurred_at) >= datetime(?)"); params.push(opts.occurredFrom); }
  if (opts.occurredTo) { wheres.push("datetime(occurred_at) < datetime(?)"); params.push(opts.occurredTo); }
  if (opts.knownBy) { wheres.push("datetime(recorded_at) <= datetime(?)"); params.push(opts.knownBy); }
  if (opts.afterSeq !== undefined) { wheres.push("seq > ?"); params.push(opts.afterSeq); }

  const limit = Math.min(10_000, Math.max(1, opts.limit ?? 1000));

  const rows = db.prepare(`
    SELECT seq, id, user_id, source, kind, payload_json, occurred_at, recorded_at, prev_hash, this_hash, manifest_id
    FROM scanner_events
    WHERE ${wheres.join(" AND ")}
    ORDER BY seq ASC
    LIMIT ?
  `).all(...params, limit) as any[];

  return rows.map(r => ({
    seq: r.seq,
    id: r.id,
    userId: r.user_id,
    source: r.source,
    kind: r.kind,
    payload: safeParseJson(r.payload_json),
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    prevHash: r.prev_hash,
    thisHash: r.this_hash,
    manifestId: r.manifest_id,
  }));
}

// ── Integrity audit ───────────────────────────────────────────────────────

export interface HashChainReport {
  totalEvents: number;
  verifiedEvents: number;
  firstBadSeq: number | null;
  firstBadReason: string | null;
}

/**
 * Walk the chain in order, recompute each event's hash, confirm it matches
 * what's stored. Linear-time integrity check; run nightly via workflow or
 * on-demand from admin. Anything off = either DB corruption or tampering.
 */
export function verifyHashChain(userId: string = DEFAULT_USER_ID): HashChainReport {
  const rows = db.prepare(
    `SELECT seq, id, payload_json, prev_hash, this_hash
     FROM scanner_events WHERE user_id = ? ORDER BY seq ASC`
  ).all(userId) as any[];

  let expectedPrev: string | null = null;
  let verified = 0;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        totalEvents: rows.length,
        verifiedEvents: verified,
        firstBadSeq: row.seq,
        firstBadReason: `prev_hash mismatch: expected ${expectedPrev}, got ${row.prev_hash}`,
      };
    }
    const recomputed = computeThisHash(row.prev_hash, row.id, row.payload_json);
    if (recomputed !== row.this_hash) {
      return {
        totalEvents: rows.length,
        verifiedEvents: verified,
        firstBadSeq: row.seq,
        firstBadReason: `this_hash mismatch: expected ${recomputed}, got ${row.this_hash}`,
      };
    }
    expectedPrev = row.this_hash;
    verified++;
  }
  return { totalEvents: rows.length, verifiedEvents: verified, firstBadSeq: null, firstBadReason: null };
}

// ── Stats ─────────────────────────────────────────────────────────────────

export interface EventStats {
  totalEvents: number;
  bySource: Record<string, number>;
  latestSeq: number | null;
  latestRecordedAt: string | null;
  totalManifests: number;
}

export function getEventStats(userId: string = DEFAULT_USER_ID): EventStats {
  const total = (db.prepare("SELECT COUNT(*) as c FROM scanner_events WHERE user_id = ?").get(userId) as any).c;
  const bySourceRows = db.prepare(
    "SELECT source, COUNT(*) as c FROM scanner_events WHERE user_id = ? GROUP BY source"
  ).all(userId) as any[];
  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source] = r.c;

  const latest = db.prepare(
    "SELECT seq, recorded_at FROM scanner_events WHERE user_id = ? ORDER BY seq DESC LIMIT 1"
  ).get(userId) as any;

  const manifests = (db.prepare("SELECT COUNT(*) as c FROM derivation_manifest").get() as any).c;

  return {
    totalEvents: total,
    bySource,
    latestSeq: latest?.seq ?? null,
    latestRecordedAt: latest?.recorded_at ?? null,
    totalManifests: manifests,
  };
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
