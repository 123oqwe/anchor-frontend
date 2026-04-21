/**
 * /api/hooks — CRUD for user-registered event hooks.
 */
import { Router } from "express";
import { listHooks, createHook, updateHook, deleteHook, type HookEvent } from "../orchestration/hooks.js";

const router = Router();

router.get("/", (_req, res) => {
  const rows = listHooks();
  res.json(rows.map((r: any) => ({
    ...r,
    matcher: safeParse(r.matcher),
    action_config: safeParse(r.action_config),
  })));
});

router.post("/", (req, res) => {
  const { name, event, matcher, actionType, actionConfig, enabled } = req.body ?? {};
  if (!event || typeof event !== "string") return res.status(400).json({ error: "event required" });
  if (!actionType || !["shell", "agent"].includes(actionType)) return res.status(400).json({ error: "actionType must be 'shell' or 'agent'" });
  if (!actionConfig || typeof actionConfig !== "object") return res.status(400).json({ error: "actionConfig required" });

  const id = createHook({
    name, event: event as HookEvent,
    matcher, actionType, actionConfig, enabled,
  });
  res.json({ id });
});

router.put("/:id", (req, res) => {
  try {
    updateHook(req.params.id, req.body ?? {});
    res.json({ ok: true });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

router.delete("/:id", (req, res) => {
  deleteHook(req.params.id);
  res.json({ ok: true });
});

function safeParse(s: any) { if (typeof s !== "string") return s ?? {}; try { return JSON.parse(s); } catch { return {}; } }

export default router;
