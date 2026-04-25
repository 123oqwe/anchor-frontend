/**
 * Feedback API — UI posts explicit / edit-distance feedback here,
 * admin/analytics queries aggregates.
 *
 * Mount at /api/feedback.
 */
import { Router } from "express";
import {
  recordFeedback, recordEditDistance, recordThumbs,
  aggregateForAgent, listRecentFeedback,
  detectRePrompts, detectAbandonment,
  type FeedbackKind,
} from "../cognition/feedback.js";

const router = Router();

router.post("/edit", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.runId !== "string" || typeof b.original !== "string" || typeof b.modified !== "string") {
    return res.status(400).json({ error: "runId, original, modified required" });
  }
  const id = recordEditDistance({
    runId: b.runId, agentId: b.agentId,
    original: b.original, modified: b.modified,
  });
  res.json({ ok: true, id });
});

router.post("/thumbs", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.up !== "boolean") return res.status(400).json({ error: "up (bool) required" });
  const id = recordThumbs({
    up: b.up, runId: b.runId, agentId: b.agentId,
    subjectType: b.subjectType, subjectId: b.subjectId,
  });
  res.json({ ok: true, id });
});

router.post("/regeneration", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.runId !== "string") return res.status(400).json({ error: "runId required" });
  const id = recordFeedback({
    kind: "regeneration",
    subjectType: "agent_output",
    subjectId: b.runId,
    agentId: b.agentId,
    runId: b.runId,
    source: "ui",
  });
  res.json({ ok: true, id });
});

router.get("/recent", (req, res) => {
  const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
  const kind = typeof req.query.kind === "string" ? req.query.kind as FeedbackKind : undefined;
  const limit = req.query.limit ? Math.min(500, parseInt(String(req.query.limit), 10)) : 100;
  res.json({ events: listRecentFeedback({ agentId, kind, limit }) });
});

router.get("/agent/:agentId/summary", (req, res) => {
  const windowDays = req.query.windowDays ? parseInt(String(req.query.windowDays), 10) : 30;
  res.json(aggregateForAgent(req.params.agentId, windowDays));
});

// Manual trigger for the detectors (usually run by cron, exposed for debugging)
router.post("/detect/re_prompts", (req, res) => {
  const count = detectRePrompts(req.body ?? {});
  res.json({ detected: count });
});

router.post("/detect/abandonment", (req, res) => {
  const count = detectAbandonment(req.body ?? {});
  res.json({ detected: count });
});

export default router;
