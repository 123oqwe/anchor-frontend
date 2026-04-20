/**
 * L8 Infrastructure — Hand Runtime.
 *
 * Responsibility: initialize the bridge (capabilities + providers) and expose
 * the browser/delegate tools to the L5 registry as thin shims that dispatch
 * through the bridge.
 *
 * Prior design (pre-bridge) had a 5-tool Playwright library registered here.
 * That's now superseded by CLI + MCP providers behind `browser.navigate` and
 * `browser.session` capabilities. Tool names are preserved for backward compat.
 */
import { registerTool, type ToolResult } from "../../execution/registry.js";
import { initBridges } from "../../bridges/init.js";
import { getProviders, getCapabilities } from "../../bridges/registry.js";

export async function initHand(): Promise<void> {
  // 1. Register all capabilities + providers
  initBridges();

  // 2. Expose bridge capabilities as L5 tools (thin shim)
  registerBridgeTools();

  console.log("✋ Hand ready: " + getCapabilities().length + " capabilities, " + getProviders().length + " providers");
}

function registerBridgeTools(): void {
  // ── Browser (stateless, CLI-preferred) ────────────────────────────────────
  registerTool({
    name: "browser_navigate",
    description: "Navigate to a URL and return title + text. Stateless — dispatches to Playwright CLI.",
    handler: "browser",
    actionClass: "browser_action",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        selector: { type: "string", description: "Optional CSS selector to extract text from" },
        maxChars: { type: "number", description: "Max chars of text to return (default 3000)" },
      },
      required: ["url"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const { dispatchCapability } = await import("../../bridges/registry.js");
      const r = await dispatchCapability("browser.navigate", input, ctx);
      return {
        success: r.success,
        output: r.output,
        error: r.error,
        data: { ...(r.data ?? {}), providerId: r.providerId },
      };
    },
  });

  registerTool({
    name: "browser_screenshot",
    description: "Take a screenshot of a URL (returns base64). Stateless.",
    handler: "browser",
    actionClass: "browser_action",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to capture" } },
      required: ["url"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const { dispatchCapability } = await import("../../bridges/registry.js");
      const r = await dispatchCapability("browser.navigate", { ...input, screenshot: true }, ctx);
      return {
        success: r.success,
        output: r.success ? `Screenshot captured (${Math.round(((r.data as any)?.screenshotBase64?.length ?? 0) / 1024)}KB)` : r.output,
        error: r.error,
        data: { ...(r.data ?? {}), providerId: r.providerId },
      };
    },
  });

  // ── Browser stateful (MCP, for login flows) ───────────────────────────────
  registerTool({
    name: "browser_session",
    description: "Stateful browser interaction (login session persists). Action: navigate|click|fill|extract|screenshot. Uses Playwright MCP.",
    handler: "browser",
    actionClass: "browser_action",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "fill", "extract", "screenshot"] },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const { dispatchCapability } = await import("../../bridges/registry.js");
      const r = await dispatchCapability("browser.session", input, ctx);
      return {
        success: r.success, output: r.output, error: r.error,
        data: { ...(r.data ?? {}), providerId: r.providerId },
      };
    },
  });

  // ── Dev delegate ──────────────────────────────────────────────────────────
  registerTool({
    name: "delegate_to_claude_code",
    description: "Delegate a dev task to Claude Code. Dispatches to CLI (claude -p) or MCP (claude mcp serve) based on preference.",
    handler: "api",
    actionClass: "delegate_agent",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task in plain English" },
        workingDir: { type: "string", description: "Working directory" },
        effort: { type: "string", enum: ["low", "medium", "high"] },
        maxBudgetUsd: { type: "number" },
      },
      required: ["task"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const { dispatchCapability } = await import("../../bridges/registry.js");
      const r = await dispatchCapability("dev.delegate", input, ctx);
      return {
        success: r.success, output: r.output, error: r.error,
        data: { ...(r.data ?? {}), providerId: r.providerId },
      };
    },
  });
}

// Legacy export kept so old callers don't crash; the browser logic lives in bridge providers now.
export function isBrowserEnabled(): boolean {
  return true;  // always enabled via bridges (CLI/MCP providers self-gate via healthCheck)
}

export async function closeBrowser(): Promise<void> {
  // Handled by bridge MCP provider lifecycle on SIGTERM
}

export function getHandStatus() {
  const caps = getCapabilities();
  const provs = getProviders();
  return {
    capabilities: caps.length,
    providers: {
      total: provs.length,
      cli: provs.filter(p => p.kind === "cli").length,
      mcp: provs.filter(p => p.kind === "mcp").length,
    },
    browser: { enabled: true, via: "bridge (playwright-cli + playwright-mcp)" },
  };
}
