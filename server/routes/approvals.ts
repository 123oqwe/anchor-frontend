/**
 * L7 Transport — Unified approval inbox (Sprint B — #4).
 *
 * Thin shell over permission/approval-queue.ts. Source modules subscribe to
 * APPROVAL_DECIDED events to reconcile their own state.
 */
import { Router } from "express";
import { z } from "zod";
import {
  enqueueApproval, decideApproval, getApproval,
  listApprovals, inboxStats, expireStaleApprovals,
  type ApprovalSource,
} from "../permission/approval-queue.js";

const router = Router();

router.get("/", (req, res) => {
  const status = (req.query.status as string | undefined) ?? "pending";
  const source = req.query.source as ApprovalSource | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
  res.json(listApprovals({
    status: status === "all" ? undefined : (status.split(",") as any),
    source,
    limit,
  }));
});

router.get("/stats", (_req, res) => {
  res.json(inboxStats());
});

router.get("/:id", (req, res) => {
  const a = getApproval(req.params.id);
  if (!a) return res.status(404).json({ error: "approval not found" });
  res.json(a);
});

const DecisionBody = z.object({
  approve: z.boolean(),
  reason: z.string().max(500).optional(),
});

router.post("/:id/decide", (req, res) => {
  const parsed = DecisionBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const r = decideApproval({ id: req.params.id, ...parsed.data, decidedBy: "user" });
  if (!r.ok) {
    if (r.reason === "informational") {
      return res.status(409).json({ error: "this row is informational (audit-only); the original caller has already decided synchronously" });
    }
    if (r.reason === "already_decided") return res.status(409).json({ error: "approval already decided" });
    return res.status(404).json({ error: "approval not found" });
  }
  res.json({ ok: true, row: r.row });
});

const EnqueueBody = z.object({
  source: z.enum(["gate", "app", "proposal", "run", "step"]),
  sourceRefId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
  expiresInSeconds: z.number().int().positive().optional(),
});

// Manual enqueue endpoint — primarily for tests + future external producers.
router.post("/", (req, res) => {
  const parsed = EnqueueBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const id = enqueueApproval(parsed.data);
  res.json({ id });
});

router.post("/expire", (_req, res) => {
  res.json({ expired: expireStaleApprovals() });
});

export default router;
