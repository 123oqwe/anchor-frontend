/**
 * Playwright Vision provider (kind: vision — Tier 3 fallback for browser).
 *
 * The Codex "Action Hierarchy" fallback: when CSS selectors break (dynamic
 * SPA, shadow DOM, obfuscated classes), take a screenshot, ask Claude
 * Sonnet 4.6 Vision to find the target, click at the returned coordinates.
 *
 * Real path. No mocks. Uses Playwright library inline (spawned as subprocess
 * via a self-contained Node script, same pattern as playwright-cli.ts) —
 * the VLM is Anchor's existing Cortex vision() so it works with whichever
 * model provider the user has configured.
 */
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { runCli, hasBinary } from "../cli/base.js";
import { askVisionForAction, resolveCoords } from "./base.js";

interface BrowserVisionInput {
  url: string;
  task: string;                    // "Find the login button and click it" / "Extract the price"
  actionHint?: "click" | "extract" | "navigate";
  waitMs?: number;
}

interface BrowserVisionOutput {
  url: string;
  title: string;
  actionPlan: any;
  clicked?: { x: number; y: number };
  extracted?: string;
}

// Runs Playwright in a child node process, does (goto + screenshot + optional click-at-coords)
// All in one subprocess to avoid needing persistent state.
const PW_SCRIPT = `
const { chromium } = require("playwright");
(async () => {
  const input = JSON.parse(process.argv[2]);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(input.url, { timeout: 25000, waitUntil: "domcontentloaded" });
    if (input.waitMs) await page.waitForTimeout(input.waitMs);

    if (input.phase === "screenshot") {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      const title = await page.title();
      const viewport = page.viewportSize() || { width: 1280, height: 800 };
      process.stdout.write(JSON.stringify({ ok: true, title, url: page.url(), width: viewport.width, height: viewport.height, base64: buf.toString("base64") }));
      return;
    }

    if (input.phase === "click") {
      await page.mouse.click(input.x, input.y);
      await page.waitForTimeout(800);
      const title = await page.title();
      const bodyText = (await page.innerText("body").catch(() => "")).slice(0, 2000);
      process.stdout.write(JSON.stringify({ ok: true, title, url: page.url(), text: bodyText }));
      return;
    }

    process.stdout.write(JSON.stringify({ ok: false, error: "unknown phase" }));
    process.exitCode = 1;
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
`;

async function runPhase(phase: "screenshot" | "click", params: any): Promise<any> {
  const input = JSON.stringify({ phase, ...params });
  const r = await runCli("node", ["-e", PW_SCRIPT, input], { timeoutMs: 60_000, maxBuffer: 20_000_000 });
  if (!r.stdout.trim()) throw new Error(`Playwright subprocess no output: ${r.stderr.slice(0, 200)}`);
  const parsed = JSON.parse(r.stdout.trim());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

export const playwrightVisionProvider: ProviderDef<BrowserVisionInput, BrowserVisionOutput> = {
  id: "playwright-vision",
  kind: "vision",
  capability: "browser.navigate",
  displayName: "Playwright + Vision (Tier 3 fallback)",
  platforms: ["macos", "windows", "linux"],
  requires: { binary: "node", visionModel: "claude-sonnet-4-6 (or any vision-capable)" },
  concurrency: "parallel",
  rateLimit: { maxPerMinute: 6 },   // vision is slow + costly, cap tight

  async healthCheck(): Promise<HealthStatus> {
    const hasNode = await hasBinary("node");
    if (!hasNode) return { healthy: false, reason: "node not on PATH", checkedAt: Date.now() };
    // Real probe: Playwright available?
    const r = await runCli("node", ["-e", "try{require('playwright');console.log('ok')}catch(e){console.log('missing')}"], { timeoutMs: 5_000 });
    if (!r.stdout.includes("ok")) {
      return { healthy: false, reason: "Playwright not installed (run `pnpm add playwright && npx playwright install chromium`)", checkedAt: Date.now() };
    }
    // Vision model available? Cortex throws if no key; we don't probe here (too slow),
    // instead we surface vision failures at execute-time.
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<BrowserVisionOutput>> {
    try {
      // Phase 1: navigate + screenshot
      const shot = await runPhase("screenshot", { url: input.url, waitMs: input.waitMs ?? 0 });

      // Phase 2: ask vision model
      const plan = await askVisionForAction({
        task: input.task,
        imageBase64: shot.base64,
        systemHint: `The page is ${shot.url} (title: "${shot.title}"), viewport ${shot.width}x${shot.height}. For 'click' actions, return pixel coords (unit: "px").`,
      });

      // Phase 3: act on plan
      if (plan.action === "extract" || plan.action === "none") {
        return {
          success: true,
          output: `Extracted via vision: ${(plan.extracted ?? plan.reason).slice(0, 400)}`,
          data: {
            url: shot.url, title: shot.title, actionPlan: plan,
            extracted: plan.extracted,
          },
        };
      }

      if (plan.action === "click") {
        const coords = resolveCoords(plan, { width: shot.width, height: shot.height });
        if (!coords) {
          return { success: false, output: `Vision returned click without coords: ${plan.reason}`, error: "NO_COORDS", errorKind: "retryable" };
        }
        const result = await runPhase("click", { url: input.url, x: coords.x, y: coords.y, waitMs: input.waitMs ?? 0 });
        return {
          success: true,
          output: `Clicked at (${coords.x},${coords.y}): ${plan.reason}\n\n${result.text?.slice(0, 800) ?? ""}`,
          data: {
            url: result.url, title: result.title, actionPlan: plan,
            clicked: coords, extracted: result.text,
          },
        };
      }

      return {
        success: false,
        output: `Unsupported vision action "${plan.action}" for browser`,
        error: "UNSUPPORTED_ACTION", errorKind: "terminal",
      };
    } catch (err: any) {
      return {
        success: false, output: `Vision fallback failed: ${err.message}`,
        error: err.message, errorKind: "retryable",
      };
    }
  },
};
