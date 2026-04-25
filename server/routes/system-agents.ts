/**
 * Routes: GET / PUT / POST / DELETE on system agents (Phase 2, Mode C).
 *
 * Mounted at /api/system. Endpoints:
 *   GET    /agents                       list all system agents (with composed config + lockMap)
 *   GET    /agents/:id                   single agent
 *   PUT    /agents/:id/overrides         body: { path, value }   set USER field
 *   DELETE /agents/:id/overrides         body: { path }          reset to default
 *   POST   /agents/:id/additions         body: { path, value }   append to ADD_ONLY field
 *   DELETE /agents/:id/additions/:additionId
 *   POST   /cron/:id/snooze              body: { until: ISO|null }
 *   GET    /agents/:id/vitality          computed view from agent_executions
 *
 * SCOPE: this is the ONLY user-facing surface for system-agent
 * customization. LOCKED fields are guarded server-side — UI cannot bypass.
 */

import { Router } from "express";
import { db } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import {
  composeSystemAgentConfig,
  extractLockMap,
  getLockStateAtPath,
} from "../cognition/agent-spec.js";
import {
  listSystemAgentSpecs,
  getSystemAgentSpec,
  listSystemCronSpecs,
  getSystemCronSpec,
} from "../cognition/system-agents/registry.js";

const router = Router();

// ── GET /agents — list all system agents ───────────────────────────────────
router.get("/agents", (_req, res) => {
  const specs = listSystemAgentSpecs();
  res.json(specs.map(spec => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    schemaVersion: spec.schemaVersion,
    composed: composeSystemAgentConfig(spec),
    lockMap: extractLockMap(spec),
    documentary_only: spec.documentary_only ?? false,
  })));
});

// ── GET /agents/:id ────────────────────────────────────────────────────────
router.get("/agents/:id", (req, res) => {
  const spec = getSystemAgentSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: "system agent not found" });
  res.json({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    schemaVersion: spec.schemaVersion,
    composed: composeSystemAgentConfig(spec),
    lockMap: extractLockMap(spec),
    documentary_only: spec.documentary_only ?? false,
  });
});

// ── PUT /agents/:id/overrides — set USER field ─────────────────────────────
router.put("/agents/:id/overrides", (req, res) => {
  const { path, value } = req.body;
  if (!path || value === undefined) {
    return res.status(400).json({ error: "body must include { path, value }" });
  }
  const spec = getSystemAgentSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: "agent not found" });

  // Server-side guard: only USER fields are overridable. LOCKED / AUTO /
  // ADD_ONLY all rejected with 403 + the actual lock state for clarity.
  const lockState = getLockStateAtPath(spec, path);
  if (lockState !== "user") {
    return res.status(403).json({
      error: lockState
        ? `field "${path}" is ${lockState}, not user-editable`
        : `field "${path}" not found in spec`,
    });
  }

  db.prepare(
    "INSERT INTO system_agent_overrides (agent_id, field_path, value, schema_version) " +
    "VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(agent_id, field_path) DO UPDATE SET value=excluded.value, set_at=datetime('now')"
  ).run(spec.id, path, JSON.stringify(value), spec.schemaVersion);
  res.json({ ok: true });
});

// ── DELETE /agents/:id/overrides — reset USER field to spec default ────────
// Path goes in body to avoid Express 4 wildcard / dot-segment quirks.
router.delete("/agents/:id/overrides", (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: "body must include { path }" });
  db.prepare("DELETE FROM system_agent_overrides WHERE agent_id=? AND field_path=?")
    .run(req.params.id, path);
  res.json({ ok: true });
});

// ── POST /agents/:id/additions — append to ADD_ONLY field ──────────────────
router.post("/agents/:id/additions", (req, res) => {
  const { path, value } = req.body;
  if (!path || value === undefined) {
    return res.status(400).json({ error: "body must include { path, value }" });
  }
  const spec = getSystemAgentSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: "agent not found" });

  const lockState = getLockStateAtPath(spec, path);
  if (lockState !== "add_only") {
    return res.status(403).json({
      error: lockState
        ? `field "${path}" is ${lockState}, not add-only`
        : `field "${path}" not found in spec`,
    });
  }

  const id = nanoid();
  db.prepare(
    "INSERT INTO system_agent_additions (id, agent_id, field_path, value, schema_version) VALUES (?, ?, ?, ?, ?)"
  ).run(id, spec.id, path, JSON.stringify(value), spec.schemaVersion);
  res.json({ id });
});

// ── DELETE /agents/:id/additions/:additionId — remove a user-added item ─
router.delete("/agents/:id/additions/:additionId", (req, res) => {
  db.prepare("DELETE FROM system_agent_additions WHERE id=? AND agent_id=?")
    .run(req.params.additionId, req.params.id);
  res.json({ ok: true });
});

// ── POST /cron/:id/snooze — pause cron until ISO date (or null to clear) ─
router.post("/cron/:id/snooze", (req, res) => {
  const { until } = req.body ?? {};
  // Validate cron exists in registry — prevents typos / unauthorized IDs
  if (!getSystemCronSpec(req.params.id)) {
    return res.status(404).json({ error: "system cron not found" });
  }
  db.prepare(
    "INSERT INTO system_cron_overrides (cron_id, snooze_until, schema_version) VALUES (?, ?, 1) " +
    "ON CONFLICT(cron_id) DO UPDATE SET snooze_until=excluded.snooze_until, updated_at=datetime('now')"
  ).run(req.params.id, until || null);
  res.json({ ok: true, snooze_until: until || null });
});

// ── GET /agents/:id/vitality — computed view from agent_executions ─────────
// Query by spec.name (e.g., "Twin Agent") because that's how
// agent_executions records the agent label, not by the spec.id ("twin").
router.get("/agents/:id/vitality", (req, res) => {
  const spec = getSystemAgentSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: "agent not found" });

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failure_count,
      MAX(created_at) AS last_run_at
    FROM agent_executions
    WHERE agent = ?
  `).get(spec.name) as any;
  res.json(stats ?? { total_runs: 0, success_count: 0, failure_count: 0, last_run_at: null });
});

// ── GET /crons — list all system crons ─────────────────────────────────────
router.get("/crons", (_req, res) => {
  const specs = listSystemCronSpecs();
  res.json(specs.map(spec => {
    const override = db.prepare(
      "SELECT snooze_until, proactive_off FROM system_cron_overrides WHERE cron_id=?"
    ).get(spec.id) as any;
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      cron_pattern: spec.cron_pattern.default,
      purpose: spec.purpose.default,
      snooze_until: override?.snooze_until ?? null,
      proactive_off: !!override?.proactive_off,
    };
  }));
});

export default router;
