import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../db.js";
import { nanoid } from "nanoid";

const router = Router();

router.get("/status", (_req, res) => {
  const agents = ["Decision Agent", "Observation Agent", "Memory Agent", "Twin Agent", "Execution Agent", "Workspace Agent"];
  const result = agents.map(name => {
    const rows = db.prepare("SELECT status FROM agent_executions WHERE user_id=? AND agent=?").all(DEFAULT_USER_ID, name) as any[];
    const successes = rows.filter(r => r.status === "success").length;
    const failures = rows.filter(r => r.status === "failed").length;
    return { name, successes, failures };
  });
  res.json(result);
});

router.get("/executions", (_req, res) => {
  const rows = db.prepare("SELECT * FROM agent_executions WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(DEFAULT_USER_ID);
  res.json(rows);
});

router.post("/executions", (req, res) => {
  const { agent, action, status } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, agent, action, status ?? "success");
  res.json({ id });
});

export default router;
