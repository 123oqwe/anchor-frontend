/**
 * L5 Execution — Built-in tools.
 *
 * Registers all internal tools via the unified registry.
 * 8 tools: 3 DB tools (original) + 5 new capability tools.
 * All tools have the same ToolDef shape — LLM doesn't distinguish handler type.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { bus } from "../orchestration/bus.js";
import { nanoid } from "nanoid";
import { writeMemory } from "../memory/retrieval.js";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── Register all tools on startup ───────────────────────────────────────────

export function registerBuiltinTools(): void {

  // ── DB Tools (original 3) ─────────────────────────────────────────

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
      if (!project) return { success: false, output: "No project found", error: "NO_PROJECT" };
      const taskId = nanoid();
      db.prepare("INSERT INTO tasks (id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?)")
        .run(taskId, project.id, input.title, "todo", input.priority ?? "high", JSON.stringify(["auto", "react"]));
      return {
        success: true,
        output: `Task "${input.title}" created (${input.priority ?? "high"}).`,
        data: { taskId },
        rollback: () => { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); },
        verifiable: true,
        verifyFn: async () => !!(db.prepare("SELECT id FROM tasks WHERE id=?").get(taskId)),
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
      return { success: true, output: `"${node.label}": ${oldStatus} → ${input.new_status}.`, data: { nodeId: node.id, oldStatus } };
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
      return { success: true, output: "Outcome recorded to memory.", data: { memoryId: memId } };
    },
  });

  // ── API Tools (new) ───────────────────────────────────────────────

  registerTool({
    name: "web_search",
    description: "Search the web for current information. Returns search results summary.",
    handler: "api",
    actionClass: "read_memory",  // read-only, no side effects
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async (input): Promise<ToolResult> => {
      // Placeholder — will connect to Tavily/Perplexity when API key is added
      return {
        success: false,
        output: "Web search not yet configured. Add TAVILY_API_KEY or PERPLEXITY_API_KEY to enable.",
        error: "NOT_CONFIGURED",
      };
    },
  });

  registerTool({
    name: "send_email",
    description: "Send an email to a contact. Requires recipient, subject, and body.",
    handler: "api",
    actionClass: "send_external",  // HIGH risk — requires confirmation
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
    execute: async (input): Promise<ToolResult> => {
      // Placeholder — will connect to SendGrid/Resend when configured
      return {
        success: false,
        output: "Email sending not yet configured. Add SENDGRID_API_KEY to enable.",
        error: "NOT_CONFIGURED",
      };
    },
  });

  registerTool({
    name: "read_url",
    description: "Fetch and read the content of a web page. Returns text content.",
    handler: "api",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
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
        // Strip HTML tags for clean text
        const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
        return { success: true, output: clean, data: { url: input.url, length: clean.length } };
      } catch (err: any) {
        return { success: false, output: `Fetch failed: ${err.message}`, error: err.message, shouldRetry: true };
      }
    },
  });

  registerTool({
    name: "run_code",
    description: "Execute a JavaScript code snippet. The code must RETURN a value (not console.log). Example: '15000 * 6' returns 90000.",
    handler: "code",
    actionClass: "write_memory",  // code execution is a side effect
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["javascript"], description: "Programming language" },
        code: { type: "string", description: "Code to execute" },
      },
      required: ["code"],
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        let code = (input.code ?? "").trim();
        const forbidden = ["require", "import", "process", "fs", "child_process", "exec", "spawn"];
        for (const f of forbidden) {
          if (code.includes(f)) return { success: false, output: `Forbidden: "${f}" not allowed`, error: "SANDBOX_VIOLATION" };
        }
        // Strip console.log wrapper if present
        code = code.replace(/^console\.log\((.+)\);?$/, "$1");
        // Strip leading "return " if present (sandbox adds it)
        code = code.replace(/^return\s+/, "");
        // Support both expressions and multi-statement code blocks
        const isMultiStatement = code.includes("const ") || code.includes("let ") || code.includes("var ") || code.includes(";");
        const wrapped = isMultiStatement
          ? `"use strict"; ${code}` // multi-statement
          : `"use strict"; return (${code})`; // single expression
        const fn = new Function(wrapped);
        const result = fn();
        const output = result === undefined
          ? "(executed, no return value)"
          : typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
        return { success: true, output: output.slice(0, 2000), data: { result } };
      } catch (err: any) {
        return { success: false, output: `Code error: ${err.message}`, error: err.message };
      }
    },
  });

  registerTool({
    name: "create_calendar_event",
    description: "Create a calendar event with title, date, time, and optional attendees.",
    handler: "api",
    actionClass: "modify_calendar",  // medium risk
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Date (YYYY-MM-DD)" },
        time: { type: "string", description: "Start time (HH:MM)" },
        duration_minutes: { type: "number", description: "Duration in minutes" },
        attendees: { type: "string", description: "Comma-separated email addresses" },
      },
      required: ["title", "date"],
    },
    execute: async (input): Promise<ToolResult> => {
      // Placeholder — will connect to Google Calendar when configured
      return {
        success: false,
        output: "Calendar not yet configured. Add GOOGLE_CALENDAR_CREDENTIALS to enable.",
        error: "NOT_CONFIGURED",
      };
    },
  });

  console.log(`[Execution] 8 tools registered`);
}
