/**
 * User Cron routes — create, manage, toggle automations.
 * System can also recommend crons via proactive push.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

router.get("/", (_req, res) => {
  const crons = db.prepare("SELECT * FROM user_crons WHERE user_id=? ORDER BY created_at DESC").all(DEFAULT_USER_ID);
  res.json(crons);
});

router.post("/", (req, res) => {
  const { name, cron_pattern, action_type, action_config, source } = req.body;
  if (!name || !cron_pattern || !action_type) return res.status(400).json({ error: "name, cron_pattern, action_type required" });
  const id = nanoid();
  db.prepare("INSERT INTO user_crons (id, user_id, name, cron_pattern, action_type, action_config, source) VALUES (?,?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, name, cron_pattern, action_type, JSON.stringify(action_config ?? {}), source ?? "user");
  res.json({ id });
});

router.put("/:id", (req, res) => {
  const { name, cron_pattern, action_type, action_config } = req.body;
  db.prepare("UPDATE user_crons SET name=?, cron_pattern=?, action_type=?, action_config=? WHERE id=? AND user_id=?")
    .run(name, cron_pattern, action_type, JSON.stringify(action_config ?? {}), req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM user_crons WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.post("/:id/toggle", (req, res) => {
  db.prepare("UPDATE user_crons SET enabled = CASE WHEN enabled=1 THEN 0 ELSE 1 END WHERE id=? AND user_id=?")
    .run(req.params.id, DEFAULT_USER_ID);
  const cron = db.prepare("SELECT enabled FROM user_crons WHERE id=?").get(req.params.id) as any;
  res.json({ ok: true, enabled: !!cron?.enabled });
});

export default router;
