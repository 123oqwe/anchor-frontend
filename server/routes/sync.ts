/**
 * Sync routes — move scanner_events between Anchor devices.
 *
 * Protocol (minimal viable, single-user multi-device):
 *   1. Device A: POST /api/sync/export { afterSeq? } → returns bundle
 *   2. Device B: POST /api/sync/import { bundle } → verifies chain, appends
 *
 * Invariants:
 *   - Events are append-only. Import can only extend the local tip; it
 *     cannot replace history.
 *   - Hash chain is re-verified end-to-end before any export.
 *   - Imports that don't start from the local tip's hash are rejected —
 *     either the tail is missing (incremental sync pull first) or the
 *     chains have forked (manual reconcile needed).
 *
 * Transport is intentionally abstracted: the bundle is plain JSON. The
 * user can ship it via iCloud Drive, Tailscale, scp, or USB stick. We do
 * not assume a network topology; we assume two devices that can exchange
 * a file. This keeps the protocol testable offline.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { verifyHashChain, getEvents, importEventVerbatim } from "../infra/storage/scanner-events.js";
import { createHash } from "crypto";

/**
 * Pre-flight integrity: verify every event's this_hash matches its payload
 * before we touch the DB. Rejects the bundle as a whole if ANY event is
 * tampered — we never want partial tampered imports since that'd poison
 * downstream chain-continuity checks.
 */
function verifyBundleIntegrity(events: any[]): { ok: boolean; badSeq?: number } {
  for (const e of events) {
    const recomputed = createHash("sha256")
      .update(e.prevHash ?? "")
      .update("\x01")
      .update(e.id)
      .update("\x01")
      .update(JSON.stringify(e.payload))
      .digest("hex");
    if (recomputed !== e.thisHash) return { ok: false, badSeq: e.seq };
  }
  return { ok: true };
}

const router = Router();

interface ExportBundle {
  deviceId: string;
  userId: string;
  afterSeq: number;
  firstSeq: number | null;
  lastSeq: number | null;
  lastHash: string | null;
  events: any[];
  /** Derivation manifests referenced by events. Shipped alongside so the
   *  receiver can satisfy scanner_events.manifest_id FK constraints. */
  manifests: any[];
  /** Phase 2 — user customizations to system agents (per-field). Shipped
   *  so a 2nd device adopts the same Soul.voice / additions / snoozes. */
  systemAgentOverrides?: any[];
  systemAgentAdditions?: any[];
  systemCronOverrides?: any[];
  bundleHash: string;
  exportedAt: string;
}

function getDeviceId(): string {
  // Best-effort stable device ID; user_agents table or settings could own
  // this. For the spike, derive from hostname + db path.
  return `anchor-${process.platform}-${process.env.USER ?? "unknown"}`;
}

function computeBundleHash(events: any[]): string {
  const h = createHash("sha256");
  for (const e of events) h.update(e.thisHash);
  return h.digest("hex");
}

// ── Export ─────────────────────────────────────────────────────────────────
router.post("/export", (req, res) => {
  try {
    const afterSeq = Number(req.body?.afterSeq ?? 0);

    // Gate: refuse to export a broken chain
    const audit = verifyHashChain(DEFAULT_USER_ID);
    if (audit.firstBadSeq !== null) {
      return res.status(409).json({
        error: "local hash chain broken — refuse to export",
        audit,
      });
    }

    const events = getEvents({ afterSeq, limit: 10_000 });
    const first = events[0] ?? null;
    const last = events[events.length - 1] ?? null;

    // Ship manifest rows referenced by exported events. Receiver upserts
    // them before importing events, so FK constraints are satisfiable.
    const manifestIds = Array.from(new Set(
      events.map(e => e.manifestId).filter((x): x is string => !!x)
    ));
    const manifests = manifestIds.length === 0 ? [] : db.prepare(
      `SELECT id, scanner, model_id, prompt_hash, temperature, config_json, created_at
       FROM derivation_manifest WHERE id IN (${manifestIds.map(() => "?").join(",")})`
    ).all(...manifestIds);

    // Phase 2 — bundle user's per-field customizations to system agents
    // (voice, snooze, added constraints) so a 2nd device adopts the same
    // user preferences. These tables don't have hash chains; safe to ship
    // as plain JSON. Importer upserts on (agent_id, field_path) PK.
    const systemAgentOverrides = (() => {
      try { return db.prepare("SELECT * FROM system_agent_overrides").all(); }
      catch { return []; }
    })();
    const systemAgentAdditions = (() => {
      try { return db.prepare("SELECT * FROM system_agent_additions").all(); }
      catch { return []; }
    })();
    const systemCronOverrides = (() => {
      try { return db.prepare("SELECT * FROM system_cron_overrides").all(); }
      catch { return []; }
    })();

    const bundle: ExportBundle = {
      deviceId: getDeviceId(),
      userId: DEFAULT_USER_ID,
      afterSeq,
      firstSeq: first?.seq ?? null,
      lastSeq: last?.seq ?? null,
      lastHash: last?.thisHash ?? null,
      events,
      manifests,
      systemAgentOverrides,
      systemAgentAdditions,
      systemCronOverrides,
      bundleHash: computeBundleHash(events),
      exportedAt: new Date().toISOString(),
    };
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "export failed" });
  }
});

// ── Peers list (stub — returns self) ───────────────────────────────────────
router.get("/peers", (_req, res) => {
  try {
    const audit = verifyHashChain(DEFAULT_USER_ID);
    const tip = db.prepare(
      "SELECT seq, this_hash, recorded_at FROM scanner_events WHERE user_id=? ORDER BY seq DESC LIMIT 1"
    ).get(DEFAULT_USER_ID) as any;
    res.json({
      self: {
        deviceId: getDeviceId(),
        latestSeq: tip?.seq ?? 0,
        latestHash: tip?.this_hash ?? null,
        latestRecordedAt: tip?.recorded_at ?? null,
        chainValid: audit.firstBadSeq === null,
      },
      peers: [],  // multi-device peers table to come in P6 full
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ── Import ────────────────────────────────────────────────────────────────
router.post("/import", (req, res) => {
  try {
    const bundle = req.body as ExportBundle;
    if (!bundle || !Array.isArray(bundle.events)) {
      return res.status(400).json({ error: "invalid bundle" });
    }

    // Gate 1: bundle hash re-computation — catches envelope tampering.
    const expectedBundleHash = computeBundleHash(bundle.events);
    if (expectedBundleHash !== bundle.bundleHash) {
      return res.status(400).json({
        error: "bundle hash mismatch — possible tampering",
        expected: expectedBundleHash,
        got: bundle.bundleHash,
      });
    }

    // Gate 1b: per-event integrity — catches payload tampering. The bundle
    // hash is computed over thisHash values, which don't change if someone
    // mutates the payload; we need this separate check to catch that.
    const integrity = verifyBundleIntegrity(bundle.events);
    if (!integrity.ok) {
      return res.status(400).json({
        error: "per-event hash mismatch — payload tampering",
        badSeq: integrity.badSeq,
      });
    }

    // Gate 1c: upsert manifests BEFORE events so FK refs resolve. Old bundle
    // formats without `manifests` field (produced before this fix) degrade to
    // []. Idempotent via INSERT OR IGNORE — existing manifests aren't clobbered.
    const manifests = Array.isArray(bundle.manifests) ? bundle.manifests : [];
    for (const m of manifests) {
      db.prepare(
        `INSERT OR IGNORE INTO derivation_manifest
         (id, scanner, model_id, prompt_hash, temperature, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(m.id, m.scanner, m.model_id ?? null, m.prompt_hash ?? null,
            m.temperature ?? 0, m.config_json ?? "{}", m.created_at);
    }

    // Gate 2: local chain must be extendable from bundle's first *new* event.
    // We identify new-vs-duplicate up front: bundle events already in local
    // DB (by stable id) will be no-ops regardless, so the chain-continuity
    // check only needs to cover genuinely-new events. This makes idempotent
    // re-import safe: a bundle that's 100% duplicate with local state
    // passes through cleanly; a partially-overlapping bundle is checked for
    // continuity at the first novel event.
    const localTip = db.prepare(
      "SELECT seq, this_hash FROM scanner_events WHERE user_id=? ORDER BY seq DESC LIMIT 1"
    ).get(DEFAULT_USER_ID) as any;
    const localTipHash = localTip?.this_hash ?? null;

    // Find the first event in the bundle whose id doesn't exist locally
    const idExistsStmt = db.prepare("SELECT 1 FROM scanner_events WHERE id = ?");
    const firstNovel = bundle.events.find((e: any) => !idExistsStmt.get(e.id));

    if (firstNovel && firstNovel.prevHash !== localTipHash) {
      return res.status(409).json({
        error: "chain continuity violation",
        localTip: localTipHash,
        bundleFirstPrev: firstNovel.prevHash,
        resolution: "pull missing events first, or if fork: manual reconcile required",
      });
    }

    // Verbatim insert each event — preserves sender's id + hash chain so
    // the receiver's chain is byte-identical to the sender's. Re-computes
    // thisHash from payload and rejects if it doesn't match (per-event
    // tamper detection, in addition to the bundle hash gate above).
    let imported = 0, duplicate = 0;
    const rejected: any[] = [];
    for (const e of bundle.events) {
      try {
        const r = importEventVerbatim({
          id: e.id,
          userId: DEFAULT_USER_ID,
          source: e.source,
          kind: e.kind,
          payload: e.payload,
          occurredAt: e.occurredAt,
          prevHash: e.prevHash,
          thisHash: e.thisHash,
          manifestId: e.manifestId ?? null,
        });
        if (r.inserted) imported++;
        else if (r.reason === "duplicate") duplicate++;
        else rejected.push({ seq: e.seq, reason: r.reason });
      } catch (itemErr: any) {
        rejected.push({ seq: e.seq, error: itemErr?.message });
      }
    }

    // Gate 3: post-import chain audit — if we corrupted something, flag loudly
    const audit = verifyHashChain(DEFAULT_USER_ID);

    // Phase 2 — adopt user's customizations from the bundle. These are
    // simple upserts; no hash-chain semantics. Last-write-wins per
    // (agent_id, field_path) PK / per (cron_id) PK. Best-effort: a
    // failed sysAgent upsert never fails the whole import.
    let overridesAdopted = 0, additionsAdopted = 0, cronOverridesAdopted = 0;
    if (Array.isArray(bundle.systemAgentOverrides)) {
      const stmt = db.prepare(
        "INSERT INTO system_agent_overrides (agent_id, field_path, value, set_at, schema_version) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(agent_id, field_path) DO UPDATE SET value=excluded.value, set_at=excluded.set_at"
      );
      for (const r of bundle.systemAgentOverrides) {
        try { stmt.run(r.agent_id, r.field_path, r.value, r.set_at ?? new Date().toISOString(), r.schema_version ?? 1); overridesAdopted++; } catch {}
      }
    }
    if (Array.isArray(bundle.systemAgentAdditions)) {
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO system_agent_additions (id, agent_id, field_path, value, added_at, schema_version) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const r of bundle.systemAgentAdditions) {
        try { stmt.run(r.id, r.agent_id, r.field_path, r.value, r.added_at ?? new Date().toISOString(), r.schema_version ?? 1); additionsAdopted++; } catch {}
      }
    }
    if (Array.isArray(bundle.systemCronOverrides)) {
      const stmt = db.prepare(
        "INSERT INTO system_cron_overrides (cron_id, snooze_until, proactive_off, user_added_conditions, schema_version, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(cron_id) DO UPDATE SET snooze_until=excluded.snooze_until, proactive_off=excluded.proactive_off, user_added_conditions=excluded.user_added_conditions, updated_at=excluded.updated_at"
      );
      for (const r of bundle.systemCronOverrides) {
        try { stmt.run(r.cron_id, r.snooze_until, r.proactive_off ?? 0, r.user_added_conditions ?? "[]", r.schema_version ?? 1, r.updated_at ?? new Date().toISOString()); cronOverridesAdopted++; } catch {}
      }
    }

    res.json({
      imported,
      duplicate,
      rejected,
      chainValid: audit.firstBadSeq === null,
      audit,
      systemAgentOverrides: overridesAdopted,
      systemAgentAdditions: additionsAdopted,
      systemCronOverrides: cronOverridesAdopted,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "import failed" });
  }
});

export default router;
