/**
 * User Cron routes — create, manage, toggle automations.
 * System can also recommend crons via proactive push.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { parseCronConfig, CronConfigSchema } from "../cognition/agent-config.js";

const router = Router();

router.get("/", (_req, res) => {
  const crons = db.prepare("SELECT * FROM user_crons WHERE user_id=? ORDER BY created_at DESC").all(DEFAULT_USER_ID);
  // Expose parsed config so frontend can show purpose / vitality / snooze state.
  res.json(crons.map((c: any) => ({ ...c, config: parseCronConfig(c.config_json) })));
});

router.post("/", (req, res) => {
  const { name, cron_pattern, action_type, action_config, source, config } = req.body;
  if (!name || !cron_pattern || !action_type) return res.status(400).json({ error: "name, cron_pattern, action_type required" });

  // Optional structured config (purpose/voice/conditions/snooze/vitality)
  const parsed = CronConfigSchema.safeParse(config ?? {});
  if (config && !parsed.success) {
    return res.status(400).json({ error: "invalid config shape", details: parsed.error.message });
  }
  const finalConfig = parsed.success ? parsed.data : CronConfigSchema.parse({});
  if (!finalConfig.purpose) finalConfig.purpose = String(name);

  const id = nanoid();
  db.prepare(
    "INSERT INTO user_crons (id, user_id, name, cron_pattern, action_type, action_config, source, config_json) VALUES (?,?,?,?,?,?,?,?)"
  ).run(
    id, DEFAULT_USER_ID, name, cron_pattern, action_type,
    JSON.stringify(action_config ?? {}),
    source ?? "user",
    JSON.stringify(finalConfig),
  );
  res.json({ id });
});

router.put("/:id", (req, res) => {
  const { name, cron_pattern, action_type, action_config, config } = req.body;

  // Merge-style update — same pattern as user_agents PUT
  let configJsonForWrite: string | null = null;
  if (config !== undefined) {
    const existing = db.prepare("SELECT config_json FROM user_crons WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
    const current = parseCronConfig(existing?.config_json);
    const merged = { ...current, ...config };
    const parsed = CronConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid config shape", details: parsed.error.message });
    }
    configJsonForWrite = JSON.stringify(parsed.data);
  }

  if (configJsonForWrite !== null) {
    db.prepare("UPDATE user_crons SET name=?, cron_pattern=?, action_type=?, action_config=?, config_json=? WHERE id=? AND user_id=?")
      .run(name, cron_pattern, action_type, JSON.stringify(action_config ?? {}), configJsonForWrite, req.params.id, DEFAULT_USER_ID);
  } else {
    db.prepare("UPDATE user_crons SET name=?, cron_pattern=?, action_type=?, action_config=? WHERE id=? AND user_id=?")
      .run(name, cron_pattern, action_type, JSON.stringify(action_config ?? {}), req.params.id, DEFAULT_USER_ID);
  }
  res.json({ ok: true });
});

// Snooze a cron — pause until ISO timestamp (typically tomorrow / next week).
// Lives under the cron config rather than a flat column because conceptually
// "paused state" is part of the cron's lifecycle, alongside vitality.
router.post("/:id/snooze", (req, res) => {
  const { until } = req.body;  // ISO string; null/empty clears snooze
  const existing = db.prepare("SELECT config_json FROM user_crons WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!existing) return res.status(404).json({ error: "cron not found" });
  const current = parseCronConfig(existing.config_json);
  const updated = { ...current, snooze_until: until || null };
  db.prepare("UPDATE user_crons SET config_json=? WHERE id=? AND user_id=?")
    .run(JSON.stringify(updated), req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true, snooze_until: updated.snooze_until });
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
