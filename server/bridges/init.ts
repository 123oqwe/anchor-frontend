/**
 * Bridge initialization — wire capabilities and providers into the registry.
 * Called once at server startup from server/index.ts.
 */
import { registerCapability, registerProvider } from "./registry.js";
import { ALL_CAPABILITIES } from "./capabilities/index.js";

// CLI providers
// Tier 0 — already-logged-in native apps (zero setup on macOS)
import { appleMailAppleScriptProvider } from "./providers/cli/applemail-applescript.js";
import { appleCalendarAppleScriptProvider } from "./providers/cli/applecalendar-applescript.js";

// Tier 1 — already-logged-in browser profile
import { browserProfileGmailProvider } from "./providers/cli/browser-profile.js";

// Tier 3 — OAuth / Shortcuts / API providers (require user to click Connect)
import { gmailRestProvider } from "./providers/cli/gmail-rest.js";
import { gcalRestProvider } from "./providers/cli/gcal-rest.js";
import { appleMailShortcutsProvider } from "./providers/cli/shortcuts-cli.js";
import { playwrightCliProvider } from "./providers/cli/playwright-cli.js";
import { claudeCliProvider } from "./providers/cli/claude-cli.js";

// MCP providers (stateful, long-running subprocess + JSON-RPC)
import { claudeCodeMcpProvider, shutdownClaudeCodeMcp } from "./providers/mcp/claude-code-mcp.js";
import { playwrightMcpProvider, shutdownPlaywrightMcp } from "./providers/mcp/playwright-mcp.js";

// Vision providers (Tier 3 fallback — screenshot + VLM + action)
import { playwrightVisionProvider } from "./providers/vision/playwright-vision.js";
import { macosVisionProvider } from "./providers/vision/macos-vision.js";

export function initBridges(): void {
  // 1. Register all capabilities
  for (const cap of ALL_CAPABILITIES) registerCapability(cap);

  // 2a. Tier 0 — already-logged-in native apps (zero setup)
  registerProvider(appleMailAppleScriptProvider);
  registerProvider(appleCalendarAppleScriptProvider);

  // 2b. Tier 1 — already-logged-in browser profile
  registerProvider(browserProfileGmailProvider);

  // 2c. Tier 3 — OAuth / Shortcuts / API (user-facing Connect button)
  registerProvider(gmailRestProvider);
  registerProvider(gcalRestProvider);
  registerProvider(appleMailShortcutsProvider);
  registerProvider(playwrightCliProvider);
  registerProvider(claudeCliProvider);

  // 3. Register MCP providers (Tier 2 — stateful JSON-RPC sessions)
  registerProvider(claudeCodeMcpProvider);
  registerProvider(playwrightMcpProvider);

  // 4. Register Vision providers (Tier 3 — Codex/Doubao-style GUI fallback)
  registerProvider(playwrightVisionProvider);
  registerProvider(macosVisionProvider);

  const cli = 8, mcp = 2, vis = 2;
  console.log(`🌉 Bridges initialized — ${ALL_CAPABILITIES.length} capabilities × ${cli + mcp + vis} providers (${cli} CLI + ${mcp} MCP + ${vis} Vision)`);
  console.log(`   Tier 0 (zero-setup native): apple-mail, apple-calendar`);
  console.log(`   Tier 1 (browser profile): gmail-via-chrome`);
  console.log(`   Tier 3 (OAuth/API):       gmail-rest, gcal-rest, shortcuts, playwright-cli, claude-cli, claude-code-mcp, playwright-mcp`);
  console.log(`   Tier 4 (vision fallback): playwright-vision, macos-vision`);

  // Graceful shutdown: kill long-lived MCP subprocesses
  const shutdown = () => {
    shutdownClaudeCodeMcp();
    shutdownPlaywrightMcp();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
