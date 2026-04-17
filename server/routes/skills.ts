/**
 * L7 Surface — Skills API.
 * Users can create, view, edit, and delete their own skills.
 * Skills are reusable action patterns that the Execution Agent can invoke.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

// List all skills
router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM skills WHERE user_id=? ORDER BY use_count DESC, created_at DESC").all(DEFAULT_USER_ID);
  res.json(rows.map((r: any) => ({ ...r, steps: JSON.parse(r.steps) })));
});

// Get one skill
router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM skills WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ ...row, steps: JSON.parse(row.steps) });
});

// Create skill
router.post("/", (req, res) => {
  const { name, description, steps, trigger_pattern } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const id = nanoid();
  db.prepare(
    "INSERT INTO skills (id, user_id, name, description, steps, trigger_pattern) VALUES (?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, name, description ?? "", JSON.stringify(steps ?? []), trigger_pattern ?? "");
  res.json({ id });
});

// Update skill
router.put("/:id", (req, res) => {
  const { name, description, steps, trigger_pattern } = req.body;
  db.prepare(
    "UPDATE skills SET name=?, description=?, steps=?, trigger_pattern=?, updated_at=datetime('now') WHERE id=? AND user_id=?"
  ).run(name, description, JSON.stringify(steps ?? []), trigger_pattern ?? "", req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// Delete skill
router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM skills WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

export default router;
