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

// Natural language automation creation
router.post("/from-description", async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: "description required" });

  try {
    const { text: llmText } = await import("../infra/compute/index.js");
    const result = await llmText({
      task: "twin_edit_learning",
      system: `Convert a natural language description into a cron job config.
Respond ONLY with JSON:
{
  "name": "Short name",
  "cron_pattern": "valid cron expression",
  "human_schedule": "e.g. Every Monday at 9am",
  "action_type": "remind",
  "action_config": { "message": "what to remind" }
}

Common patterns: "0 9 * * *" (daily 9am), "0 9 * * 1" (Monday 9am), "0 18 * * 5" (Friday 6pm), "0 */2 * * *" (every 2h)`,
      messages: [{ role: "user", content: description }],
      maxTokens: 200,
    });

    const stripped = result.replace(/```json\s*/g, "").replace(/```/g, "");
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    if (!parsed.name || !parsed.cron_pattern) {
      return res.status(400).json({ error: "Could not parse automation config" });
    }

    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
