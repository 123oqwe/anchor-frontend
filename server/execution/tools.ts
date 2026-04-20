/**
 * L5 Execution — Built-in tools.
 *
 * Architecture: Custom Agent ReAct loop picks a tool → tools run on the
 * user's actual Mac (real Bridge, real subprocess, real files) → result
 * streams back through the loop.
 *
 * Layer Shell:    send_email, create_calendar, create_reminder, open_url → Bridge
 * Layer DB:       write_task, update_graph_node, record_outcome → SQLite
 * Layer Code:     execute_code → real Python/Node/bash subprocess (tools/execute-code.ts)
 * Layer Network:  web_search, read_url → fetch
 * Layer Agent:    delegate → spawn subagent with fresh context (tools/delegate.ts)
 * Layer KV:       agent_state_get, agent_state_set → per-agent persistent KV
 *
 * All tools go through L6 Permission Gate via registry.ts executeTool().
 */
import { execSync } from "child_process";
import { registerTool, type ToolResult } from "./registry.js";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { bus } from "../orchestration/bus.js";
import { nanoid } from "nanoid";
import { writeMemory } from "../memory/retrieval.js";
import { registerExecuteCodeTool } from "./tools/execute-code.js";
import { registerDelegateTool } from "./tools/delegate.js";

/** Run AppleScript safely. Returns output string or null on failure. */
function runAppleScript(script: string): string | null {
  try {
    // Escape single quotes for shell
    const escaped = script.replace(/'/g, "'\\''");
    return execSync(`osascript -e '${escaped}'`, { timeout: 15000, encoding: "utf-8" }).trim();
  } catch (err: any) {
    if (err.message?.includes("-1743") || err.message?.includes("not allowed")) {
      return null; // macOS permission denied
    }
    throw err;
  }
}

// ── Register all tools on startup ───────────────────────────────────────────

export function registerBuiltinTools(): void {

  // ═══ DB Tools ═══════════════════════════════════════════════════════════

  registerTool({
    name: "write_task",
    description: "Create a task in the user's Workspace with title and priority",
    handler: "db",
    actionClass: "write_task",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "Priority level" },
      },
      required: ["title"],
    },
    execute: (input): ToolResult => {
      const project = db.prepare("SELECT id FROM projects WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
      if (!project) return { success: false, output: "No project found. Create a project first.", error: "NO_PROJECT" };
      const taskId = nanoid();
      db.prepare("INSERT INTO tasks (id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?)")
        .run(taskId, project.id, input.title, "todo", input.priority ?? "high", JSON.stringify(["auto"]));
      return {
        success: true,
        output: `Task "${input.title}" created (${input.priority ?? "high"}).`,
        data: { taskId },
        rollback: () => { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); },
      };
    },
  });

  registerTool({
    name: "update_graph_node",
    description: "Update a Human Graph node's status (e.g. mark as done, active, in-progress)",
    handler: "db",
    actionClass: "write_graph",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Node label to find (fuzzy match)" },
        new_status: { type: "string", enum: ["active", "done", "in-progress", "blocked"], description: "New status" },
      },
      required: ["label", "new_status"],
    },
    execute: (input): ToolResult => {
      const node = db.prepare("SELECT id, label, status FROM graph_nodes WHERE user_id=? AND label LIKE ?").get(DEFAULT_USER_ID, `%${input.label}%`) as any;
      if (!node) return { success: false, output: `No node matching "${input.label}"`, error: "NODE_NOT_FOUND" };
      const oldStatus = node.status;
      db.prepare("UPDATE graph_nodes SET status=?, updated_at=datetime('now') WHERE id=?").run(input.new_status, node.id);
      bus.publish({ type: "GRAPH_UPDATED", payload: { nodeId: node.id, status: input.new_status, label: node.label } });
      // OPT-2: emit NODE_STATUS_CHANGED for event-triggered agents
      bus.publish({ type: "NODE_STATUS_CHANGED", payload: { nodeId: node.id, label: node.label, from: oldStatus, to: input.new_status } });
      return { success: true, output: `"${node.label}": ${oldStatus} → ${input.new_status}.`, data: { nodeId: node.id } };
    },
  });

  registerTool({
    name: "record_outcome",
    description: "Record an execution outcome or summary to the user's memory",
    handler: "db",
    actionClass: "write_memory",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "What was accomplished" } },
      required: ["summary"],
    },
    execute: (input): ToolResult => {
      const memId = writeMemory({ type: "episodic", title: "Execution Outcome", content: input.summary, tags: ["execution", "auto"], source: "Execution Agent", confidence: 0.9 });
      return { success: true, output: "Outcome recorded.", data: { memoryId: memId } };
    },
  });

  // ═══ Shell Tools (AppleScript — zero config, uses user's own apps) ═════

  registerTool({
    name: "send_email",
    description: "Send an email. Dispatches through the Hand bridge → gmail-rest (CLI) or applemail-shortcuts (macOS fallback).",
    handler: "api",
    actionClass: "send_external",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body text" },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const { dispatchCapability } = await import("../bridges/registry.js");
      const r = await dispatchCapability("email.send", input, ctx);
      if (!r.success) {
        return { success: false, output: r.output, error: r.error };
      }
      logExecution("Execution Agent", `Email sent via ${r.providerId} to ${input.to}: ${input.subject}`);
      return {
        success: true,
        output: r.output,
        data: { ...(r.data ?? {}), providerId: r.providerId },
      };
    },
  });

  registerTool({
    name: "create_calendar_event",
    description: "Create a calendar event. Dispatches through the Hand bridge → gcal-rest (Google Calendar API) with future Apple Calendar Shortcuts fallback.",
    handler: "api",
    actionClass: "modify_calendar",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date (YYYY-MM-DD)" },
        time: { type: "string", description: "Start time (HH:MM, 24h format)" },
        duration_minutes: { type: "number", description: "Duration in minutes (default 60)" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
      },
      required: ["title", "date"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const { dispatchCapability } = await import("../bridges/registry.js");
      // Translate snake_case input to bridge capability shape
      const bridgeInput = {
        title: input.title, date: input.date, time: input.time,
        durationMinutes: input.duration_minutes, description: input.description,
        location: input.location, attendees: input.attendees,
      };
      const r = await dispatchCapability("calendar.create_event", bridgeInput, ctx);
      if (!r.success) return { success: false, output: r.output, error: r.error };
      logExecution("Execution Agent", `Calendar event via ${r.providerId}: ${input.title} on ${input.date}`);
      return {
        success: true, output: r.output,
        data: { ...(r.data ?? {}), providerId: r.providerId },
      };
    },
  });

  registerTool({
    name: "create_reminder",
    description: "Create a reminder in Apple Reminders. No API key needed.",
    handler: "shell",
    actionClass: "write_task",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Reminder text" },
        due_date: { type: "string", description: "Due date (YYYY-MM-DD, optional)" },
      },
      required: ["title"],
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        let script: string;
        if (input.due_date) {
          const [year, month, day] = input.due_date.split("-").map(Number);
          script = `
tell application "Reminders"
  set dueDate to current date
  set year of dueDate to ${year}
  set month of dueDate to ${month}
  set day of dueDate to ${day}
  make new reminder with properties {name:"${input.title.replace(/"/g, '\\"')}", due date:dueDate}
end tell`;
        } else {
          script = `tell application "Reminders" to make new reminder with properties {name:"${input.title.replace(/"/g, '\\"')}"}`;
        }
        runAppleScript(script);
        return { success: true, output: `Reminder created: "${input.title}"${input.due_date ? ` (due ${input.due_date})` : ""}` };
      } catch (err: any) {
        return { success: false, output: `Reminder error: ${err.message}`, error: err.message };
      }
    },
  });

  registerTool({
    name: "open_url",
    description: "Open a URL in the user's default browser.",
    handler: "shell",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open" } },
      required: ["url"],
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        execSync(`open "${input.url.replace(/"/g, '')}"`, { timeout: 5000 });
        return { success: true, output: `Opened ${input.url}` };
      } catch (err: any) {
        return { success: false, output: `Failed to open URL: ${err.message}`, error: err.message };
      }
    },
  });

  // ═══ Network Tools ════════════════════════════════════════════════════

  registerTool({
    name: "web_search",
    description: "Search the web. Uses DuckDuckGo (no API key needed) or Tavily/Perplexity if configured.",
    handler: "api",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        // DuckDuckGo HTML search — no API key needed
        const encoded = encodeURIComponent(input.query);
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
          headers: { "User-Agent": "Anchor-OS/1.0" },
          signal: AbortSignal.timeout(10000),
        });
        const html = await response.text();
        // Extract result snippets
        const results: string[] = [];
        const snippetRegex = /class="result__snippet"[^>]*>(.*?)<\/a>/g;
        let match;
        while ((match = snippetRegex.exec(html)) && results.length < 5) {
          const text = match[1].replace(/<[^>]*>/g, "").trim();
          if (text.length > 20) results.push(text);
        }
        if (results.length === 0) {
          // Fallback: extract any meaningful text
          const cleanText = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          const bodyStart = cleanText.indexOf("result__snippet");
          if (bodyStart > 0) results.push(cleanText.slice(bodyStart, bodyStart + 500));
        }
        const output = results.length > 0
          ? `Search results for "${input.query}":\n${results.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
          : `No results found for "${input.query}"`;
        return { success: true, output: output.slice(0, 2000) };
      } catch (err: any) {
        return { success: false, output: `Search failed: ${err.message}`, error: err.message, shouldRetry: true };
      }
    },
  });

  registerTool({
    name: "read_url",
    description: "Fetch and read the content of a web page. Returns text content.",
    handler: "api",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        const response = await fetch(input.url, {
          headers: { "User-Agent": "Anchor-OS/1.0" },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return { success: false, output: `HTTP ${response.status}`, error: "HTTP_ERROR" };
        const text = await response.text();
        const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
        return { success: true, output: clean, data: { url: input.url, length: clean.length } };
      } catch (err: any) {
        return { success: false, output: `Fetch failed: ${err.message}`, error: err.message, shouldRetry: true };
      }
    },
  });

  // ═══ Code Tool — real subprocess via execute_code (see tools/execute-code.ts) ═══
  // (registered below via registerExecuteCodeTool)

  // ═══ Agent State KV (OPT-5) ═══════════════════════════════════════════

  registerTool({
    name: "agent_state_get",
    description: "Get a persistent value stored by this agent (survives across runs). Only callable from custom agents.",
    handler: "db",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "Key to look up" } },
      required: ["key"],
    },
    execute: (input, ctx): ToolResult => {
      const agentId = ctx?.agentId;
      if (!agentId) return { success: false, output: "agent_state_get only callable from custom agents", error: "NO_AGENT_CONTEXT" };
      const row = db.prepare("SELECT value FROM agent_kv WHERE agent_id=? AND key=?").get(agentId, input.key) as any;
      return { success: true, output: row?.value ?? "null", data: { value: row?.value ?? null } };
    },
  });

  registerTool({
    name: "agent_state_set",
    description: "Store a persistent value for this agent (survives across runs). Max 100 keys per agent, 10KB per value.",
    handler: "db",
    actionClass: "write_memory",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to store under" },
        value: { type: "string", description: "Value to store (max 10KB)" },
      },
      required: ["key", "value"],
    },
    execute: (input, ctx): ToolResult => {
      const agentId = ctx?.agentId;
      if (!agentId) return { success: false, output: "agent_state_set only callable from custom agents", error: "NO_AGENT_CONTEXT" };
      if (input.value.length > 10240) return { success: false, output: "Value exceeds 10KB limit", error: "VALUE_TOO_LARGE" };

      // Capacity check: 100 keys per agent
      const count = (db.prepare("SELECT COUNT(*) as c FROM agent_kv WHERE agent_id=?").get(agentId) as any)?.c ?? 0;
      const exists = db.prepare("SELECT 1 FROM agent_kv WHERE agent_id=? AND key=?").get(agentId, input.key);
      if (!exists && count >= 100) return { success: false, output: "Agent has reached 100 key limit", error: "KEY_LIMIT_EXCEEDED" };

      db.prepare("INSERT OR REPLACE INTO agent_kv (agent_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))")
        .run(agentId, input.key, input.value);
      return { success: true, output: `Stored ${input.key} (${input.value.length} bytes)` };
    },
  });

  // ═══ Agent Composition — delegate (Claude Code-style subagent) ═════════
  // (registered below via registerDelegateTool — replaces old call_agent)

  // Register tools from dedicated files (real subprocess execute_code, subagent delegate)
  registerExecuteCodeTool();
  registerDelegateTool();

  console.log(`[Execution] 13 tools registered (3 DB + 4 shell + 2 network + 1 execute_code + 2 agent_state + 1 delegate)`);
}
