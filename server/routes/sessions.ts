/**
 * L7 Transport — Action sessions API (Phase 1 read + Phase 4 takeover).
 *
 * Phase 4 adds:
 *   PATCH /:id/pause | /:id/resume | /:id/cancel
 *   PATCH /:id/steps/:stepId        — edit a pending step (name/tool/input/approval)
 *   POST  /:id/steps                — insert a new step after a given anchor
 *   DELETE /:id/steps/:stepId       — mark step skipped (downstream sees it as done)
 *   POST  /:id/takeover             — convert all pending steps to awaiting_approval
 *
 * Edit constraints: only steps with status IN ('pending','retrying','awaiting_approval')
 * may be modified. Running / succeeded / failed are immutable from the API.
 */
import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { listSessions, getSession, getSessionSteps } from "../cognition/plan-compiler.js";
import { enqueueApproval } from "../permission/approval-queue.js";
import { bus } from "../orchestration/bus.js";

const router = Router();

// ── Read ──────────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const status = req.query.status as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
  res.json(listSessions({ status, limit }));
});

router.get("/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  const steps = getSessionSteps(req.params.id);
  res.json({ ...session, steps });
});

router.get("/:id/steps", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  res.json(getSessionSteps(req.params.id));
});

// ── Lifecycle (Phase 4) ───────────────────────────────────────────────────

router.patch("/:id/pause", (req, res) => {
  const r = db.prepare(
    "UPDATE action_sessions SET status='paused', updated_at=datetime('now') WHERE user_id=? AND id=? AND status='running'"
  ).run(DEFAULT_USER_ID, req.params.id);
  if (r.changes === 0) return res.status(409).json({ error: "session not running or not found" });
  res.json({ ok: true });
});

router.patch("/:id/resume", (req, res) => {
  const r = db.prepare(
    "UPDATE action_sessions SET status='running', updated_at=datetime('now') WHERE user_id=? AND id=? AND status='paused'"
  ).run(DEFAULT_USER_ID, req.params.id);
  if (r.changes === 0) return res.status(409).json({ error: "session not paused or not found" });
  res.json({ ok: true });
});

router.patch("/:id/cancel", (req, res) => {
  const r = db.prepare(
    `UPDATE action_sessions SET status='cancelled', updated_at=datetime('now')
       WHERE user_id=? AND id=? AND status IN ('pending','running','paused')`
  ).run(DEFAULT_USER_ID, req.params.id);
  if (r.changes === 0) return res.status(409).json({ error: "session already finished or not found" });
  // Mark any open steps skipped so the runner doesn't pick them up
  db.prepare(
    `UPDATE action_steps SET status='skipped', updated_at=datetime('now')
       WHERE session_id=? AND status IN ('pending','retrying','awaiting_approval')`
  ).run(req.params.id);
  res.json({ ok: true });
});

// ── Edit a step (Phase 4) ─────────────────────────────────────────────────

const EditStepBody = z.object({
  name: z.string().min(1).max(500).optional(),
  tool: z.string().min(1).nullable().optional(),
  input_template_json: z.string().optional(),
  approval_required: z.boolean().optional(),
  runtime: z.enum(["llm", "cli", "browser", "local_app", "db", "human"]).optional(),
  verify_rule: z.string().nullable().optional(),
  type: z.enum(["query", "draft", "side_effect", "approval", "verify"]).optional(),
});

const EDITABLE_STATUS = ["pending", "retrying", "awaiting_approval"];

router.patch("/:id/steps/:stepId", (req, res) => {
  const parsed = EditStepBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });

  const step = db.prepare(
    `SELECT s.id, s.status FROM action_steps s
       JOIN action_sessions ses ON ses.id=s.session_id
       WHERE ses.user_id=? AND s.id=? AND s.session_id=?`
  ).get(DEFAULT_USER_ID, req.params.stepId, req.params.id) as any;
  if (!step) return res.status(404).json({ error: "step not found" });
  if (!EDITABLE_STATUS.includes(step.status)) {
    return res.status(409).json({ error: `step status='${step.status}' is not editable` });
  }

  const sets: string[] = ["updated_at=datetime('now')"];
  const args: any[] = [];
  if (parsed.data.name !== undefined) { sets.push("name=?"); args.push(parsed.data.name); }
  if (parsed.data.tool !== undefined) { sets.push("tool=?"); args.push(parsed.data.tool); }
  if (parsed.data.input_template_json !== undefined) {
    try { JSON.parse(parsed.data.input_template_json); }
    catch { return res.status(400).json({ error: "input_template_json must be valid JSON" }); }
    sets.push("input_template_json=?");
    args.push(parsed.data.input_template_json);
  }
  if (parsed.data.approval_required !== undefined) {
    sets.push("approval_required=?");
    args.push(parsed.data.approval_required ? 1 : 0);
  }
  if (parsed.data.runtime !== undefined) { sets.push("runtime=?"); args.push(parsed.data.runtime); }
  if (parsed.data.verify_rule !== undefined) { sets.push("verify_rule=?"); args.push(parsed.data.verify_rule); }
  if (parsed.data.type !== undefined) { sets.push("type=?"); args.push(parsed.data.type); }

  // If a step was awaiting_approval and the user edits + flips
  // approval_required=false, drop it back to pending so runner picks it up.
  if (parsed.data.approval_required === false && step.status === "awaiting_approval") {
    sets.push("status='pending'");
  }

  args.push(req.params.stepId);
  db.prepare(`UPDATE action_steps SET ${sets.join(",")} WHERE id=?`).run(...args);
  res.json({ ok: true });
});

// ── Insert a step after an anchor (Phase 4) ───────────────────────────────

const InsertStepBody = z.object({
  after_step_id: z.string().min(1),
  name: z.string().min(1).max(500),
  type: z.enum(["query", "draft", "side_effect", "approval", "verify"]),
  runtime: z.enum(["llm", "cli", "browser", "local_app", "db", "human"]),
  tool: z.string().nullable(),
  input_template_json: z.string(),
  approval_required: z.boolean().default(false),
  verify_rule: z.string().nullable().optional(),
});

router.post("/:id/steps", (req, res) => {
  const parsed = InsertStepBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });

  const session = db.prepare(
    "SELECT status FROM action_sessions WHERE user_id=? AND id=?"
  ).get(DEFAULT_USER_ID, req.params.id) as any;
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!["pending", "running", "paused"].includes(session.status)) {
    return res.status(409).json({ error: `session status='${session.status}' is not editable` });
  }

  const anchor = db.prepare(
    "SELECT step_index FROM action_steps WHERE session_id=? AND id=?"
  ).get(req.params.id, parsed.data.after_step_id) as any;
  if (!anchor) return res.status(404).json({ error: "anchor step not found" });

  try { JSON.parse(parsed.data.input_template_json); }
  catch { return res.status(400).json({ error: "input_template_json must be valid JSON" }); }

  const insertAt = anchor.step_index + 1;

  // Atomic shift: bump every step at or after insertAt by 1.
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE action_steps SET step_index=step_index+1, updated_at=datetime('now')
         WHERE session_id=? AND step_index >= ?`
    ).run(req.params.id, insertAt);

    const id = nanoid();
    db.prepare(
      `INSERT INTO action_steps
         (id, session_id, step_index, name, type, runtime, tool,
          input_template_json, approval_required, verify_rule,
          depends_on_step_ids_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, req.params.id, insertAt,
      parsed.data.name,
      parsed.data.type,
      parsed.data.runtime,
      parsed.data.tool,
      parsed.data.input_template_json,
      parsed.data.approval_required ? 1 : 0,
      parsed.data.verify_rule ?? null,
      JSON.stringify([parsed.data.after_step_id]),
    );
    return id;
  });
  const newId = tx();
  res.json({ id: newId });
});

// ── Skip a step (Phase 4) ─────────────────────────────────────────────────

router.delete("/:id/steps/:stepId", (req, res) => {
  const step = db.prepare(
    `SELECT s.id, s.status FROM action_steps s
       JOIN action_sessions ses ON ses.id=s.session_id
       WHERE ses.user_id=? AND s.id=? AND s.session_id=?`
  ).get(DEFAULT_USER_ID, req.params.stepId, req.params.id) as any;
  if (!step) return res.status(404).json({ error: "step not found" });
  if (!EDITABLE_STATUS.includes(step.status)) {
    return res.status(409).json({ error: `step status='${step.status}' is not skippable` });
  }
  db.prepare(
    "UPDATE action_steps SET status='skipped', updated_at=datetime('now') WHERE id=?"
  ).run(req.params.stepId);
  res.json({ ok: true });
});

// ── Takeover: hand control back to user (Phase 4) ─────────────────────────

router.post("/:id/takeover", (req, res) => {
  const session = db.prepare(
    "SELECT status, goal FROM action_sessions WHERE user_id=? AND id=?"
  ).get(DEFAULT_USER_ID, req.params.id) as any;
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!["pending", "running", "paused"].includes(session.status)) {
    return res.status(409).json({ error: `session status='${session.status}' cannot be taken over` });
  }

  const openSteps = db.prepare(
    `SELECT id, step_index, name, runtime, tool FROM action_steps
       WHERE session_id=? AND status IN ('pending','retrying') ORDER BY step_index`
  ).all(req.params.id) as any[];

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE action_sessions SET status='paused', updated_at=datetime('now') WHERE id=?"
    ).run(req.params.id);
    db.prepare(
      `UPDATE action_steps SET status='awaiting_approval', approval_required=1, updated_at=datetime('now')
         WHERE session_id=? AND status IN ('pending','retrying')`
    ).run(req.params.id);
  });
  tx();

  // Funnel each step into the unified approval inbox.
  for (const s of openSteps) {
    try {
      enqueueApproval({
        source: "step",
        sourceRefId: s.id,
        title: `Takeover: ${s.tool ?? s.runtime} — ${s.name.slice(0, 60)}`,
        summary: `User-requested takeover of session ${req.params.id.slice(0, 6)}; step ${s.step_index + 1}`,
        detail: { sessionId: req.params.id, stepId: s.id, stepIndex: s.step_index, tool: s.tool, runtime: s.runtime, takeover: true },
        riskLevel: "high",
      });
    } catch (err) { console.error("[Takeover] enqueue failed:", err); }
  }

  bus.publish({
    type: "NOTIFICATION",
    payload: {
      id: `takeover-${req.params.id}`,
      type: "session_takeover",
      title: "Session paused — your turn",
      body: `${openSteps.length} step(s) waiting for you in /approvals`,
      priority: "high",
      action: { label: "Review", type: "navigate", payload: { path: "/approvals" } },
    },
  });

  res.json({ ok: true, pausedSteps: openSteps.length });
});

export default router;
