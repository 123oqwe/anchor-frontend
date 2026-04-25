/**
 * L5 Execution — Verifier registry (Phase 3 of #2).
 *
 * "Tool returned success" is not the same as "task is actually done." A
 * verifier is an independent post-condition check that runs after the tool:
 *   - send_email succeeded → verify the message id actually exists
 *   - write_task succeeded → verify the row landed in tasks
 *   - browser_navigate succeeded → verify the page reached an OK status
 *
 * Compiler picks rule names from KNOWN_VERIFY_RULES (cognition/plan-compiler.ts).
 * Each rule maps here to an async checker. Failures only block the session
 * when step.type='side_effect' — query/draft are recorded but not blocking,
 * since they're informational, not actuating.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import type { ToolObservation } from "./registry.js";

export interface VerifyContext {
  stepName: string;
  stepType: string;       // 'query' | 'draft' | 'side_effect' | 'approval' | 'verify'
  outputText: string | null;
  observation: ToolObservation | null;
  tool: string | null;
}

export interface VerifyResult {
  pass: boolean;
  evidence: string;
}

export type VerifierFn = (ctx: VerifyContext) => Promise<VerifyResult>;

const VERIFIERS: Record<string, VerifierFn> = {
  // ─── side-effect verifiers (block on fail) ──────────────────────────────

  /** Reminder bridge returned an id (best-effort — Apple AppleScript doesn't
   *  always expose it; we fall back to "succeeded with text" as proxy). */
  reminder_exists: async (ctx) => {
    if (ctx.observation?.runtime === "local_app" && ctx.observation.bridgeResponseId) {
      return { pass: true, evidence: `reminder id: ${ctx.observation.bridgeResponseId}` };
    }
    if (ctx.outputText && ctx.outputText.toLowerCase().includes("reminder")) {
      return { pass: true, evidence: `output mentions reminder: "${ctx.outputText.slice(0, 80)}"` };
    }
    return { pass: false, evidence: "no reminder id and output doesn't confirm" };
  },

  /** Calendar event was created — provider returns a calendar event id in observation.bridgeResponseId. */
  calendar_event_exists: async (ctx) => {
    const id = ctx.observation?.runtime === "local_app" ? ctx.observation.bridgeResponseId : undefined;
    if (id) return { pass: true, evidence: `calendar event id: ${id}` };
    return { pass: false, evidence: "no calendar event id returned by bridge" };
  },

  /** Email was sent — observation.bridgeResponseId is gmail message id (or
   *  Apple Mail equivalent). We reject obvious placeholder ids that some
   *  bridges return on partial failure; recognise gmail-format ids
   *  (16+ hex) so a later Gmail-API round-trip can be slotted in.
   *  Apple Mail AppleScript currently returns no real id — we mark those
   *  pass=false because we genuinely have no postcondition evidence. */
  sent_message_exists: async (ctx) => {
    const id = ctx.observation?.runtime === "local_app" ? ctx.observation.bridgeResponseId : undefined;
    if (!id) return { pass: false, evidence: "no message id returned by mail bridge" };
    // Reject obvious placeholders.
    const lower = id.toLowerCase();
    if (id.length < 8) return { pass: false, evidence: `message id too short: "${id}"` };
    if (lower === "unknown" || lower === "null" || lower === "undefined") {
      return { pass: false, evidence: `message id is placeholder: "${id}"` };
    }
    if (lower.startsWith("placeholder") || lower.startsWith("applescript:")) {
      return { pass: false, evidence: `synthetic id from bridge that doesn't expose real ids: "${id}"` };
    }
    const isGmailLike = /^[a-f0-9]{16,}$/i.test(id);
    return { pass: true, evidence: `message id: ${id}${isGmailLike ? " (gmail-format)" : ""}` };
  },

  /** A row was written to a known table — observation.runtime='db' tells us
   *  rowCount and which table. */
  record_exists: async (ctx) => {
    if (ctx.observation?.runtime !== "db") {
      return { pass: false, evidence: `expected db observation, got ${ctx.observation?.runtime ?? "none"}` };
    }
    const n = ctx.observation.rowCount ?? 0;
    if (n <= 0) return { pass: false, evidence: "rowCount=0 — no record inserted" };
    return { pass: true, evidence: `${n} row(s) in ${ctx.observation.table ?? "unknown"}${ctx.observation.ids?.length ? ` (ids: ${ctx.observation.ids.slice(0, 3).join(",")}${ctx.observation.ids.length > 3 ? "…" : ""})` : ""}` };
  },

  // ─── query/draft verifiers (record but don't block) ─────────────────────

  /** Step's output is a non-empty array of targets / candidates. Used by
   *  query steps that produce a list for the next step to act on. */
  targets_nonempty: async (ctx) => {
    if (!ctx.outputText) return { pass: false, evidence: "no output" };
    let parsed: any;
    try { parsed = JSON.parse(ctx.outputText); }
    catch { return { pass: false, evidence: `output not JSON: "${ctx.outputText.slice(0, 60)}"` }; }
    // Accept either bare array or { targets: [...] }
    const list = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.targets) ? parsed.targets
      : Array.isArray(parsed?.results) ? parsed.results
      : null;
    if (!list) return { pass: false, evidence: `output isn't a list (keys: ${Object.keys(parsed ?? {}).join(",")})` };
    return list.length > 0
      ? { pass: true, evidence: `${list.length} target(s)` }
      : { pass: false, evidence: "list is empty" };
  },

  /** Draft has substantive content (≥30 chars). Cheap proxy for "LLM produced
   *  something we can show the user," not a content judgment. */
  draft_exists: async (ctx) => {
    const len = ctx.outputText?.length ?? 0;
    return len >= 30
      ? { pass: true, evidence: `draft length: ${len} chars` }
      : { pass: false, evidence: `draft too short (${len} chars)` };
  },

  /** Browser navigation reached an OK status. */
  browser_state_success: async (ctx) => {
    if (ctx.observation?.runtime !== "browser") {
      return { pass: false, evidence: `expected browser observation, got ${ctx.observation?.runtime ?? "none"}` };
    }
    const code = ctx.observation.statusCode ?? 0;
    if (code >= 200 && code < 400) {
      return { pass: true, evidence: `HTTP ${code} on ${ctx.observation.finalUrl ?? "(no url)"}` };
    }
    return { pass: false, evidence: `HTTP ${code || "unknown"}` };
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

export function getVerifier(rule: string): VerifierFn | null {
  return VERIFIERS[rule] ?? null;
}

export function listVerifierRules(): string[] {
  return Object.keys(VERIFIERS);
}

/** Run a verifier with a 5s timeout. Verifier failure (timeout / throw) is
 *  itself a verify_status='fail' — we never let a verifier crash the runner. */
export async function runVerifier(rule: string, ctx: VerifyContext): Promise<VerifyResult> {
  const fn = getVerifier(rule);
  if (!fn) return { pass: false, evidence: `unknown verifier rule: ${rule}` };
  try {
    return await Promise.race([
      fn(ctx),
      new Promise<VerifyResult>((_, reject) => setTimeout(() => reject(new Error("verifier timeout 5s")), 5000)),
    ]);
  } catch (err: any) {
    return { pass: false, evidence: `verifier error: ${err?.message ?? err}` };
  }
}

// ── Read helper for /api/admin (visible coverage map) ─────────────────────

export function getVerifierCoverage(): { rule: string }[] {
  return Object.keys(VERIFIERS).map(rule => ({ rule }));
}
