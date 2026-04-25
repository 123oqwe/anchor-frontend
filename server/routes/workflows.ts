/**
 * Workflow admin routes — inspect defs, list runs, trigger manually,
 * drill into a run's job-level trace.
 */
import { Router } from "express";
import {
  listWorkflowDefs, listWorkflowRuns, getWorkflowRun, runWorkflow,
} from "../orchestration/workflow.js";

const router = Router();

router.get("/defs", (_req, res) => {
  res.json({ workflows: listWorkflowDefs() });
});

router.get("/runs", (req, res) => {
  const workflowId = typeof req.query.workflowId === "string" ? req.query.workflowId : undefined;
  const status = typeof req.query.status === "string" ? req.query.status as any : undefined;
  const limit = req.query.limit ? Math.min(200, parseInt(String(req.query.limit), 10)) : 50;
  res.json({ runs: listWorkflowRuns({ workflowId, status, limit }) });
});

router.get("/runs/:runId", (req, res) => {
  const run = getWorkflowRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json(run);
});

router.post("/trigger/:id", async (req, res) => {
  try {
    const result = await runWorkflow(req.params.id, { triggerKind: "manual" });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "workflow trigger failed" });
  }
});

export default router;
