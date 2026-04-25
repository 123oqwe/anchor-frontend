/**
 * Long-horizon project state — persistent context across sessions.
 *
 * Implements Anthropic's "effective harness" pattern for agents working on
 * tasks that span days/weeks. Each project has a JSON state blob:
 *   { goal, milestones, notes, context, next_check_in }
 * Agents read it before acting, write back after. Works even across model
 * swaps or conversation compactions.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

interface ProjectState {
  goal?: string;
  milestones?: { name: string; status: string; notes?: string; doneAt?: string }[];
  notes?: string;
  context?: string;
  nextCheckIn?: string;
  lastUpdatedBy?: string;
  [key: string]: any;
}

router.get("/", (_req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, name, goal, state_json, status, next_check_in, created_at, updated_at
       FROM project_state WHERE user_id=? ORDER BY updated_at DESC`
    ).all(DEFAULT_USER_ID) as any[];
    res.json(rows.map(r => ({
      id: r.id, name: r.name, goal: r.goal, status: r.status,
      nextCheckIn: r.next_check_in,
      state: safeParse(r.state_json),
      createdAt: r.created_at, updatedAt: r.updated_at,
    })));
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.get("/:id", (req, res) => {
  try {
    const row = db.prepare(
      `SELECT id, name, goal, state_json, status, next_check_in, created_at, updated_at
       FROM project_state WHERE id=? AND user_id=?`
    ).get(req.params.id, DEFAULT_USER_ID) as any;
    if (!row) return res.status(404).json({ error: "not found" });
    res.json({
      id: row.id, name: row.name, goal: row.goal, status: row.status,
      nextCheckIn: row.next_check_in,
      state: safeParse(row.state_json),
      createdAt: row.created_at, updatedAt: row.updated_at,
    });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.post("/", (req, res) => {
  try {
    const { name, goal, state, nextCheckIn } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "name required" });
    const id = nanoid();
    db.prepare(
      `INSERT INTO project_state (id, user_id, name, goal, state_json, next_check_in)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, DEFAULT_USER_ID, name, goal ?? "", JSON.stringify(state ?? {}), nextCheckIn ?? null);
    res.json({ id });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.put("/:id/state", (req, res) => {
  try {
    const { state, merge } = req.body ?? {};
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "state object required" });
    }
    let finalState: ProjectState = state;
    if (merge) {
      const row = db.prepare(
        "SELECT state_json FROM project_state WHERE id=? AND user_id=?"
      ).get(req.params.id, DEFAULT_USER_ID) as any;
      if (!row) return res.status(404).json({ error: "not found" });
      finalState = { ...safeParse(row.state_json), ...state };
    }
    const result = db.prepare(
      `UPDATE project_state SET state_json=?, updated_at=datetime('now')
       WHERE id=? AND user_id=?`
    ).run(JSON.stringify(finalState), req.params.id, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, state: finalState });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.put("/:id", (req, res) => {
  try {
    const { status, nextCheckIn, goal } = req.body ?? {};
    const sets: string[] = [];
    const params: any[] = [];
    if (status !== undefined) { sets.push("status=?"); params.push(status); }
    if (nextCheckIn !== undefined) { sets.push("next_check_in=?"); params.push(nextCheckIn); }
    if (goal !== undefined) { sets.push("goal=?"); params.push(goal); }
    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });
    sets.push("updated_at=datetime('now')");
    params.push(req.params.id, DEFAULT_USER_ID);
    const result = db.prepare(
      `UPDATE project_state SET ${sets.join(", ")} WHERE id=? AND user_id=?`
    ).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

function safeParse(s: string): ProjectState {
  try { return JSON.parse(s); } catch { return {}; }
}

export default router;
