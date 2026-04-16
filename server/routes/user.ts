import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../db.js";
import { getStatus } from "../cortex/index.js";

const router = Router();

router.get("/profile", (_req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(DEFAULT_USER_ID);
  res.json(user);
});

router.put("/profile", (req, res) => {
  const { name, email, role } = req.body;
  db.prepare("UPDATE users SET name=?, email=?, role=? WHERE id=?").run(name, email, role, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.get("/state", (_req, res) => {
  const state = db.prepare("SELECT * FROM user_state WHERE user_id = ?").get(DEFAULT_USER_ID);
  res.json(state);
});

router.put("/state", (req, res) => {
  const { energy, focus, stress } = req.body;
  db.prepare("UPDATE user_state SET energy=?, focus=?, stress=?, updated_at=datetime('now') WHERE user_id=?")
    .run(energy, focus, stress, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.get("/settings", (_req, res) => {
  const s = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(DEFAULT_USER_ID);
  res.json(s);
});

router.put("/settings/:section", (req, res) => {
  const { section } = req.params;
  const body = req.body;

  const fieldMap: Record<string, string[]> = {
    profile: ["name", "email", "role"],
    appearance: ["theme"],
    privacy: ["local_processing", "data_retention", "share_analytics", "encrypt_memory"],
    notifications: ["notif_decisions", "notif_memories", "notif_twin", "notif_digest", "notif_email"],
    models: ["model_reasoning", "model_fast"],
  };

  const fields = fieldMap[section];
  if (!fields) return res.status(400).json({ error: "Unknown section" });

  if (section === "profile") {
    const filtered = Object.fromEntries(fields.filter(f => f in body).map(f => [f, body[f]]));
    if (filtered.name || filtered.email || filtered.role) {
      db.prepare(`UPDATE users SET ${Object.keys(filtered).map(f => `${f}=?`).join(",")} WHERE id=?`)
        .run(...Object.values(filtered), DEFAULT_USER_ID);
    }
    return res.json({ ok: true });
  }

  const filtered = Object.fromEntries(fields.filter(f => f in body).map(f => [f, body[f]]));
  if (Object.keys(filtered).length > 0) {
    db.prepare(`UPDATE settings SET ${Object.keys(filtered).map(f => `${f}=?`).join(",")} WHERE user_id=?`)
      .run(...Object.values(filtered), DEFAULT_USER_ID);
  }
  res.json({ ok: true });
});

router.get("/models", (_req, res) => {
  res.json(getStatus());
});

export default router;
