/**
 * /api/jobs — Task Brain ledger routes.
 *
 * List, inspect, cancel, retry, and manually enqueue agent jobs.
 */
import { Router } from "express";
import {
  enqueueJob, listJobs, getJob, cancelJob, retryJob,
  type JobSource, type JobState,
} from "../orchestration/task-brain.js";

const router = Router();

router.get("/", (req, res) => {
  const stateParam = req.query.state as string | undefined;
  const sourceParam = req.query.source as string | undefined;
  const limit = Number(req.query.limit) || 50;

  const state = stateParam ? stateParam.split(",") as JobState[] : undefined;
  const rows = listJobs({
    state: state as any,
    source: (sourceParam as JobSource) || undefined,
    limit,
  });
  res.json(rows.map(r => ({
    ...r,
    action_config: safeParse(r.action_config),
  })));
});

router.get("/:id", (req, res) => {
  const row = getJob(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ ...row, action_config: safeParse(row.action_config) });
});

router.post("/:id/cancel", (req, res) => {
  const ok = cancelJob(req.params.id);
  if (!ok) return res.status(409).json({ error: "Job not in cancellable state" });
  res.json({ ok: true });
});

router.post("/:id/retry", (req, res) => {
  const ok = retryJob(req.params.id);
  if (!ok) return res.status(409).json({ error: "Job not in retryable state (must be failed/cancelled)" });
  res.json({ ok: true });
});

/** Manual enqueue — handy for UI "Run now" or testing. */
router.post("/", (req, res) => {
  const { source, sourceId, actionType, actionConfig, name, delayMs, maxAttempts } = req.body ?? {};
  if (!actionType || typeof actionType !== "string") return res.status(400).json({ error: "actionType required" });
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });

  const id = enqueueJob({
    source: (source as JobSource) || "manual",
    sourceId,
    actionType,
    actionConfig: actionConfig ?? {},
    name,
    delayMs: typeof delayMs === "number" ? delayMs : undefined,
    maxAttempts: typeof maxAttempts === "number" ? maxAttempts : undefined,
  });
  res.json({ id });
});

function safeParse(s: string | null) { if (!s) return {}; try { return JSON.parse(s); } catch { return {}; } }

export default router;
