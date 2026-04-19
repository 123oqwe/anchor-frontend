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

// ── Skill templates (pre-built, one-click install) ──────────────────────────

const SKILL_TEMPLATES = [
  { name: "Investor Follow-up", description: "Structured follow-up with an investor contact", trigger_pattern: "follow up, investor, fundraising", steps: ["Search for recent context about this person", "Draft concise follow-up email", "Set 3-day reminder to check response"] },
  { name: "Weekly Review", description: "End-of-week reflection and priority reset", trigger_pattern: "weekly review, week summary, reflect", steps: ["List overdue tasks", "Check relationship health for top 5 people", "Identify 3 priorities for next week"] },
  { name: "Meeting Prep", description: "Prepare for an upcoming meeting", trigger_pattern: "prepare meeting, meeting prep, before meeting", steps: ["Review person's graph node and recent interactions", "Check relevant project status", "Draft 3 talking points"] },
  { name: "Decision Journal", description: "Record and analyze a decision you just made", trigger_pattern: "decision, decided, chose", steps: ["Record what you decided and why", "Note alternatives you rejected", "Set 7-day follow-up to evaluate outcome"] },
  { name: "Quick Outreach", description: "Send a brief message to reconnect with someone", trigger_pattern: "reach out, reconnect, check in", steps: ["Find person's contact info", "Draft short personal message", "Send via email or messaging"] },
];

router.get("/templates", (_req, res) => {
  res.json(SKILL_TEMPLATES);
});

router.post("/install-template", (req, res) => {
  const { templateIndex } = req.body;
  const template = SKILL_TEMPLATES[templateIndex];
  if (!template) return res.status(400).json({ error: "Invalid template index" });

  const existing = db.prepare("SELECT id FROM skills WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, template.name);
  if (existing) return res.json({ ok: true, message: "Already installed" });

  const id = nanoid();
  db.prepare("INSERT INTO skills (id, user_id, name, description, steps, trigger_pattern, source) VALUES (?,?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, template.name, template.description, JSON.stringify(template.steps), template.trigger_pattern, "template");
  res.json({ id, installed: true });
});

export default router;
