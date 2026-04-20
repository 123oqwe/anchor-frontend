/**
 * User-Cron Runtime — the missing scheduler.
 *
 * Until now, `/api/crons` stored rows in `user_crons` but nothing in the
 * codebase READ them on a schedule. The natural-language automations users
 * created were inert — stored, visible in the UI, never fired.
 *
 * This runtime closes that gap. It:
 *   1. Reads user_crons (enabled=1) at boot
 *   2. Registers a node-cron job per row
 *   3. Polls the DB every 60s to pick up new/deleted/toggled rows
 *   4. Executes actions via L8-Hand Bridge when external (send_email, create_calendar_event, desktop_automate, browser_navigate, dev_delegate)
 *      or via direct internal path for "remind" / "run_agent"
 *
 * Codex-style: every external action goes through the bridge → CLI → MCP → Vision
 * fallback chain. No AppleScript string concatenation, no direct fetch.
 */
import cron, { type ScheduledTask } from "node-cron";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { bus } from "./bus.js";

interface UserCronRow {
  id: string;
  name: string;
  cron_pattern: string;
  action_type: string;
  action_config: string;
  enabled: number;
}

const scheduled = new Map<string, { task: ScheduledTask; pattern: string; actionType: string }>();
let pollTimer: NodeJS.Timeout | null = null;

export function startUserCronRuntime(): void {
  refreshFromDb();
  pollTimer = setInterval(refreshFromDb, 60_000);
  console.log("⏰ User-cron runtime started (polling every 60s)");
}

export function stopUserCronRuntime(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  scheduled.forEach((s) => { try { s.task.stop(); } catch {} });
  scheduled.clear();
}

function refreshFromDb(): void {
  let rows: UserCronRow[];
  try {
    rows = db.prepare("SELECT id, name, cron_pattern, action_type, action_config, enabled FROM user_crons WHERE user_id=? AND enabled=1").all(DEFAULT_USER_ID) as UserCronRow[];
  } catch (err: any) {
    console.error("[UserCron] DB read failed:", err.message);
    return;
  }

  const activeIds = new Set(rows.map(r => r.id));

  // Stop tasks for rows that no longer exist / disabled / pattern changed
  for (const [id, s] of Array.from(scheduled.entries())) {
    if (!activeIds.has(id)) {
      try { s.task.stop(); } catch {}
      scheduled.delete(id);
      continue;
    }
    // Pattern changed → restart
    const row = rows.find(r => r.id === id);
    if (row && (row.cron_pattern !== s.pattern || row.action_type !== s.actionType)) {
      try { s.task.stop(); } catch {}
      scheduled.delete(id);
    }
  }

  // Register new tasks
  for (const row of rows) {
    if (scheduled.has(row.id)) continue;
    if (!cron.validate(row.cron_pattern)) {
      console.error(`[UserCron] Invalid pattern "${row.cron_pattern}" on cron ${row.id} (${row.name})`);
      continue;
    }
    try {
      const task = cron.schedule(row.cron_pattern, () => { executeAction(row).catch(err => {
        console.error(`[UserCron] Action ${row.name} threw:`, err.message);
        logExecution(`Cron: ${row.name}`, `Failed: ${err.message}`, "failed");
      }); });
      scheduled.set(row.id, { task, pattern: row.cron_pattern, actionType: row.action_type });
    } catch (err: any) {
      console.error(`[UserCron] Failed to schedule ${row.name}:`, err.message);
    }
  }
}

async function executeAction(row: UserCronRow): Promise<void> {
  const runId = nanoid();
  let cfg: any = {};
  try { cfg = JSON.parse(row.action_config ?? "{}"); } catch {}

  console.log(`[UserCron] Firing ${row.name} (${row.action_type}) runId=${runId}`);

  switch (row.action_type) {
    case "run_agent":
      await runAgentAction(row, cfg, runId);
      break;
    case "send_email":
      await dispatchBridge("email.send", cfg, runId, row.name);
      break;
    case "create_calendar_event":
      await dispatchBridge("calendar.create_event", cfg, runId, row.name);
      break;
    case "browser_navigate":
      await dispatchBridge("browser.navigate", cfg, runId, row.name);
      break;
    case "desktop_automate":
      await dispatchBridge("desktop.automate", cfg, runId, row.name);
      break;
    case "dev_delegate":
      await dispatchBridge("dev.delegate", cfg, runId, row.name);
      break;
    case "remind":
      // Internal notification, no external action — no bridge needed
      bus.publish({
        type: "NOTIFICATION",
        payload: {
          id: `cron-remind-${row.id}-${Date.now()}`,
          type: "reminder",
          title: row.name,
          body: cfg.message ?? row.name,
          priority: "normal",
        },
      });
      logExecution(`Cron: ${row.name}`, `Reminder sent`);
      break;
    default:
      logExecution(`Cron: ${row.name}`, `Unknown action_type "${row.action_type}"`, "failed");
  }
}

async function dispatchBridge(capability: string, input: any, runId: string, cronName: string): Promise<void> {
  const { dispatchCapability } = await import("../bridges/registry.js");
  const r = await dispatchCapability(capability, input, { previousResults: [], stepIndex: 0, totalSteps: 1, runId }, "cron");
  logExecution(
    `Cron: ${cronName}`,
    `${capability} → ${r.providerId ?? "none"}: ${r.success ? "success" : r.error}`,
    r.success ? "success" : "failed"
  );
}

async function runAgentAction(row: UserCronRow, cfg: any, runId: string): Promise<void> {
  const agentName: string | undefined = cfg.agent_name ?? cfg.agentName;
  const message: string = cfg.message ?? cfg.prompt ?? `Scheduled trigger from cron "${row.name}"`;
  if (!agentName) {
    logExecution(`Cron: ${row.name}`, `run_agent missing agent_name in config`, "failed");
    return;
  }

  const agent = db.prepare("SELECT * FROM user_agents WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, agentName) as any;
  if (!agent) {
    logExecution(`Cron: ${row.name}`, `Agent "${agentName}" not found`, "failed");
    return;
  }

  try {
    const { serializeForPrompt } = await import("../graph/reader.js");
    const graphContext = serializeForPrompt();
    const systemPrompt = `${agent.instructions}\n\nUser's Human Graph context:\n${graphContext}\n\n(Triggered by scheduled cron "${row.name}")`;

    const allowedTools: string[] = (() => { try { return JSON.parse(agent.tools) ?? []; } catch { return []; } })();

    if (allowedTools.length > 0) {
      // ReAct with bridge-dispatched tools
      const { runCustomAgentReAct } = await import("../execution/custom-agent-react.js");
      const result = await runCustomAgentReAct({
        agentId: agent.id, agentName: agent.name,
        systemPrompt, userMessage: message, allowedTools, runId,
      });
      db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, `Cron: ${row.name}`, `${agent.name} (${result.turns} turns, ${result.toolCalls.length} tools)`, "success", runId);
      logExecution(`Cron: ${row.name}`, `Agent "${agent.name}" completed: ${result.turns} turns`);
    } else {
      const { text } = await import("../infra/compute/index.js");
      const result = await text({
        task: "decision",
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
        maxTokens: 1500,
        runId,
        agentName: `Cron[${row.name}]: ${agent.name}`,
      });
      db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, `Cron: ${row.name}`, `${agent.name}: ${result.slice(0, 80)}`, "success", runId);
      logExecution(`Cron: ${row.name}`, `Agent "${agent.name}" returned (no tools): ${result.slice(0, 60)}`);
    }
  } catch (err: any) {
    logExecution(`Cron: ${row.name}`, `Agent run failed: ${err.message}`, "failed");
  }
}

export function getScheduledCronStatus() {
  const list: { id: string; pattern: string; actionType: string; running: boolean }[] = [];
  scheduled.forEach((s, id) => {
    list.push({ id, pattern: s.pattern, actionType: s.actionType, running: true });
  });
  return { count: scheduled.size, tasks: list };
}
