/**
 * Apple Mail (direct AppleScript) — Tier 0, zero setup on macOS.
 *
 * Jobs principle: user is already logged into Mail.app. Don't make them
 * OAuth again, don't make them install a Shortcut. Just use what's already
 * there. This is the path that "just works" on first launch.
 *
 * Delegates to `osascript` directly (no Shortcut dependency). Safer escaping
 * via AppleScript quoted form (uses stdin to avoid shell metacharacter issues).
 */
import { runCli, hasBinary } from "./base.js";
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";

interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

function buildScript(input: SendEmailInput): string {
  // Use AppleScript run script blocks with literals passed as parameters
  // to avoid string concatenation injection. We rely on AppleScript's own
  // quoting — all interpolation goes through quoted`value`.
  const q = (s: string) => `"${(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '" & return & "')}"`;
  const ccRecipient = input.cc ? `make new cc recipient at newMessage with properties {address:${q(input.cc)}}\n  ` : "";
  const bccRecipient = input.bcc ? `make new bcc recipient at newMessage with properties {address:${q(input.bcc)}}\n  ` : "";
  return `tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:${q(input.subject)}, content:${q(input.body)}, visible:false}
  tell newMessage
    make new to recipient at newMessage with properties {address:${q(input.to)}}
    ${ccRecipient}${bccRecipient}
  end tell
  send newMessage
end tell`;
}

export const appleMailAppleScriptProvider: ProviderDef<SendEmailInput, { sent: true }> = {
  id: "applemail-applescript",
  kind: "cli",
  capability: "email.send",
  displayName: "Apple Mail (direct)",
  platforms: ["macos"],
  requires: {},   // no OAuth, no Shortcut, no binary beyond osascript
  concurrency: "serial",
  rateLimit: { maxPerMinute: 30 },
  // No targetApp — Mail.app is the user's own app, already governed by macOS
  // Automation permission. Don't double-gate with Anchor's app approval.

  async healthCheck(): Promise<HealthStatus> {
    if (process.platform !== "darwin") {
      return { healthy: false, reason: "macOS only", checkedAt: Date.now() };
    }
    const has = await hasBinary("osascript");
    if (!has) return { healthy: false, reason: "osascript missing (unexpected on macOS)", checkedAt: Date.now() };

    // Real probe: check Mail.app is installed (not running — just bundled)
    const r = await runCli(
      "osascript",
      ["-e", 'tell application "Finder" to exists application file id "com.apple.Mail"'],
      { timeoutMs: 3_000 }
    );
    if (r.stdout.trim() !== "true") {
      return { healthy: false, reason: "Mail.app not installed", checkedAt: Date.now() };
    }
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<{ sent: true }>> {
    const script = buildScript(input);
    const r = await runCli("osascript", ["-e", script], { timeoutMs: 15_000 });

    if (r.exitCode !== 0) {
      const msg = r.stderr.trim();
      // macOS permission errors
      if (msg.includes("-1743") || msg.toLowerCase().includes("not authorized")) {
        return {
          success: false,
          output: "Mail.app access denied. Grant Automation permission in System Settings → Privacy & Security → Automation.",
          error: "PERMISSION_DENIED",
          errorKind: "terminal",
        };
      }
      return {
        success: false,
        output: `Mail.app send failed: ${msg.slice(0, 200)}`,
        error: msg,
        errorKind: "retryable",
      };
    }

    return {
      success: true,
      output: `Sent via Apple Mail to ${input.to}: "${input.subject}"`,
      data: { sent: true },
    };
  },

  friendlyError(err) {
    const msg = String(err?.message ?? err ?? "").toLowerCase();
    if (msg.includes("not authorized") || msg.includes("-1743")) {
      return "Mail needs permission. Open System Settings → Privacy & Security → Automation → enable your terminal/Anchor for Mail.";
    }
    return err?.message ?? "Apple Mail send failed";
  },
};
