/**
 * Bridge initialization — wire capabilities and providers into the registry.
 * Called once at server startup from server/index.ts.
 */
import { registerCapability, registerProvider } from "./registry.js";
import { ALL_CAPABILITIES } from "./capabilities/index.js";

// CLI providers
import { gmailRestProvider } from "./providers/cli/gmail-rest.js";
import { appleMailShortcutsProvider } from "./providers/cli/shortcuts-cli.js";
import { playwrightCliProvider } from "./providers/cli/playwright-cli.js";
import { claudeCliProvider } from "./providers/cli/claude-cli.js";

// MCP providers (stateful, long-running subprocess + JSON-RPC)
import { claudeCodeMcpProvider, shutdownClaudeCodeMcp } from "./providers/mcp/claude-code-mcp.js";
import { playwrightMcpProvider, shutdownPlaywrightMcp } from "./providers/mcp/playwright-mcp.js";

export function initBridges(): void {
  // 1. Register all capabilities
  for (const cap of ALL_CAPABILITIES) registerCapability(cap);

  // 2. Register CLI providers (token-efficient, stateless)
  registerProvider(gmailRestProvider);
  registerProvider(appleMailShortcutsProvider);
  registerProvider(playwrightCliProvider);
  registerProvider(claudeCliProvider);

  // 3. Register MCP providers (stateful sessions)
  registerProvider(claudeCodeMcpProvider);
  registerProvider(playwrightMcpProvider);

  const cli = 4, mcp = 2;
  console.log(`🌉 Bridges initialized — ${ALL_CAPABILITIES.length} capabilities × ${cli + mcp} providers (${cli} CLI + ${mcp} MCP)`);

  // Graceful shutdown: kill long-lived MCP subprocesses
  const shutdown = () => {
    shutdownClaudeCodeMcp();
    shutdownPlaywrightMcp();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
