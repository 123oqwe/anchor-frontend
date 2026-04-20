/**
 * Vision provider base — screenshot → VLM → action.
 *
 * The Codex / UI-TARS / Doubao pattern: when structured API (CLI/MCP) paths
 * fail or don't apply, fall through to looking at the screen. This module
 * provides the shared primitives: capture, ask-vision, parse-action-plan.
 *
 * Real paths only: uses the user's actual Cortex vision() function (which
 * routes to Claude Sonnet 4.6 Vision or whatever vision-capable model has
 * a configured API key) plus the user's real `screencapture`/Playwright.
 */
import { mkdtemp, readFile, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCli } from "../cli/base.js";
import { vision as cortexVision } from "../../../infra/compute/index.js";

// ── Screen capture (macOS only for now; Linux/Windows skip here) ────────────

export async function captureMacScreen(opts: { displayId?: number; rect?: { x: number; y: number; w: number; h: number } } = {}): Promise<{
  path: string; base64: string; width: number; height: number;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "anchor-vis-"));
  const out = path.join(dir, "screen.png");

  const args = ["-x"];
  if (opts.rect) args.push("-R", `${opts.rect.x},${opts.rect.y},${opts.rect.w},${opts.rect.h}`);
  if (opts.displayId !== undefined) args.push("-D", String(opts.displayId));
  args.push(out);

  const r = await runCli("screencapture", args, { timeoutMs: 8_000 });
  if (r.exitCode !== 0) throw new Error(`screencapture failed: ${r.stderr}`);

  const buf = await readFile(out);
  const base64 = buf.toString("base64");
  return { path: out, base64, width: 0, height: 0 };  // width/height filled by caller if needed
}

// ── Action plan schema — what we expect the VLM to return ─────────────────

export interface VisionActionPlan {
  action: "click" | "type" | "scroll" | "extract" | "none";
  /** Normalized [0..1] or absolute pixel coords; if pixel, set `unit: "px"` */
  coords?: { x: number; y: number; unit?: "norm" | "px" };
  text?: string;                // for "type" or extract output
  extracted?: string;           // for "extract"
  reason: string;
  confidence: number;           // 0..1
}

/** Prompt the VLM for a structured action plan. */
export async function askVisionForAction(input: {
  task: string;
  imageBase64: string;
  imageMime?: string;
  systemHint?: string;
}): Promise<VisionActionPlan> {
  const system = `You are a GUI vision agent. Look at the screenshot and return ONLY a JSON object matching this schema:

{"action": "click|type|scroll|extract|none",
 "coords": {"x": <number>, "y": <number>, "unit": "norm"|"px"},   // coords are optional, omit for "extract"/"none"
 "text": "<text to type>",      // only for "type"
 "extracted": "<extracted text>",// only for "extract"
 "reason": "<one short sentence why this action>",
 "confidence": <0..1>}

Use normalized coords [0,1] unless you can see exact pixels. NO other output. NO markdown fences.${input.systemHint ? "\n\nAdditional context: " + input.systemHint : ""}`;

  const raw = await cortexVision({
    task: "vision_analysis",
    system,
    imageUrl: `data:${input.imageMime ?? "image/png"};base64,${input.imageBase64}`,
    prompt: input.task,
    maxTokens: 512,
  });

  // Strip any accidental markdown fencing; extract first JSON object
  const stripped = raw.replace(/```json|```/g, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Vision model did not return JSON: ${raw.slice(0, 200)}`);
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed.action) throw new Error("missing action");
    return parsed as VisionActionPlan;
  } catch (err: any) {
    throw new Error(`Vision JSON parse failed: ${err.message} — raw: ${match[0].slice(0, 200)}`);
  }
}

/** Resolve normalized coords against a known display size → pixel coords. */
export function resolveCoords(
  plan: VisionActionPlan,
  display: { width: number; height: number }
): { x: number; y: number } | null {
  if (!plan.coords) return null;
  if (plan.coords.unit === "px") return { x: Math.round(plan.coords.x), y: Math.round(plan.coords.y) };
  return {
    x: Math.round(plan.coords.x * display.width),
    y: Math.round(plan.coords.y * display.height),
  };
}

/** Clean up screenshot tmp files (called after the dispatch completes). */
export async function cleanupScreenshot(p: string): Promise<void> {
  await unlink(p).catch(() => {});
}
