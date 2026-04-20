/**
 * Playwright MCP provider (kind: mcp).
 *
 * Spawns `npx --yes @playwright/mcp` and talks JSON-RPC 2.0 over stdio.
 * Stateful: the same browser page persists across tool calls, so login
 * cookies survive multi-step flows — the main reason to use MCP over CLI
 * here. For one-shot `navigate + extract`, the CLI provider is 4x cheaper
 * on tokens and is preferred; the dispatcher decides based on capability.
 *
 * Real path. No stub. First call may download the MCP server via npx.
 */
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { McpStdioClient } from "./stdio-client.js";
import { hasBinary } from "../cli/base.js";

interface BrowserSessionInput {
  action: "navigate" | "click" | "fill" | "extract" | "screenshot";
  url?: string;
  selector?: string;
  text?: string;
  toolName?: string;           // override — which MCP tool to dispatch
  arguments?: Record<string, any>;
}

interface BrowserSessionOutput {
  content: string;
  toolsAvailable: string[];
  toolUsed: string;
}

// Singleton session — stateful is the whole point
let client: McpStdioClient | null = null;
let cachedTools: { name: string; description?: string }[] | null = null;

function getClient(): McpStdioClient {
  if (!client || !client.isAlive()) {
    client = new McpStdioClient({
      command: "npx",
      args: ["--yes", "@playwright/mcp@latest"],
      idleTimeoutMs: 5 * 60_000,
      serverName: "playwright-mcp",
    });
  }
  return client;
}

/** Heuristic: find the best Playwright MCP tool for a given action. */
function pickTool(action: string, tools: { name: string }[]): string | undefined {
  const names = tools.map(t => t.name);
  switch (action) {
    case "navigate":   return names.find(n => /(^|_)(navigate|goto|open)(_|$)/i.test(n));
    case "click":      return names.find(n => /(^|_)click(_|$)/i.test(n));
    case "fill":       return names.find(n => /(^|_)(type|fill|press)(_|$)/i.test(n));
    case "extract":    return names.find(n => /(^|_)(snapshot|extract|read|get.*text)(_|$)/i.test(n));
    case "screenshot": return names.find(n => /(^|_)screenshot(_|$)/i.test(n));
    default: return undefined;
  }
}

export const playwrightMcpProvider: ProviderDef<BrowserSessionInput, BrowserSessionOutput> = {
  id: "playwright-mcp",
  kind: "mcp",
  capability: "browser.session",
  displayName: "Playwright MCP (stateful browser)",
  platforms: ["macos", "windows", "linux"],
  requires: { binary: "npx" },
  concurrency: "serial",           // single browser page, one call at a time
  lifecycle: { idleTimeoutMs: 5 * 60_000 },

  async healthCheck(): Promise<HealthStatus> {
    const has = await hasBinary("npx");
    if (!has) return { healthy: false, reason: "npx not on PATH", checkedAt: Date.now() };
    try {
      const c = getClient();
      if (!c.isAlive()) await c.start();
      const tools = await c.listTools();
      cachedTools = tools;
      return { healthy: true, checkedAt: Date.now() };
    } catch (err: any) {
      if (client) { client.close(); client = null; }
      return {
        healthy: false,
        reason: `Playwright MCP handshake failed: ${err.message?.slice(0, 150)}`,
        checkedAt: Date.now(),
      };
    }
  },

  async execute(input): Promise<ProviderResult<BrowserSessionOutput>> {
    try {
      const c = getClient();
      if (!c.isAlive()) await c.start();
      if (!cachedTools) cachedTools = await c.listTools();

      const toolName = input.toolName ?? pickTool(input.action, cachedTools);
      if (!toolName) {
        return {
          success: false,
          output: `No Playwright MCP tool matches action "${input.action}". Available: ${cachedTools.map(t => t.name).join(", ")}`,
          error: "NO_MATCHING_TOOL", errorKind: "terminal",
        };
      }

      // Build arguments heuristically (user can override with input.arguments)
      const args = input.arguments ?? buildArgs(input);

      const result = await c.callTool(toolName, args, 60_000);
      const text = result.content
        .map(c => c.type === "text" ? c.text ?? "" : `[${c.type}]`)
        .join("\n");

      if (result.isError) {
        return {
          success: false,
          output: `Playwright MCP tool ${toolName} error: ${text.slice(0, 300)}`,
          error: text, errorKind: "retryable",
        };
      }
      return {
        success: true,
        output: text.slice(0, 2000),
        data: {
          content: text,
          toolsAvailable: cachedTools.map(t => t.name),
          toolUsed: toolName,
        },
      };
    } catch (err: any) {
      if (client) { client.close(); client = null; cachedTools = null; }
      return {
        success: false,
        output: `Playwright MCP call failed: ${err.message}`,
        error: err.message, errorKind: "retryable",
      };
    }
  },
};

function buildArgs(input: BrowserSessionInput): Record<string, any> {
  const args: Record<string, any> = {};
  if (input.url) args.url = input.url;
  if (input.selector) args.selector = args.element = input.selector;
  if (input.text) args.text = args.value = input.text;
  return args;
}

export function shutdownPlaywrightMcp(): void {
  if (client) { client.close(); client = null; cachedTools = null; }
}
