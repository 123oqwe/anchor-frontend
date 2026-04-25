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
import { registerHandoffTool } from "./tools/handoff.js";

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
        observation: { runtime: "db", table: "tasks", rowCount: 1, ids: [taskId] },
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
      return {
        success: true,
        output: `"${node.label}": ${oldStatus} → ${input.new_status}.`,
        data: { nodeId: node.id },
        observation: { runtime: "db", table: "graph_nodes", rowCount: 1, ids: [node.id] },
      };
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
      return {
        success: true,
        output: "Outcome recorded.",
        data: { memoryId: memId },
        observation: { runtime: "db", table: "memories", rowCount: 1, ids: [memId] },
      };
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
      const respId = (r.data as any)?.messageId ?? (r.data as any)?.id ?? null;
      return {
        success: true,
        output: r.output,
        data: { ...(r.data ?? {}), providerId: r.providerId },
        observation: {
          runtime: "local_app",
          providerId: r.providerId,
          bridgeResponseId: respId ?? undefined,
          recipient: input.to,
          raw: r.data,
        },
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
      const eventId = (r.data as any)?.eventId ?? (r.data as any)?.id ?? null;
      return {
        success: true, output: r.output,
        data: { ...(r.data ?? {}), providerId: r.providerId },
        observation: {
          runtime: "local_app",
          providerId: r.providerId,
          bridgeResponseId: eventId ?? undefined,
          raw: r.data,
        },
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
        return {
          success: true,
          output: `Reminder created: "${input.title}"${input.due_date ? ` (due ${input.due_date})` : ""}`,
          // Apple Reminders AppleScript doesn't return an id; we set
          // bridgeResponseId to a synthetic marker so reminder_exists
          // verifier knows the bridge round-trip didn't error out.
          observation: {
            runtime: "local_app",
            providerId: "apple-reminders",
            bridgeResponseId: `applescript:${input.title.slice(0, 40)}`,
          },
        };
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

  // ═══ Per-agent SEARCHABLE memory ═══════════════════════════════════════
  // Unlike agent_state_get/set (exact-key KV) and record_outcome (global
  // pool), these two give the agent an FTS-indexed scratchpad scoped to
  // itself. Essential for long-horizon runs: agent can "remember this
  // finding" mid-run, and compaction can elide the tool output knowing
  // the summary was persisted here.

  registerTool({
    name: "memory_remember",
    description: "Save a fact, finding, or decision to your own persistent memory. Use when you discover something mid-run that you'll want to reference later — either in a future turn (after context compaction) or a future run of this same agent. Prefer 1-3 sentences over dumping raw data.",
    handler: "db",
    actionClass: "write_memory",
    inputSchema: {
      type: "object",
      properties: {
        title:   { type: "string", description: "Short descriptor (under 80 chars)" },
        content: { type: "string", description: "The fact/finding itself (1-3 sentences ideal; max 4KB)" },
        tags:    { type: "array", items: { type: "string" }, description: "Optional keywords for later retrieval" },
      },
      required: ["title", "content"],
    },
    execute: (input, ctx): ToolResult => {
      const agentId = ctx?.agentId;
      if (!agentId) return { success: false, output: "memory_remember only callable from custom agents", error: "NO_AGENT_CONTEXT" };
      if (input.content.length > 4096) return { success: false, output: "Content exceeds 4KB limit — summarize first", error: "CONTENT_TOO_LARGE" };

      const tagList = Array.isArray(input.tags) ? input.tags : [];
      const memId = writeMemory({
        type: "semantic",
        title: input.title.slice(0, 120),
        content: input.content,
        tags: [...tagList, `agent:${agentId}`],
        source: `agent:${agentId}`,
        confidence: 0.85,
      });
      return { success: true, output: `Remembered: ${input.title}`, data: { memoryId: memId } };
    },
  });

  registerTool({
    name: "memory_recall",
    description: "Search your own memory (things you remembered in prior turns or prior runs of this agent). Returns up to 5 matches ranked by relevance.",
    handler: "db",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or phrase to search for" },
        limit: { type: "number", description: "Max matches (default 5, max 10)" },
      },
      required: ["query"],
    },
    execute: (input, ctx): ToolResult => {
      const agentId = ctx?.agentId;
      if (!agentId) return { success: false, output: "memory_recall only callable from custom agents", error: "NO_AGENT_CONTEXT" };
      const limit = Math.min(10, Math.max(1, input.limit ?? 5));
      // FTS5 MATCH — scope via source filter. FTS handles keyword tokenization;
      // we simply pass through the query after minimal sanitization.
      const safeQuery = String(input.query).replace(/"/g, " ").trim();
      if (!safeQuery) return { success: false, output: "empty query", error: "BAD_QUERY" };
      let rows: any[] = [];
      try {
        rows = db.prepare(
          `SELECT m.title, m.content, m.created_at
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.source = ?
           ORDER BY rank LIMIT ?`
        ).all(safeQuery, `agent:${agentId}`, limit);
      } catch {
        // Fall back to LIKE if FTS syntax rejects the query
        rows = db.prepare(
          `SELECT title, content, created_at FROM memories
           WHERE source=? AND (title LIKE ? OR content LIKE ?)
           ORDER BY created_at DESC LIMIT ?`
        ).all(`agent:${agentId}`, `%${safeQuery}%`, `%${safeQuery}%`, limit);
      }
      if (rows.length === 0) return { success: true, output: "(no matching memories)", data: { matches: [] } };
      const out = rows.map((r: any) => `• [${r.created_at.slice(0, 10)}] ${r.title}: ${r.content.slice(0, 240)}${r.content.length > 240 ? "…" : ""}`).join("\n");
      return { success: true, output: out, data: { matches: rows } };
    },
  });

  // ═══ Interrupt — agent-initiated pause for HITL ═══════════════════════
  // The tool itself just returns a sentinel in its output. The ReAct loop
  // detects the INTERRUPT_REQUESTED marker on tool_result and exits
  // cleanly, persisting the question to agent_runs. User resumes via
  // POST /api/runs/:id/resume with their reply.

  registerTool({
    name: "request_user_input",
    description: "Pause execution and ask the user a specific question. Use BEFORE destructive or high-stakes actions (sending important emails, scheduling with real people, spending money, publishing content) or when context is genuinely ambiguous and guessing would be worse than asking. The run halts, the user sees your question, and when they reply you resume with their answer as a new message.",
    handler: "db",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to show the user (1-2 sentences ideal)" },
        context:  { type: "string", description: "Optional: brief context for why you're asking (what you're about to do)" },
      },
      required: ["question"],
    },
    execute: (input): ToolResult => {
      const question = String(input.question ?? "").trim();
      if (!question) return { success: false, output: "question required", error: "BAD_INPUT" };
      const context = String(input.context ?? "").trim();
      // The sentinel + marker are parsed by custom-agent-react.ts after the
      // tool dispatch loop. Use a unique token to avoid false positives.
      return {
        success: true,
        output: `__ANCHOR_INTERRUPT__ ${question}${context ? ` || context: ${context}` : ""}`,
        data: { interrupt: true, question, context },
      };
    },
  });

  // ═══ Agent Composition — delegate (Claude Code-style subagent) ═════════
  // (registered below via registerDelegateTool — replaces old call_agent)

  // Register tools from dedicated files (subprocess execute_code + subagent delegate + peer handoff)
  registerExecuteCodeTool();
  registerDelegateTool();
  registerHandoffTool();

  console.log(`[Execution] 16 tools registered (3 DB + 4 shell + 2 network + 1 execute_code + 2 agent_state + 2 memory + 1 delegate + 1 handoff)`);
}
