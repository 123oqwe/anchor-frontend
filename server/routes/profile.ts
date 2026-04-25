/**
 * Profile routes — InferredProfile inspection + staleness + manual refresh.
 *
 * Mounted at /api/profile. Designed so a frontend banner can ask
 *   GET /api/profile/staleness
 * once per page-load and render "Your Portrait is X days old, Y new people
 * — Refresh?" when isStale=true. Manual refresh runs the same workflow
 * that the daily cron does, with `force:true` in params to bypass the
 * threshold check.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { getLatestProfile, listProfileVersions } from "../cognition/profile-inference.js";
import { computeStaleness } from "../cognition/profile-staleness.js";

const router = Router();

router.get("/current", (_req, res) => {
  const p = getLatestProfile();
  if (!p) return res.status(404).json({ error: "no profile yet" });
  res.json(p);
});

router.get("/versions", (_req, res) => {
  res.json({ versions: listProfileVersions() });
});

router.get("/staleness", (_req, res) => {
  res.json(computeStaleness());
});

/**
 * Manual refresh — triggers the `profile_auto_refresh` workflow with
 * force=true so the staleness check short-circuits and inference
 * always runs. Returns runId immediately; client polls
 * /api/workflows/runs/:runId for completion.
 */
router.post("/refresh", async (_req, res) => {
  try {
    const { runWorkflow, registerHandler } = await import("../orchestration/workflow.js");
    const { inferProfile } = await import("../cognition/profile-inference.js");
    // Inline force-run: re-register a one-shot handler that bypasses the
    // staleness guard. Simpler than threading params through 2 jobs.
    registerHandler("profile.infer_force", async () => {
      const p = await inferProfile({ persist: true });
      return { refreshed: true, confidence: p.identity.confidence };
    });
    // Run as ad-hoc single-job workflow invoking force handler
    const { registerWorkflow } = await import("../orchestration/workflow.js");
    const wfId = `profile_manual_refresh_${Date.now()}`;
    try {
      registerWorkflow({
        id: wfId, description: "manual profile refresh",
        jobs: [{ id: "infer", handler: "profile.infer_force", timeoutMs: 300_000 }],
      });
    } catch {}
    const result = await runWorkflow(wfId, { triggerKind: "manual" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "refresh failed" });
  }
});

// Quick history: how has the profile changed over time?
router.get("/history", (_req, res) => {
  const rows = db.prepare(
    `SELECT version, data_json, created_at
     FROM inferred_profiles WHERE user_id=? ORDER BY version DESC LIMIT 10`
  ).all(DEFAULT_USER_ID) as any[];
  res.json({
    profiles: rows.map(r => {
      let p: any = null;
      try { p = JSON.parse(r.data_json); } catch {}
      return {
        version: r.version,
        createdAt: r.created_at,
        primaryRole: p?.identity?.primary_role ?? null,
        secondaryRoles: p?.identity?.secondary_roles ?? [],
        relationshipCount: p?.key_relationships?.length ?? 0,
        interestCount: p?.active_interests?.length ?? 0,
        tensionCount: p?.tensions?.length ?? 0,
      };
    }),
  });
});

export default router;
