/**
 * Dev Proposal routes — human-in-loop approval for agent-proposed file writes.
 *
 * Flow:
 *   1. Agent calls diff_file(path, content) → row inserted with status='pending'
 *      bus.publish(PROPOSAL_PENDING) → WebSocket → UI dialog
 *   2. User reviews diff in Settings → Proposals
 *   3. User POSTs /approve → this route actually writes to disk
 *      or POSTs /reject → status set to rejected, no write
 *   4. approve_and_write tool from the agent side is read-only status check
 */
import { Router } from "express";
import fs from "fs";
import path from "path";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";

const router = Router();

// List pending + recent reviewed proposals
router.get("/", (_req, res) => {
  const rows = db.prepare(
    `SELECT id, kind, path, agent_name, status, created_at, reviewed_at, write_result,
            length(after_content) as after_bytes, length(coalesce(before_content,'')) as before_bytes
     FROM dev_proposals
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 50`
  ).all(DEFAULT_USER_ID);
  res.json(rows);
});

// Get detail including diff content
router.get("/:id", (req, res) => {
  const row = db.prepare(
    "SELECT * FROM dev_proposals WHERE id=? AND user_id=?"
  ).get(req.params.id, DEFAULT_USER_ID);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// Approve → perform the write
router.post("/:id/approve", (req, res) => {
  const proposal = db.prepare(
    "SELECT * FROM dev_proposals WHERE id=? AND user_id=?"
  ).get(req.params.id, DEFAULT_USER_ID) as any;
  if (!proposal) return res.status(404).json({ error: "Proposal not found" });
  if (proposal.status !== "pending") {
    return res.status(400).json({ error: `Cannot approve — status is '${proposal.status}'` });
  }
  if (proposal.kind !== "write_file" || !proposal.path) {
    return res.status(400).json({ error: "Only write_file proposals supported" });
  }

  try {
    fs.mkdirSync(path.dirname(proposal.path), { recursive: true });
    fs.writeFileSync(proposal.path, proposal.after_content, "utf-8");

    db.prepare(
      "UPDATE dev_proposals SET status='written', reviewed_at=datetime('now'), write_result='ok' WHERE id=?"
    ).run(proposal.id);

    logExecution(
      "Dev Tools",
      `Proposal approved & written: ${proposal.path} (by ${proposal.agent_name ?? "unknown agent"})`
    );
    res.json({ ok: true, path: proposal.path, bytes: proposal.after_content.length });
  } catch (err: any) {
    db.prepare(
      "UPDATE dev_proposals SET status='approved', reviewed_at=datetime('now'), write_result=? WHERE id=?"
    ).run(err.message?.slice(0, 200) ?? "write failed", proposal.id);
    res.status(500).json({ error: `Write failed: ${err.message}` });
  }
});

// Reject → no write
router.post("/:id/reject", (req, res) => {
  const result = db.prepare(
    `UPDATE dev_proposals SET status='rejected', reviewed_at=datetime('now')
     WHERE id=? AND user_id=? AND status='pending'`
  ).run(req.params.id, DEFAULT_USER_ID);
  if (result.changes === 0) return res.status(400).json({ error: "Proposal not pending or not found" });
  logExecution("Dev Tools", `Proposal rejected: ${req.params.id}`);
  res.json({ ok: true });
});

export default router;
