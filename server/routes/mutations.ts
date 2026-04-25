/**
 * Mutation Proposals admin routes — L3 eval-as-gate for learners.
 *
 * GEPA / Evolution / Skills emit proposals; these routes let admin inspect
 * what's pending, manually accept/reject, see acceptance rate per source.
 * Distinct from /api/proposals which handles dev file-write approvals.
 */
import { Router } from "express";
import {
  listProposals, loadProposal, evaluateProposal, applyProposal, rejectProposal,
  sourceStats,
} from "../cognition/proposals.js";

const router = Router();

router.get("/", (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : undefined;
  const status = typeof req.query.status === "string" ? req.query.status as any : undefined;
  const limit = req.query.limit ? Math.min(200, parseInt(String(req.query.limit), 10)) : 50;
  res.json({ proposals: listProposals({ source, status, limit }) });
});

router.get("/:id", (req, res) => {
  const p = loadProposal(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

router.post("/:id/evaluate", async (req, res) => {
  try {
    const r = await evaluateProposal(req.params.id);
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "evaluate failed" });
  }
});

router.post("/:id/apply", async (req, res) => {
  const r = await applyProposal(req.params.id);
  res.json(r);
});

router.post("/:id/reject", (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual_reject";
  const ok = rejectProposal(req.params.id, reason);
  res.json({ ok });
});

router.get("/stats/:source", (req, res) => {
  const windowDays = req.query.windowDays ? parseInt(String(req.query.windowDays), 10) : 30;
  res.json(sourceStats(req.params.source, windowDays));
});

export default router;
