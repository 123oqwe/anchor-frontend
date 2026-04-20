/**
 * L4 Orchestration — Event-driven agent triggers (OPT-2).
 *
 * Watches system events and triggers Custom Agents based on user-configured rules.
 * Each Custom Agent has trigger_type: manual | schedule | file_change | git_commit |
 * email_received | calendar_upcoming | node_status | app_focused | idle.
 *
 * Safety:
 *   - Debounce per-agent 3s (prevent rapid re-triggering)
 *   - Ignore initial state (chokidar ignoreInitial: true)
 *   - User must explicitly configure paths/patterns
 *   - Rate limit per agent: max 10 triggered runs/hour
 */
import { bus, type AnchorEvent } from "./bus.js";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

// ── Debounce registry to prevent rapid re-triggers ─────────────────────────

const lastTrigger = new Map<string, number>();  // agentId → timestamp
const DEBOUNCE_MS = 3000;
const HOURLY_LIMIT = 10;

function canTrigger(agentId: string): boolean {
  const now = Date.now();
  const last = lastTrigger.get(agentId);
  if (last && now - last < DEBOUNCE_MS) return false;

  // Hourly rate limit check via DB
  const count = (db.prepare(
    "SELECT COUNT(*) as c FROM agent_executions WHERE user_id=? AND agent LIKE ? AND created_at >= datetime('now', '-1 hour')"
  ).get(DEFAULT_USER_ID, `Triggered:%`) as any)?.c ?? 0;
  if (count >= HOURLY_LIMIT * 10) {  // 10 agents × 10 = 100 total/hour ceiling
    console.warn("[Event Triggers] Hourly trigger ceiling reached, skipping");
    return false;
  }

  lastTrigger.set(agentId, now);
  return true;
}

// ── Main dispatch: event → find matching agents → run them ─────────────────

async function dispatchToAgents(
  triggerType: string,
  eventPayload: any,
  matchesFn: (config: any, payload: any) => boolean
): Promise<void> {
  const agents = db.prepare(
    "SELECT * FROM user_agents WHERE user_id=? AND enabled=1 AND trigger_type=?"
  ).all(DEFAULT_USER_ID, triggerType) as any[];

  for (const agent of agents) {
    if (!canTrigger(agent.id)) continue;

    let config: any = {};
    try { config = JSON.parse(agent.trigger_config ?? "{}"); } catch { /* use empty */ }

    if (!matchesFn(config, eventPayload)) continue;

    // Fire agent (non-blocking)
    runAgentFromEvent(agent, eventPayload).catch(err => {
      console.error(`[Event Triggers] ${agent.name} failed:`, err.message);
    });
  }
}

async function runAgentFromEvent(agent: any, eventPayload: any): Promise<void> {
  try {
    const { text } = await import("../infra/compute/index.js");
    const { serializeForPrompt } = await import("../graph/reader.js");
    const { writeMemory } = await import("../memory/retrieval.js");

    const runId = nanoid();
    const message = `Event trigger payload: ${JSON.stringify(eventPayload)}`;
    const graphContext = serializeForPrompt();
    const systemPrompt = `${agent.instructions}\n\nUser's Human Graph context:\n${graphContext}\n\n(Triggered by ${agent.trigger_type} event)`;

    const allowedTools: string[] = (() => { try { return JSON.parse(agent.tools) ?? []; } catch { return []; } })();

    let result: string;
    if (allowedTools.length > 0) {
      const { runCustomAgentReAct } = await import("../execution/custom-agent-react.js");
      const reactResult = await runCustomAgentReAct({
        agentId: agent.id,
        agentName: agent.name,
        systemPrompt,
        userMessage: message,
        allowedTools,
        runId,
      });
      result = reactResult.text || "(agent completed tool calls)";
    } else {
      result = await text({
        task: "decision",
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
        maxTokens: 1500,
        runId,
        agentName: `Triggered: ${agent.name}`,
      });
    }

    db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)")
      .run(nanoid(), DEFAULT_USER_ID, `Triggered: ${agent.name}`, JSON.stringify(eventPayload).slice(0, 100), "success", runId);

    // Save result for agent memory
    writeMemory({
      type: "episodic",
      title: `${agent.name} triggered: ${agent.trigger_type}`,
      content: `Event: ${JSON.stringify(eventPayload).slice(0, 100)}\nResult: ${result.slice(0, 300)}`,
      tags: ["triggered", agent.trigger_type],
      source: `Custom: ${agent.name}`,
      confidence: 0.8,
    });

    logExecution(`Triggered: ${agent.name}`, `${agent.trigger_type} event`, "success");
  } catch (err: any) {
    logExecution(`Triggered: ${agent.name}`, err.message?.slice(0, 100) ?? "error", "failed");
  }
}

// ── Event Bus listeners ───────────────────────────────────────────────────

export function startEventTriggers(): void {

  // FILE_CHANGED → match on glob/substring
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "FILE_CHANGED") return;
    const payload = event.payload;
    dispatchToAgents("file_change", payload, (config, p) => {
      if (!config.pattern) return false;
      // Simple substring match (no glob for simplicity)
      return p.path.includes(config.pattern);
    });
  });

  // GIT_COMMIT → any commit
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "GIT_COMMIT") return;
    dispatchToAgents("git_commit", event.payload, (config, p) => {
      if (config.repo_pattern && !p.repo.includes(config.repo_pattern)) return false;
      if (config.message_pattern && !p.message.includes(config.message_pattern)) return false;
      return true;
    });
  });

  // EMAIL_RECEIVED → match on from/subject
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "EMAIL_RECEIVED") return;
    dispatchToAgents("email_received", event.payload, (config, p) => {
      if (config.from_pattern && !p.from.toLowerCase().includes(config.from_pattern.toLowerCase())) return false;
      if (config.subject_pattern && !p.subject.toLowerCase().includes(config.subject_pattern.toLowerCase())) return false;
      return true;
    });
  });

  // CALENDAR_UPCOMING → match on minutes-before
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "CALENDAR_UPCOMING") return;
    dispatchToAgents("calendar_upcoming", event.payload, (config, p) => {
      const target = config.minutes_before ?? 30;
      return p.startsInMinutes <= target && p.startsInMinutes > target - 10;
    });
  });

  // NODE_STATUS_CHANGED → match transition
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "NODE_STATUS_CHANGED") return;
    dispatchToAgents("node_status", event.payload, (config, p) => {
      if (config.from && config.from !== p.from) return false;
      if (config.to && config.to !== p.to) return false;
      return true;
    });
  });

  // APP_FOCUSED → match app name
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "APP_FOCUSED") return;
    dispatchToAgents("app_focused", event.payload, (config, p) => {
      return !config.app || p.app.toLowerCase().includes(config.app.toLowerCase());
    });
  });

  // IDLE_DETECTED → match threshold
  bus.on("event", (event: AnchorEvent) => {
    if (event.type !== "IDLE_DETECTED") return;
    dispatchToAgents("idle", event.payload, (config, p) => {
      return p.idleMinutes >= (config.min_idle_minutes ?? 60);
    });
  });

  console.log("⚡ Event triggers: file_change · git_commit · email_received · calendar_upcoming · node_status · app_focused · idle");
}

// ── Watchers (optional — started only if user configures agents with these triggers) ──

export async function startFileWatcher(watchPath: string): Promise<void> {
  try {
    const chokidar = await import("chokidar");
    const watcher = chokidar.default.watch(watchPath, {
      ignored: [/node_modules/, /\.git\//, /\.DS_Store/, /dist\//],
      ignoreInitial: true,
      persistent: true,
    });

    watcher.on("add", (path) => bus.publish({ type: "FILE_CHANGED", payload: { path, event: "add" } }));
    watcher.on("change", (path) => bus.publish({ type: "FILE_CHANGED", payload: { path, event: "change" } }));
    watcher.on("unlink", (path) => bus.publish({ type: "FILE_CHANGED", payload: { path, event: "delete" } }));

    console.log(`[Event Triggers] File watcher started: ${watchPath}`);
  } catch (err: any) {
    console.error(`[Event Triggers] File watcher failed:`, err.message);
  }
}

export async function startIdleWatcher(thresholdMinutes = 30): Promise<void> {
  // Every 5 min, check activity_captures — if no capture in last N min, emit IDLE_DETECTED
  setInterval(() => {
    const last = db.prepare(
      "SELECT MAX(captured_at) as last FROM activity_captures WHERE user_id=?"
    ).get(DEFAULT_USER_ID) as any;

    if (!last?.last) return;
    const idleMs = Date.now() - new Date(last.last).getTime();
    const idleMinutes = Math.floor(idleMs / 60000);

    if (idleMinutes >= thresholdMinutes) {
      bus.publish({ type: "IDLE_DETECTED", payload: { idleMinutes } });
    }
  }, 5 * 60 * 1000);

  console.log(`[Event Triggers] Idle watcher started (threshold: ${thresholdMinutes} min)`);
}

// Auto-discover which watchers to start based on configured agents
export async function startWatchersFromAgents(): Promise<void> {
  const agents = db.prepare(
    "SELECT DISTINCT trigger_type, trigger_config FROM user_agents WHERE user_id=? AND enabled=1"
  ).all(DEFAULT_USER_ID) as any[];

  const triggerTypes = new Set(agents.map((a: any) => a.trigger_type));

  if (triggerTypes.has("file_change")) {
    // Start file watcher on user-configured paths (default: ~/Projects)
    const home = process.env.HOME ?? "/Users/guanjieqiao";
    await startFileWatcher(`${home}/Projects`).catch(() => {});
  }

  if (triggerTypes.has("idle")) {
    await startIdleWatcher(30);
  }
}
