/**
 * Bridge routes — introspection + preferences UI backend.
 *
 * GET  /api/bridges/capabilities         catalog of capabilities
 * GET  /api/bridges/providers            providers + live health status
 * GET  /api/bridges/attempts?runId=x     provider attempt timeline for a run
 * GET  /api/bridges/preferences          user provider-order map
 * POST /api/bridges/preferences          { capability, order, disabled? }
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import {
  getCapabilities, getProviders, getProvidersFor,
  setProviderOrder, setProviderDisabled,
} from "../bridges/registry.js";
import { cachedHealthCheck } from "../bridges/health.js";
import { getAttemptsForRun, getProviderHealthHistory } from "../bridges/telemetry.js";

const router = Router();

router.get("/capabilities", (_req, res) => {
  const caps = getCapabilities().map(c => ({
    name: c.name,
    description: c.description,
    actionClass: c.actionClass,
    inputSchema: c.inputSchema,
    providers: getProvidersFor(c.name).map(p => ({
      id: p.id, kind: p.kind, displayName: p.displayName,
      platforms: p.platforms, requires: p.requires,
    })),
  }));
  res.json(caps);
});

router.get("/providers", async (_req, res) => {
  const out = await Promise.all(getProviders().map(async p => {
    const health = await cachedHealthCheck(p);
    const history = getProviderHealthHistory(p.id, 24) as any[];
    const stats: Record<string, number> = {};
    for (const row of history) stats[row.status] = row.n;
    return {
      id: p.id,
      kind: p.kind,
      capability: p.capability,
      displayName: p.displayName,
      platforms: p.platforms,
      requires: p.requires,
      concurrency: p.concurrency,
      rateLimit: p.rateLimit,
      lifecycle: p.lifecycle,
      health,
      attemptStats24h: stats,
    };
  }));
  res.json(out);
});

router.get("/attempts", (req, res) => {
  const runId = req.query.runId as string | undefined;
  if (runId) {
    res.json(getAttemptsForRun(runId));
    return;
  }
  const rows = db.prepare(
    `SELECT * FROM provider_attempts WHERE user_id=?
     ORDER BY created_at DESC LIMIT 100`
  ).all(DEFAULT_USER_ID);
  res.json(rows);
});

router.get("/preferences", (_req, res) => {
  const rows = db.prepare(
    "SELECT capability, provider_order, disabled_providers FROM capability_preferences WHERE user_id=?"
  ).all(DEFAULT_USER_ID) as any[];
  const out: Record<string, { order: string[]; disabled: string[] }> = {};
  for (const r of rows) {
    try {
      out[r.capability] = {
        order: JSON.parse(r.provider_order ?? "[]"),
        disabled: JSON.parse(r.disabled_providers ?? "[]"),
      };
    } catch {
      out[r.capability] = { order: [], disabled: [] };
    }
  }
  res.json(out);
});

router.post("/preferences", (req, res) => {
  const { capability, order, disabled } = req.body ?? {};
  if (typeof capability !== "string" || !Array.isArray(order)) {
    return res.status(400).json({ error: "capability (string) and order (array) required" });
  }
  setProviderOrder(capability, order.filter(s => typeof s === "string"));
  if (Array.isArray(disabled)) {
    setProviderDisabled(capability, disabled.filter(s => typeof s === "string"));
  }
  res.json({ ok: true });
});

export default router;
