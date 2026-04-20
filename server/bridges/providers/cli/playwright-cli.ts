/**
 * Playwright CLI provider (kind: cli — stateless, token-efficient).
 *
 * 2026 data: Playwright CLI is ~4x more token-efficient than Playwright MCP
 * for one-shot browser tasks (navigate + extract). Microsoft shipped
 * @playwright/cli as a companion to the MCP server precisely for this reason.
 *
 * Real path: spawns `npx --yes playwright` subprocess per call. No long-lived
 * browser. Suitable for: fetch a page and extract text, take a screenshot,
 * one-off click + read. Not suitable for: login sessions (use playwright-mcp).
 *
 * Shim strategy: since `@playwright/cli` exposes CDP-style commands, we use
 * the more stable path of piping a short Node script into `node` with
 * `playwright` available via npx runtime. This works as long as the user
 * can run `npx --yes playwright` (network fetch on first use).
 */
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { runCli, hasBinary } from "./base.js";

interface BrowserNavigateInput {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  selector?: string;          // optional — extract text from this selector
  screenshot?: boolean;       // optional — return base64 png
  maxChars?: number;
}

interface BrowserNavigateOutput {
  title: string;
  url: string;
  text?: string;
  screenshotBase64?: string;
}

const SCRIPT = `
const { chromium } = require("playwright");

(async () => {
  const input = JSON.parse(process.argv[2]);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(input.url, { timeout: 20000, waitUntil: input.waitUntil || "domcontentloaded" });
    const title = await page.title();
    let text = undefined;
    if (input.selector) {
      const elements = await page.$$(input.selector);
      const parts = [];
      for (const el of elements.slice(0, 20)) {
        const t = await el.innerText().catch(() => "");
        if (t) parts.push(t);
      }
      text = parts.join("\\n---\\n");
    } else {
      text = await page.innerText("body").catch(() => "");
    }
    const maxChars = input.maxChars || 3000;
    if (text && text.length > maxChars) text = text.slice(0, maxChars) + "…[truncated]";

    let screenshotBase64 = undefined;
    if (input.screenshot) {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      screenshotBase64 = buf.toString("base64");
    }
    process.stdout.write(JSON.stringify({ ok: true, title, url: page.url(), text, screenshotBase64 }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
`;

export const playwrightCliProvider: ProviderDef<BrowserNavigateInput, BrowserNavigateOutput> = {
  id: "playwright-cli",
  kind: "cli",
  capability: "browser.navigate",
  displayName: "Playwright CLI (headless)",
  platforms: ["macos", "windows", "linux"],
  requires: { binary: "npx" },
  concurrency: "parallel",   // each call spawns its own browser

  async healthCheck(): Promise<HealthStatus> {
    const has = await hasBinary("npx");
    if (!has) return { healthy: false, reason: "npx not on PATH", checkedAt: Date.now() };
    // Probe: `npx --yes playwright --version` is cheap and a proxy for install.
    // If playwright isn't in node_modules, npx will attempt a network fetch; we
    // time-box that so health stays snappy.
    const r = await runCli("npx", ["--yes", "playwright", "--version"], { timeoutMs: 15_000 });
    if (r.exitCode !== 0) {
      return {
        healthy: false,
        reason: "Playwright not available (run `npm i playwright && npx playwright install chromium`)",
        checkedAt: Date.now(),
      };
    }
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<BrowserNavigateOutput>> {
    const r = await runCli(
      "npx",
      ["--yes", "playwright", "node", "-e", SCRIPT, JSON.stringify(input)],
      { timeoutMs: 60_000, maxBuffer: 20_000_000 }
    );
    // If --yes playwright+node chain fails, fall back to bare node with env
    // resolution via local node_modules. We invoke `node -e` directly using the
    // user's node with playwright resolved from npx's temp install if needed.
    if (r.exitCode !== 0 || !r.stdout.trim()) {
      const alt = await runCli("node", ["-e", SCRIPT, JSON.stringify(input)], { timeoutMs: 60_000, maxBuffer: 20_000_000 });
      if (alt.exitCode !== 0 || !alt.stdout.trim()) {
        return {
          success: false,
          output: `Playwright CLI failed: ${r.stderr.slice(0, 200) || alt.stderr.slice(0, 200) || "no output"}`,
          error: r.stderr || alt.stderr,
          errorKind: "retryable",
        };
      }
      return parseResult(alt.stdout);
    }
    return parseResult(r.stdout);
  },
};

function parseResult(stdout: string): ProviderResult<BrowserNavigateOutput> {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (!parsed.ok) {
      return { success: false, output: `Navigation failed: ${parsed.error}`, error: parsed.error, errorKind: "retryable" };
    }
    return {
      success: true,
      output: `${parsed.title}\n\n${(parsed.text ?? "").slice(0, 500)}`,
      data: {
        title: parsed.title, url: parsed.url, text: parsed.text,
        screenshotBase64: parsed.screenshotBase64,
      },
    };
  } catch (err: any) {
    return { success: false, output: `Invalid JSON from Playwright: ${stdout.slice(0, 200)}`, error: err.message, errorKind: "retryable" };
  }
}
