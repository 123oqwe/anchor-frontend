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

export function initBridges(): void {
  // 1. Register all capabilities
  for (const cap of ALL_CAPABILITIES) registerCapability(cap);

  // 2. Register CLI providers (token-efficient, stateless)
  registerProvider(gmailRestProvider);
  registerProvider(appleMailShortcutsProvider);
  registerProvider(playwrightCliProvider);
  registerProvider(claudeCliProvider);

  console.log("🌉 Bridges initialized — CLI track: " + ALL_CAPABILITIES.length + " capabilities × 4 CLI providers");
}
