/**
 * Routes mounting the 4 Killer Queries at /api/killer.
 *
 * Intentionally a thin pass-through — all logic lives in the cognition
 * module. These are read-only endpoints; no mutation, safe to expose
 * without auth gates in the single-user Anchor deployment.
 */
import { Router } from "express";
import {
  coolingWarmingNetwork,
  topActualContacts,
  attentionShift,
  commitmentsVsExecution,
  runAllKillerQueries,
} from "../cognition/killer-queries.js";

const router = Router();

router.get("/cooling-warming", (req, res) => {
  try {
    const coolingThreshold = req.query.coolingThreshold ? Number(req.query.coolingThreshold) : undefined;
    const warmingThreshold = req.query.warmingThreshold ? Number(req.query.warmingThreshold) : undefined;
    res.json(coolingWarmingNetwork({ coolingThreshold, warmingThreshold }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.get("/top-contacts", (req, res) => {
  try {
    const windowDays = req.query.windowDays ? Number(req.query.windowDays) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(topActualContacts({ windowDays, limit }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.get("/attention-shift", (req, res) => {
  try {
    const months = req.query.months ? Number(req.query.months) : undefined;
    res.json(attentionShift({ months }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.get("/commitment-drift", (req, res) => {
  try {
    const staleDays = req.query.staleDays ? Number(req.query.staleDays) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(commitmentsVsExecution({ staleDays, limit }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.get("/all", (_req, res) => {
  try {
    res.json(runAllKillerQueries());
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

export default router;
