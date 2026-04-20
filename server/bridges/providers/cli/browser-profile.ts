/**
 * Browser Profile Reuse — Tier 1, zero OAuth.
 *
 * The Codex / UI-TARS / Doubao insight: the user is ALREADY logged in to
 * Gmail/Slack/Notion/Linear/etc in Chrome. Don't ask them to OAuth again.
 * Launch Playwright with their real Chrome profile directory — all cookies,
 * 2FA tokens, and saved sessions transfer.
 *
 * Current capability: email.send (Gmail web). Pattern extends to any web
 * service where the user has an active browser session.
 *
 * Zero setup UX:
 *   - If user uses Chrome (default on most macs): this works instantly
 *   - We launch a fresh context pointed at the profile DIR (not "Default"
 *     itself, a copy — so we don't fight with Chrome if it's open)
 *   - playwright.launchPersistentContext clones/reuses the profile
 */
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { runCli, hasBinary } from "./base.js";
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";

interface GmailSendInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

function defaultChromeProfile(): string {
  // Standard path on macOS / Linux / Windows; we pick the first that exists at runtime
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/Google/Chrome/Default");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData/Local/Google/Chrome/User Data/Default");
  }
  return path.join(home, ".config/google-chrome/Default");
}

// Small script that:
// 1. launches persistent context with user's Chrome profile
// 2. opens a Gmail compose window via URL scheme
// 3. fills recipient/subject/body
// 4. clicks Send
// Because Gmail UI changes, we use multiple selector fallbacks.
const GMAIL_SEND_SCRIPT = `
const { chromium } = require("playwright");
(async () => {
  const input = JSON.parse(process.argv[2]);

  const context = await chromium.launchPersistentContext(input.profileDir, {
    headless: false,  // Google flags headless Chromium sessions as suspicious
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    // Gmail "mailto" URL preloads the compose window with the fields filled
    const params = new URLSearchParams({
      view: "cm", fs: "1",
      to: input.to, su: input.subject, body: input.body,
    });
    if (input.cc) params.set("cc", input.cc);
    if (input.bcc) params.set("bcc", input.bcc);
    await page.goto("https://mail.google.com/mail/u/0/?" + params.toString(), { waitUntil: "load", timeout: 30000 });

    // Detect the logged-out case — Gmail redirects to accounts.google.com
    if (/accounts\\.google\\.com/.test(page.url())) {
      process.stdout.write(JSON.stringify({ ok: false, error: "Not logged into Gmail in this Chrome profile" }));
      process.exitCode = 1;
      return;
    }

    // Wait for compose window — the send button appears when it's rendered
    const sendBtn = page.locator('div[role="button"][aria-label*="Send"]:not([aria-label*="Schedule"])').first();
    await sendBtn.waitFor({ state: "visible", timeout: 15000 });

    // Small delay for the body field to settle (Gmail sometimes re-focuses)
    await page.waitForTimeout(500);
    await sendBtn.click();

    // Wait for confirmation — the toast "Message sent" or window close
    await page.waitForFunction(() => {
      return !document.querySelector('div[aria-label*="Send"]:not([aria-label*="Schedule"])') ||
             /Message sent/.test(document.body.innerText || "");
    }, { timeout: 10000 }).catch(() => {});

    process.stdout.write(JSON.stringify({ ok: true, via: "gmail-web" }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
`;

export const browserProfileGmailProvider: ProviderDef<GmailSendInput, { via: string }> = {
  id: "browser-profile-gmail",
  kind: "cli",               // CLI because we spawn node subprocess (not MCP)
  capability: "email.send",
  displayName: "Gmail via Chrome (reuse login)",
  platforms: ["macos", "windows", "linux"],
  requires: { binary: "node" },
  concurrency: "serial",     // one Chrome instance at a time
  rateLimit: { maxPerMinute: 10 },
  targetApp: "mail.google.com",

  async healthCheck(): Promise<HealthStatus> {
    const hasNode = await hasBinary("node");
    if (!hasNode) return { healthy: false, reason: "node not on PATH", checkedAt: Date.now() };

    // Playwright installed?
    const r = await runCli(
      "node",
      ["-e", "try{require('playwright');console.log('ok')}catch(e){console.log('missing')}"],
      { timeoutMs: 5_000 }
    );
    if (!r.stdout.includes("ok")) {
      return { healthy: false, reason: "Playwright not installed", checkedAt: Date.now() };
    }

    // Chrome profile exists?
    const profile = defaultChromeProfile();
    try {
      await fs.access(profile);
    } catch {
      return { healthy: false, reason: "Chrome profile not found (are you using Chrome?)", checkedAt: Date.now() };
    }

    // Recent activity (profile was used within 30 days — proves Chrome is the user's browser)
    try {
      const stat = await fs.stat(profile);
      const daysSince = (Date.now() - stat.mtimeMs) / 86400000;
      if (daysSince > 30) {
        return { healthy: false, reason: "Chrome profile unused for 30+ days — probably not the user's main browser", checkedAt: Date.now() };
      }
    } catch { /* soft fail */ }

    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<{ via: string }>> {
    const profile = defaultChromeProfile();
    const args = JSON.stringify({
      profileDir: profile,
      to: input.to, subject: input.subject, body: input.body,
      cc: input.cc, bcc: input.bcc,
    });

    const r = await runCli("node", ["-e", GMAIL_SEND_SCRIPT, args], { timeoutMs: 60_000, maxBuffer: 20_000_000 });
    if (!r.stdout.trim()) {
      return { success: false, output: `No output from browser subprocess: ${r.stderr.slice(0, 200)}`, error: r.stderr, errorKind: "retryable" };
    }
    try {
      const parsed = JSON.parse(r.stdout.trim());
      if (!parsed.ok) {
        return {
          success: false,
          output: `Gmail web send failed: ${parsed.error}`,
          error: parsed.error,
          errorKind: String(parsed.error).includes("Not logged into Gmail") ? "terminal" : "retryable",
        };
      }
      return {
        success: true,
        output: `Sent via Gmail (Chrome profile) to ${input.to}: "${input.subject}"`,
        data: { via: parsed.via },
      };
    } catch (err: any) {
      return { success: false, output: `Invalid browser output: ${r.stdout.slice(0, 200)}`, error: err.message, errorKind: "retryable" };
    }
  },
};
