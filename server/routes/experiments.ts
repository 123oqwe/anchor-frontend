/**
 * L7 Transport — Prompt experiment CRUD + outcomes view (Sprint A — #7).
 *
 * Thin shell over orchestration/experiment-runner.ts. UI lives in admin.
 */
import { Router } from "express";
import { z } from "zod";
import {
  listExperiments, getExperiment,
  createExperiment, stopExperiment,
} from "../orchestration/experiment-runner.js";

const router = Router();

router.get("/", (_req, res) => {
  res.json(listExperiments());
});

router.get("/:id", (req, res) => {
  const e = getExperiment(req.params.id);
  if (!e) return res.status(404).json({ error: "experiment not found" });
  res.json(e);
});

const CreateBody = z.object({
  key: z.string().min(1),
  variantAValue: z.string().min(1),
  variantBValue: z.string().min(1),
  description: z.string().optional(),
  trafficSplit: z.number().min(0).max(1).optional(),
  successMetric: z.string().optional(),
});

router.post("/", (req, res) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const id = createExperiment(parsed.data);
  res.json({ id });
});

const StopBody = z.object({
  winner: z.enum(["a", "b"]).optional(),
});

router.post("/:id/stop", (req, res) => {
  const parsed = StopBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const ok = stopExperiment(req.params.id, parsed.data.winner);
  if (!ok) return res.status(404).json({ error: "experiment not found or already stopped" });
  res.json({ ok: true });
});

export default router;
