/**
 * Claude Code MCP provider (kind: mcp).
 *
 * Spawns `claude mcp serve` — Claude Code's built-in MCP server mode — and
 * talks JSON-RPC 2.0 over stdio. Stateful session: the same Claude process
 * handles multiple delegated tasks within one run, maintaining subagent +
 * skills context that the one-shot CLI provider can't.
 *
 * This is the real path. No shims.
 */
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { McpStdioClient } from "./stdio-client.js";
import { hasBinary } from "../cli/base.js";

interface DevDelegateInput {
  task: string;
  toolName?: string;                // which Claude Code MCP tool to call (default: first)
  arguments?: Record<string, any>;
}

interface DevDelegateOutput {
  text: string;
  isError: boolean;
  toolsAvailable: string[];
}

// Singleton client — Claude Code MCP server is expensive to start; keep it warm
let client: McpStdioClient | null = null;
let cachedTools: string[] | null = null;

function getClient(): McpStdioClient {
  if (!client || !client.isAlive()) {
    client = new McpStdioClient({
      command: "claude",
      args: ["mcp", "serve"],
      idleTimeoutMs: 10 * 60_000,   // keep warm 10min
      serverName: "claude-code",
    });
  }
  return client;
}

export const claudeCodeMcpProvider: ProviderDef<DevDelegateInput, DevDelegateOutput> = {
  id: "claude-code-mcp",
  kind: "mcp",
  capability: "dev.delegate",
  displayName: "Claude Code (MCP stateful)",
  platforms: ["macos", "windows", "linux"],
  requires: { binary: "claude" },
  concurrency: "serial",                 // one stdio process, one active request
  lifecycle: { idleTimeoutMs: 10 * 60_000 },

  async healthCheck(): Promise<HealthStatus> {
    const has = await hasBinary("claude");
    if (!has) {
      return { healthy: false, reason: "`claude` not on PATH", checkedAt: Date.now() };
    }
    // Try starting the server and listing tools — real handshake
    try {
      const c = getClient();
      if (!c.isAlive()) await c.start();
      const tools = await c.listTools();
      cachedTools = tools.map(t => t.name);
      return { healthy: true, checkedAt: Date.now() };
    } catch (err: any) {
      // Close bad client so next attempt starts fresh
      if (client) { client.close(); client = null; }
      return {
        healthy: false,
        reason: `MCP handshake failed: ${err.message?.slice(0, 150)}`,
        checkedAt: Date.now(),
      };
    }
  },

  async execute(input): Promise<ProviderResult<DevDelegateOutput>> {
    try {
      const c = getClient();
      if (!c.isAlive()) await c.start();

      // Discover tools if we haven't cached them
      if (!cachedTools) {
        const tools = await c.listTools();
        cachedTools = tools.map(t => t.name);
      }

      // Pick the tool: user-specified or first available
      const toolName = input.toolName ?? cachedTools[0];
      if (!toolName) {
        return {
          success: false,
          output: "Claude Code MCP server exposed no tools",
          error: "NO_TOOLS", errorKind: "terminal",
        };
      }

      // Default arguments: pass the task as a prompt-style argument
      const args = input.arguments ?? { task: input.task, prompt: input.task };

      const result = await c.callTool(toolName, args);
      const text = result.content
        .map(c => c.type === "text" ? c.text ?? "" : `[${c.type}]`)
        .join("\n");

      if (result.isError) {
        return {
          success: false,
          output: `Tool ${toolName} returned error: ${text.slice(0, 400)}`,
          error: text, errorKind: "retryable",
        };
      }
      return {
        success: true,
        output: text.slice(0, 2000),
        data: { text, isError: false, toolsAvailable: cachedTools },
      };
    } catch (err: any) {
      // If transport died, nuke the client so next call restarts
      if (client) { client.close(); client = null; }
      return {
        success: false,
        output: `Claude Code MCP call failed: ${err.message}`,
        error: err.message, errorKind: "retryable",
      };
    }
  },
};

export function shutdownClaudeCodeMcp(): void {
  if (client) { client.close(); client = null; cachedTools = null; }
}
