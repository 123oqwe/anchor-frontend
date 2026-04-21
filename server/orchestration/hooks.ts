/**
 * User Hooks — Claude-Code-style callbacks on Anchor events.
 *
 * Users register hooks that fire on internal events (agent_run_start,
 * tool_call_failure, job_succeeded, etc.). Two action types:
 *
 *   • shell — spawn `/bin/sh -c "<command>"`; the event payload is piped to
 *     stdin as JSON and also available as env var ANCHOR_HOOK_EVENT. 30s
 *     timeout. Use this for notifications, logging to external systems,
 *     triggering local scripts (osascript, curl webhooks, etc.).
 *
 *   • agent — enqueue a run_agent job on Task Brain; the event JSON becomes
 *     the agent's input message. Useful for "when tool X fails, ask agent Y
 *     to investigate".
 *
 * Matchers are simple JSON objects. Example: {"tool_name": "send_email"}
 * fires only when the event's payload.tool_name === "send_email".
 *
 * Non-blocking: fireHook returns immediately; hooks run async. Hook failures
 * are logged but never break the originating event.
 */
import { spawn } from "child_process";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { enqueueJob } from "./task-brain.js";

export type HookEvent =
  | "agent_run_start"
  | "agent_run_end"
  | "tool_call_success"
  | "tool_call_failure"
  | "job_succeeded"
  | "job_failed"
  | "bridge_dispatch";

const SHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 2_000;

// ── Fire ────────────────────────────────────────────────────────────────────

export function fireHook(event: HookEvent, payload: any): void {
  // Async, fire-and-forget — never block the caller
  queueMicrotask(() => { runMatchingHooks(event, payload).catch(() => {}); });
}

async function runMatchingHooks(event: HookEvent, payload: any): Promise<void> {
  let rows: any[];
  try {
    rows = db.prepare(
      "SELECT * FROM user_hooks WHERE user_id=? AND event=? AND enabled=1"
    ).all(DEFAULT_USER_ID, event) as any[];
  } catch (err: any) {
    console.error(`[Hook] DB read failed for event ${event}:`, err.message);
    return;
  }
  if (rows.length === 0) return;

  for (const row of rows) {
    const matcher = safeParse(row.matcher);
    if (!matcherMatches(matcher, payload)) continue;

    // Update last_fired + count
    db.prepare("UPDATE user_hooks SET last_fired_at=datetime('now'), fire_count=fire_count+1 WHERE id=?")
      .run(row.id);

    const cfg = safeParse(row.action_config);
    try {
      if (row.action_type === "shell") await runShellHook(row, cfg, event, payload);
      else if (row.action_type === "agent") await runAgentHook(row, cfg, event, payload);
      else {
        logExecution(`Hook: ${row.name || row.id}`, `unknown action_type ${row.action_type}`, "failed");
      }
    } catch (err: any) {
      logExecution(`Hook: ${row.name || row.id}`, `hook failed: ${err.message?.slice(0, 200)}`, "failed");
    }
  }
}

/** Check if all matcher keys match corresponding payload values (shallow). */
function matcherMatches(matcher: Record<string, any>, payload: any): boolean {
  if (!matcher || typeof matcher !== "object") return true;
  for (const [k, v] of Object.entries(matcher)) {
    if (payload?.[k] !== v) return false;
  }
  return true;
}

// ── Shell hook ──────────────────────────────────────────────────────────────

async function runShellHook(row: any, cfg: any, event: HookEvent, payload: any): Promise<void> {
  const command = String(cfg.command ?? "").trim();
  if (!command) {
    logExecution(`Hook: ${row.name || row.id}`, "shell hook missing command", "failed");
    return;
  }

  const eventJson = JSON.stringify({ event, payload });
  return new Promise<void>((resolve) => {
    const proc = spawn("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        ANCHOR_HOOK_EVENT: event,
        ANCHOR_HOOK_PAYLOAD: eventJson,
      },
      timeout: SHELL_TIMEOUT_MS,
    });
    let stdout = "", stderr = "";
    proc.stdout?.on("data", (d) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString(); });
    proc.stdin?.write(eventJson);
    proc.stdin?.end();
    proc.on("close", (code) => {
      const status = code === 0 ? "success" : "failed";
      const summary = `${event}: exit ${code}${stderr ? ` | stderr: ${stderr.slice(0, 120)}` : ""}`;
      logExecution(`Hook: ${row.name || row.id}`, summary, status);
      resolve();
    });
    proc.on("error", (err) => {
      logExecution(`Hook: ${row.name || row.id}`, `spawn error: ${err.message}`, "failed");
      resolve();
    });
  });
}

// ── Agent hook ──────────────────────────────────────────────────────────────

async function runAgentHook(row: any, cfg: any, event: HookEvent, payload: any): Promise<void> {
  const agentName = String(cfg.agent_name ?? cfg.agentName ?? "").trim();
  if (!agentName) {
    logExecution(`Hook: ${row.name || row.id}`, "agent hook missing agent_name", "failed");
    return;
  }
  const prefix = String(cfg.message_prefix ?? `[Hook ${event}]`);
  const eventMsg = `${prefix} ${JSON.stringify(payload).slice(0, 2_000)}`;

  enqueueJob({
    source: "trigger",
    sourceId: row.id,
    actionType: "run_agent",
    actionConfig: { agent_name: agentName, message: eventMsg },
    name: `Hook: ${row.name || row.id} → ${agentName}`,
  });
}

function safeParse(s: any): any { if (typeof s !== "string") return s ?? {}; try { return JSON.parse(s); } catch { return {}; } }

// ── CRUD helpers (used by routes/hooks.ts) ──────────────────────────────────

export function listHooks() {
  return db.prepare(
    "SELECT * FROM user_hooks WHERE user_id=? ORDER BY created_at DESC"
  ).all(DEFAULT_USER_ID) as any[];
}

export function createHook(opts: {
  name?: string;
  event: HookEvent;
  matcher?: Record<string, any>;
  actionType: "shell" | "agent";
  actionConfig: any;
  enabled?: boolean;
}): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO user_hooks (id, user_id, name, event, matcher, action_type, action_config, enabled) VALUES (?,?,?,?,?,?,?,?)"
  ).run(
    id, DEFAULT_USER_ID, opts.name ?? "",
    opts.event,
    JSON.stringify(opts.matcher ?? {}),
    opts.actionType,
    JSON.stringify(opts.actionConfig ?? {}),
    opts.enabled === false ? 0 : 1,
  );
  return id;
}

export function updateHook(id: string, patch: Partial<{
  name: string; event: HookEvent;
  matcher: Record<string, any>;
  actionType: "shell" | "agent";
  actionConfig: any;
  enabled: boolean;
}>): void {
  const row = db.prepare("SELECT * FROM user_hooks WHERE id=? AND user_id=?").get(id, DEFAULT_USER_ID) as any;
  if (!row) throw new Error("Hook not found");
  db.prepare(
    `UPDATE user_hooks SET name=?, event=?, matcher=?, action_type=?, action_config=?, enabled=? WHERE id=? AND user_id=?`
  ).run(
    patch.name ?? row.name,
    patch.event ?? row.event,
    patch.matcher !== undefined ? JSON.stringify(patch.matcher) : row.matcher,
    patch.actionType ?? row.action_type,
    patch.actionConfig !== undefined ? JSON.stringify(patch.actionConfig) : row.action_config,
    patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0),
    id, DEFAULT_USER_ID,
  );
}

export function deleteHook(id: string): void {
  db.prepare("DELETE FROM user_hooks WHERE id=? AND user_id=?").run(id, DEFAULT_USER_ID);
}
