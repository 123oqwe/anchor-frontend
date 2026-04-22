/**
 * /api/onboarding — Portrait generation + user answer capture.
 *
 * POST /portrait              — kick off full pipeline (profile + 5 oracles + compass)
 * GET  /portrait/latest       — return cached portrait JSON
 * POST /portrait/answer       — save user answer to an Oracle/Compass question
 */
import { Router } from "express";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { runOracleCouncil, getLatestPortrait } from "../cognition/oracle-council.js";

// Answers table — lightweight, one row per user answer
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portrait_answers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      portrait_version INTEGER,
      source TEXT NOT NULL,     -- 'historian' | 'compass' | etc.
      question TEXT NOT NULL,
      answer TEXT NOT NULL,     -- 'yes' | 'no' | 'partial' | free-text
      note TEXT,                -- optional correction / clarification
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch {}

const router = Router();

router.post("/portrait", async (_req, res) => {
  // Fire-and-forget: returns immediately, streams progress via PORTRAIT_PROGRESS
  // bus events. Client listens via existing WebSocket.
  runOracleCouncil({ stream: true, persist: true }).catch((err) => {
    console.error("[Onboarding] runOracleCouncil failed:", err.message);
  });
  res.json({ started: true });
});

router.get("/portrait/latest", (_req, res) => {
  const portrait = getLatestPortrait();
  if (!portrait) return res.status(404).json({ error: "No portrait generated yet" });
  res.json(portrait);
});

router.post("/portrait/answer", (req, res) => {
  const { source, question, answer, note } = req.body ?? {};
  if (!source || !question || !answer) return res.status(400).json({ error: "source, question, answer required" });
  const latest = db.prepare("SELECT version FROM portraits WHERE user_id=? ORDER BY version DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
  db.prepare(
    "INSERT INTO portrait_answers (id, user_id, portrait_version, source, question, answer, note) VALUES (?,?,?,?,?,?,?)"
  ).run(nanoid(), DEFAULT_USER_ID, latest?.version ?? null, source, question, answer, note ?? null);
  res.json({ ok: true });
});

router.get("/portrait/answers", (_req, res) => {
  const rows = db.prepare(
    "SELECT source, question, answer, note, created_at FROM portrait_answers WHERE user_id=? ORDER BY created_at DESC LIMIT 200"
  ).all(DEFAULT_USER_ID);
  res.json(rows);
});

export default router;
