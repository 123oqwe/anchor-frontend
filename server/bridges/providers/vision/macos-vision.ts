/**
 * macOS Desktop Vision provider (kind: vision).
 *
 * Implements the Doubao / UI-TARS / Codex Tier 3 pattern for desktop apps:
 *   1. screencapture → PNG in tmp
 *   2. Cortex vision() with Sonnet 4.6 / UI-TARS → action plan (click/type/extract)
 *   3. Execute via osascript "System Events" (cliclick would be cleaner, but
 *      AppleScript is always available on macOS — no install required).
 *
 * This is Anchor's answer to "automate any macOS app without developer API".
 * Limited by: Accessibility permission (System Settings → Privacy), display
 * resolution detection, and VLM spatial accuracy. All real-world constraints,
 * not mocks.
 *
 * Because screen coords include the menu bar / dock, the VLM is given the
 * full-screen screenshot and returns pixel coords directly.
 */
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { runCli } from "../cli/base.js";
import { captureMacScreen, askVisionForAction, resolveCoords, cleanupScreenshot } from "./base.js";

interface DesktopAutomateInput {
  task: string;                    // "Open Slack and click the latest DM from Foo"
  app?: string;                    // optional hint: "Slack" → `open -a Slack` first
  confirmBeforeClick?: boolean;    // if true, emit approval event (handled by dispatcher via L6)
}

interface DesktopAutomateOutput {
  actionPlan: any;
  clicked?: { x: number; y: number };
  extracted?: string;
}

async function getDisplayResolution(): Promise<{ width: number; height: number }> {
  // system_profiler is slow; use AppleScript to query menu bar display bounds
  const r = await runCli(
    "osascript",
    ["-e", 'tell application "Finder" to get bounds of window of desktop'],
    { timeoutMs: 5_000 }
  );
  const nums = r.stdout.trim().split(",").map(s => parseInt(s.trim(), 10));
  if (nums.length === 4 && !nums.some(isNaN)) {
    return { width: nums[2] - nums[0], height: nums[3] - nums[1] };
  }
  // Fallback
  return { width: 1920, height: 1080 };
}

async function activateApp(appName: string): Promise<void> {
  await runCli(
    "osascript",
    ["-e", `tell application "${appName.replace(/"/g, '\\"')}" to activate`],
    { timeoutMs: 5_000 }
  ).catch(() => {});
  // give the app a beat to come forward
  await new Promise(r => setTimeout(r, 600));
}

async function clickAt(x: number, y: number): Promise<void> {
  // AppleScript click at {x, y} via System Events. Requires Accessibility permission.
  const script = `tell application "System Events" to click at {${x}, ${y}}`;
  const r = await runCli("osascript", ["-e", script], { timeoutMs: 5_000 });
  if (r.exitCode !== 0) {
    throw new Error(`AppleScript click failed (grant Accessibility to Terminal/Anchor in System Settings): ${r.stderr.slice(0, 120)}`);
  }
}

async function typeText(text: string): Promise<void> {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "System Events" to keystroke "${escaped}"`;
  const r = await runCli("osascript", ["-e", script], { timeoutMs: 8_000 });
  if (r.exitCode !== 0) {
    throw new Error(`AppleScript keystroke failed: ${r.stderr.slice(0, 120)}`);
  }
}

export const macosVisionProvider: ProviderDef<DesktopAutomateInput, DesktopAutomateOutput> = {
  id: "macos-vision",
  kind: "vision",
  capability: "desktop.automate",
  displayName: "macOS Vision (screencapture + VLM + AppleScript)",
  platforms: ["macos"],
  requires: { binary: "screencapture", visionModel: "claude-sonnet-4-6 (or any vision-capable)" },
  concurrency: "serial",              // sharing the screen — serial only
  rateLimit: { maxPerMinute: 4 },     // vision is heavy + disruptive to user
  targetApp: "*",                     // App Approval: gated per-app at dispatch time

  async healthCheck(): Promise<HealthStatus> {
    if (process.platform !== "darwin") return { healthy: false, reason: "macOS only", checkedAt: Date.now() };
    // screencapture exists?
    const sc = await runCli("which", ["screencapture"], { timeoutMs: 2_000 });
    if (sc.exitCode !== 0) return { healthy: false, reason: "screencapture not on PATH", checkedAt: Date.now() };
    // osascript exists?
    const os = await runCli("which", ["osascript"], { timeoutMs: 2_000 });
    if (os.exitCode !== 0) return { healthy: false, reason: "osascript not on PATH", checkedAt: Date.now() };
    // Accessibility permission can only be verified by attempting a no-op; defer to execute-time.
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<DesktopAutomateOutput>> {
    let shotPath = "";
    try {
      if (input.app) await activateApp(input.app);

      const display = await getDisplayResolution();
      const shot = await captureMacScreen();
      shotPath = shot.path;

      const plan = await askVisionForAction({
        task: input.task,
        imageBase64: shot.base64,
        systemHint: `macOS desktop at ${display.width}x${display.height}. Menu bar occupies top ~25px. Prefer pixel coords (unit: "px").`,
      });

      if (plan.action === "extract" || plan.action === "none") {
        return {
          success: true,
          output: `Extracted: ${(plan.extracted ?? plan.reason).slice(0, 400)}`,
          data: { actionPlan: plan, extracted: plan.extracted },
        };
      }

      if (plan.action === "click") {
        const coords = resolveCoords(plan, display);
        if (!coords) return { success: false, output: "Vision click had no coords", error: "NO_COORDS", errorKind: "retryable" };
        await clickAt(coords.x, coords.y);
        return {
          success: true,
          output: `Clicked (${coords.x},${coords.y}): ${plan.reason}`,
          data: { actionPlan: plan, clicked: coords },
        };
      }

      if (plan.action === "type") {
        if (!plan.text) return { success: false, output: "Vision type had no text", error: "NO_TEXT", errorKind: "retryable" };
        await typeText(plan.text);
        return {
          success: true,
          output: `Typed "${plan.text.slice(0, 40)}": ${plan.reason}`,
          data: { actionPlan: plan },
        };
      }

      return {
        success: false,
        output: `Unsupported desktop action: ${plan.action}`,
        error: "UNSUPPORTED_ACTION", errorKind: "terminal",
      };
    } catch (err: any) {
      return {
        success: false, output: `Desktop vision failed: ${err.message}`,
        error: err.message, errorKind: "retryable",
      };
    } finally {
      if (shotPath) await cleanupScreenshot(shotPath);
    }
  },

  friendlyError(err) {
    const msg = String(err?.message ?? err ?? "").toLowerCase();
    if (msg.includes("accessibility") || msg.includes("1002") || msg.includes("-1719")) {
      return "Desktop automation needs Accessibility permission. Open System Settings → Privacy & Security → Accessibility → add your terminal app (or Anchor).";
    }
    if (msg.includes("screencapture")) return "Screen recording permission required. System Settings → Privacy & Security → Screen Recording.";
    return err?.message ?? "Desktop vision failed";
  },
};
