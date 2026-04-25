import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

router.get("/", (req, res) => {
  const { type, q } = req.query as Record<string, string>;
  let sql = "SELECT * FROM memories WHERE user_id = ?";
  const params: any[] = [DEFAULT_USER_ID];
  if (type && type !== "all") { sql += " AND type = ?"; params.push(type); }
  if (q) { sql += " AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)"; const like = `%${q}%`; params.push(like, like, like); }
  sql += " ORDER BY created_at DESC";
  const rows = (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r, tags: JSON.parse(r.tags) }));
  res.json(rows);
});

router.get("/stats", (_req, res) => {
  const rows = db.prepare("SELECT type, COUNT(*) as count FROM memories WHERE user_id = ? GROUP BY type").all(DEFAULT_USER_ID) as any[];
  const stats: Record<string, number> = { episodic: 0, semantic: 0, working: 0 };
  for (const r of rows) stats[r.type] = r.count;
  res.json(stats);
});

router.post("/", (req, res) => {
  const { type, title, content, tags, source, confidence } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, type, title, content, JSON.stringify(tags ?? []), source ?? "", confidence ?? 0.8);
  res.json({ id });
});

router.put("/:id", (req, res) => {
  const { type, title, content, tags, source, confidence } = req.body;
  db.prepare("UPDATE memories SET type=?, title=?, content=?, tags=?, source=?, confidence=? WHERE id=? AND user_id=?")
    .run(type, title, content, JSON.stringify(tags ?? []), source, confidence, req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// ── Memory arbitration queue (Phase C) ─────────────────────────────────
router.get("/arbitrations", async (_req, res) => {
  const { listOpenArbitrations } = await import("../memory/lifecycle.js");
  res.json({ arbitrations: listOpenArbitrations(50) });
});

router.post("/arbitrations/:id/resolve", async (req, res) => {
  const { resolveArbitration } = await import("../memory/lifecycle.js");
  const resolution = req.body?.resolution;
  if (!["keep_left", "keep_right", "keep_both", "custom"].includes(resolution)) {
    return res.status(400).json({ error: "resolution must be keep_left|keep_right|keep_both|custom" });
  }
  const ok = resolveArbitration(req.params.id, resolution, {
    customMemory: req.body?.customMemory,
    note: req.body?.note,
  });
  if (!ok) return res.status(404).json({ error: "arbitration not found or already resolved" });
  res.json({ ok: true });
});

export default router;
