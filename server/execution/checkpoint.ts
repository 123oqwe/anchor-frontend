/**
 * L5 Execution — Run checkpointing, interrupt & resume.
 *
 * Every ReAct turn snapshots its state into agent_runs so:
 *   1. Server crash mid-run → recovery on boot marks stale runs abandoned;
 *      user-visible runs can be resumed explicitly.
 *   2. Agent can call request_user_input → loop terminates cleanly, run
 *      marked 'interrupted', user receives the question. User replies via
 *      /api/runs/:id/resume → we append input, restart ReAct from the
 *      same turn with the same messages array.
 *   3. User can cancel from UI → /api/runs/:id/cancel marks it, current
 *      turn finishes, next-turn checkpoint sees the signal and exits.
 *
 * Design choices:
 *   - Full messages array stored as JSON every turn. Size concern: Exec #2
 *     compaction keeps it under 150K chars, so a whole run state is well
 *     under 1MB even in worst case. Trading disk for durability is a fine
 *     deal here.
 *   - agent_id + system_prompt + allowed_tools snapshotted at run start —
 *     if the user edits the agent mid-run, resume still uses the original
 *     config. This matches user expectations ("the run I started IS this").
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import type Anthropic from "@anthropic-ai/sdk";
import { enqueueApproval } from "../permission/approval-queue.js";

export type RunStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled" | "abandoned";

export interface RunCheckpoint {
  id: string;                    // runId
  agentId: string;
  agentName: string;
  missionId?: string;
  status: RunStatus;
  turn: number;
  maxTurns: number;
  userMessage: string;
  messages: Anthropic.Messages.MessageParam[];
  toolCalls: any[];
  systemPrompt: string;
  allowedTools: string[];
  finalText?: string;
  interruptReason?: string;
  interruptQuestion?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateRunInput {
  runId: string;
  agentId: string;
  agentName: string;
  missionId?: string;
  userMessage: string;
  messages: Anthropic.Messages.MessageParam[];
  systemPrompt: string;
  allowedTools: string[];
  maxTurns: number;
}

export function createRun(input: CreateRunInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_runs
      (id, user_id, agent_id, agent_name, mission_id, status, turn, max_turns,
       user_message, messages_json, tool_calls_json, system_prompt, allowed_tools_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    input.runId, DEFAULT_USER_ID,
    input.agentId, input.agentName, input.missionId ?? null,
    "running", 0, input.maxTurns,
    input.userMessage,
    JSON.stringify(input.messages),
    "[]",
    input.systemPrompt,
    JSON.stringify(input.allowedTools),
  );
}

/** Write a mid-run snapshot at the start of turn N. */
export function checkpointTurn(runId: string, turn: number, messages: Anthropic.Messages.MessageParam[], toolCalls: any[]): void {
  db.prepare(
    `UPDATE agent_runs SET turn=?, messages_json=?, tool_calls_json=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(turn, JSON.stringify(messages), JSON.stringify(toolCalls), runId);
}

export function markCompleted(runId: string, finalText: string, messages: Anthropic.Messages.MessageParam[], toolCalls: any[], turn: number): void {
  db.prepare(
    `UPDATE agent_runs SET status='completed', final_text=?, messages_json=?, tool_calls_json=?, turn=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(finalText, JSON.stringify(messages), JSON.stringify(toolCalls), turn, runId);
}

export function markInterrupted(runId: string, question: string, reason: string, messages: Anthropic.Messages.MessageParam[], toolCalls: any[], turn: number): void {
  db.prepare(
    `UPDATE agent_runs SET status='interrupted', interrupt_question=?, interrupt_reason=?, messages_json=?, tool_calls_json=?, turn=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(question, reason, JSON.stringify(messages), JSON.stringify(toolCalls), turn, runId);

  // Sprint B — #4: surface in unified approval inbox so the user sees the
  // pending question alongside other approvals instead of only on the runs
  // page. Decision (resume vs cancel) still goes through the existing
  // /api/agents/custom/runs/:runId/{resume,cancel} routes.
  try {
    const run = db.prepare("SELECT agent_name FROM agent_runs WHERE id=?").get(runId) as any;
    enqueueApproval({
      source: "run",
      sourceRefId: runId,
      title: `${run?.agent_name ?? "Agent"} needs input`,
      summary: question.slice(0, 200),
      detail: { runId, reason, turn, agentName: run?.agent_name },
      riskLevel: "medium",
    });
  } catch (err) { console.error("[Approval queue] run enqueue failed:", err); }
}

export function markFailed(runId: string, error: string): void {
  db.prepare(
    `UPDATE agent_runs SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`
  ).run(error.slice(0, 1000), runId);
}

export function markCancelled(runId: string): boolean {
  const result = db.prepare(
    `UPDATE agent_runs SET status='cancelled', updated_at=datetime('now')
     WHERE id=? AND status IN ('running','interrupted')`
  ).run(runId);
  return result.changes > 0;
}

export function isCancelled(runId: string): boolean {
  const row = db.prepare(`SELECT status FROM agent_runs WHERE id=?`).get(runId) as any;
  return row?.status === "cancelled";
}

export function loadRun(runId: string): RunCheckpoint | null {
  const row = db.prepare(
    `SELECT id, agent_id as agentId, agent_name as agentName, mission_id as missionId,
            status, turn, max_turns as maxTurns,
            user_message as userMessage, messages_json, tool_calls_json,
            system_prompt as systemPrompt, allowed_tools_json,
            final_text as finalText, interrupt_reason as interruptReason,
            interrupt_question as interruptQuestion, error,
            created_at as createdAt, updated_at as updatedAt
     FROM agent_runs WHERE id=?`
  ).get(runId) as any;
  if (!row) return null;
  return {
    ...row,
    messages: JSON.parse(row.messages_json ?? "[]"),
    toolCalls: JSON.parse(row.tool_calls_json ?? "[]"),
    allowedTools: JSON.parse(row.allowed_tools_json ?? "[]"),
  };
}

/** Server boot recovery — mark runs stuck in 'running' for > N minutes as abandoned. */
export function recoverStaleRuns(staleMinutes = 10): number {
  const result = db.prepare(
    `UPDATE agent_runs
     SET status='abandoned', error='server restarted mid-run', updated_at=datetime('now')
     WHERE status='running' AND julianday('now') - julianday(updated_at) > ?`
  ).run(staleMinutes / (60 * 24));  // julianday in days
  return result.changes;
}

export function listRuns(opts: { status?: RunStatus; agentId?: string; limit?: number } = {}): RunCheckpoint[] {
  const wheres = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (opts.status) { wheres.push("status = ?"); params.push(opts.status); }
  if (opts.agentId) { wheres.push("agent_id = ?"); params.push(opts.agentId); }
  const limit = Math.min(200, opts.limit ?? 50);
  const rows = db.prepare(
    `SELECT id, agent_id as agentId, agent_name as agentName, status, turn, max_turns as maxTurns,
            user_message as userMessage, interrupt_question as interruptQuestion,
            final_text as finalText, error, created_at as createdAt, updated_at as updatedAt
     FROM agent_runs WHERE ${wheres.join(" AND ")}
     ORDER BY updated_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
  return rows.map(r => ({ ...r, messages: [], toolCalls: [], systemPrompt: "", allowedTools: [] }));
}
