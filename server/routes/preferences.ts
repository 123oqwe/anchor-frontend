/**
 * L7 Surface — User Preferences API.
 * Lets users customize: cron schedule, tags, state dimensions.
 * Principle: user is the owner, not the guest.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

// Ensure preferences table exists
try {
  db.exec(`CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);
} catch {}

function getPref(key: string, defaultVal: string): string {
  const row = db.prepare("SELECT value FROM user_preferences WHERE user_id=? AND key=?").get(DEFAULT_USER_ID, key) as any;
  return row?.value ?? defaultVal;
}

function setPref(key: string, value: string): void {
  db.prepare(
    "INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value"
  ).run(DEFAULT_USER_ID, key, value);
}

// ── Get all preferences ─────────────────────────────────────────────────────

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM user_preferences WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
  const prefs: Record<string, string> = {};
  for (const r of rows) prefs[r.key] = r.value;

  // Return with defaults for anything not set
  res.json({
    digest_time: prefs.digest_time ?? "08:00",
    reflection_day: prefs.reflection_day ?? "monday",
    custom_tags: prefs.custom_tags ? JSON.parse(prefs.custom_tags) : [],
    custom_state_dimensions: prefs.custom_state_dimensions ? JSON.parse(prefs.custom_state_dimensions) : [],
    timezone: prefs.timezone ?? "UTC",
  });
});

// ── Set a preference ────────────────────────────────────────────────────────

router.put("/", (req, res) => {
  const allowed = ["digest_time", "reflection_day", "custom_tags", "custom_state_dimensions", "timezone"];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      const val = typeof value === "string" ? value : JSON.stringify(value);
      setPref(key, val);
    }
  }
  res.json({ ok: true });
});

// ── Custom tags ─────────────────────────────────────────────────────────────

router.post("/tags", (req, res) => {
  const { tag, keywords } = req.body;
  if (!tag) return res.status(400).json({ error: "tag required" });
  const current = JSON.parse(getPref("custom_tags", "[]"));
  current.push({ tag, keywords: keywords ?? [] });
  setPref("custom_tags", JSON.stringify(current));
  res.json({ ok: true, tags: current });
});

router.delete("/tags/:tag", (req, res) => {
  const current = JSON.parse(getPref("custom_tags", "[]"));
  const filtered = current.filter((t: any) => t.tag !== req.params.tag);
  setPref("custom_tags", JSON.stringify(filtered));
  res.json({ ok: true, tags: filtered });
});

// ── Custom state dimensions ─────────────────────────────────────────────────

router.post("/state-dimensions", (req, res) => {
  const { name, default_value } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const current = JSON.parse(getPref("custom_state_dimensions", "[]"));
  current.push({ name, default_value: default_value ?? 50 });
  setPref("custom_state_dimensions", JSON.stringify(current));
  res.json({ ok: true, dimensions: current });
});

export default router;
