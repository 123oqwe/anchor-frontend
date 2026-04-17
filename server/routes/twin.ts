import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

const router = Router();

const STAGES = [
  { level: 1, name: "Observer",   xpRequired: 100,  description: "Reads your behavior, builds a baseline understanding of your patterns and priorities.", rewards: ["Human Graph access", "Weekly behavioral summary", "Pattern detection"] },
  { level: 2, name: "Advisor",    xpRequired: 300,  description: "Suggests actions, generates draft plans, and surfaces what you're avoiding.", rewards: ["Draft generation", "Avoidance detection", "Priority surfacing"] },
  { level: 3, name: "Executor",   xpRequired: 600,  description: "Acts on your behalf with approval — sends emails, creates tasks, manages calendar.", rewards: ["Email drafting", "Task automation", "Approval workflow"] },
  { level: 4, name: "Autonomous", xpRequired: 1000, description: "Acts independently within defined boundaries. Full digital twin capability.", rewards: ["Autonomous execution", "Proactive suggestions", "Cross-system coordination"] },
];

router.get("/evolution", (_req, res) => {
  const evo = db.prepare("SELECT * FROM twin_evolution WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  const quests = db.prepare("SELECT * FROM twin_quests WHERE user_id=?").all(DEFAULT_USER_ID) as any[];

  const currentLevel = evo?.level ?? 1;
  const currentXP = evo?.xp ?? 0;

  const stages = STAGES.map(s => ({
    ...s,
    xpCurrent: s.level === currentLevel ? currentXP : s.level < currentLevel ? s.xpRequired : 0,
    unlocked: s.level <= currentLevel,
    quests: s.level === currentLevel ? quests.filter(q => !q.completed) : [],
  }));

  res.json({ currentLevel, currentXP, stages });
});

router.get("/insights", (_req, res) => {
  const insights = db.prepare("SELECT * FROM twin_insights WHERE user_id=? ORDER BY confidence DESC").all(DEFAULT_USER_ID);
  res.json(insights);
});

router.post("/quests/:id/complete", (req, res) => {
  const quest = db.prepare("SELECT * FROM twin_quests WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!quest || quest.completed) return res.status(400).json({ error: "Invalid quest" });

  db.transaction(() => {
    db.prepare("UPDATE twin_quests SET completed=1 WHERE id=?").run(req.params.id);
    db.prepare("UPDATE twin_evolution SET xp=xp+?, updated_at=datetime('now') WHERE user_id=?").run(quest.xp_reward, DEFAULT_USER_ID);
    // Level up check
    const evo = db.prepare("SELECT * FROM twin_evolution WHERE user_id=?").get(DEFAULT_USER_ID) as any;
    const nextStage = STAGES.find(s => s.level === evo.level + 1);
    if (nextStage && evo.xp >= nextStage.xpRequired) {
      db.prepare("UPDATE twin_evolution SET level=level+1, updated_at=datetime('now') WHERE user_id=?").run(DEFAULT_USER_ID);
    }
  })();

  res.json({ ok: true });
});

router.post("/xp", (req, res) => {
  const { amount } = req.body;
  if (!amount || typeof amount !== "number" || amount <= 0 || amount > 100) return res.status(400).json({ error: "amount must be 1-100" });

  db.transaction(() => {
    db.prepare("UPDATE twin_evolution SET xp=xp+?, updated_at=datetime('now') WHERE user_id=?").run(amount, DEFAULT_USER_ID);
    const evo = db.prepare("SELECT * FROM twin_evolution WHERE user_id=?").get(DEFAULT_USER_ID) as any;
    const nextStage = STAGES.find(s => s.level === evo.level + 1);
    if (nextStage && evo.xp >= nextStage.xpRequired) {
      db.prepare("UPDATE twin_evolution SET level=level+1, updated_at=datetime('now') WHERE user_id=?").run(DEFAULT_USER_ID);
    }
  })();

  res.json({ ok: true });
});

export default router;
