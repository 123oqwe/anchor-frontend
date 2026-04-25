/**
 * L5 Execution — Model cascade for ReAct turns.
 *
 * The Anchor ReAct loop used to pin all turns to a single Sonnet model.
 * Most turns don't need Sonnet-grade reasoning: "got a tool result, now
 * call the next tool with these args" is pattern execution, not planning.
 *
 * Cascade picks a tier per turn based on the run's *signal state*:
 *   - Turn 0 (initial planning): strong (Sonnet) — highest ambiguity
 *   - Execution turns after success: fast (Haiku) — 3.75× cheaper, same
 *     quality for routine continuation
 *   - Any failure signal: escalate back to strong — re-plan with Sonnet
 *   - Explicit user override / very complex input: frontier (Opus)
 *
 * Cost note: Anthropic's prompt cache is model-specific. Switching from
 * Sonnet to Haiku invalidates the Sonnet-cached prefix. We accept that
 * miss because Haiku's raw per-token price (even fresh) beats Sonnet's
 * cached price ONCE output tokens dominate (~500+ tokens/turn typical).
 *
 * Failure-mode policy: when uncertain, bias to "strong". A run that
 * completes a task correctly but costs 1.5× is always better than a
 * cheaper run that produces wrong output.
 */
import type { ModelTier } from "../infra/compute/router.js";

export interface CascadeState {
  turn: number;                    // 0-indexed
  consecutiveFailures: number;     // from the ReAct loop's P5 tracking
  rethinkInjected: boolean;        // "stop and reconsider" nudge fired this run
  lastTurnHadSuccess: boolean;     // at least one tool succeeded in prior turn
  lastTurnHadFailure: boolean;     // at least one tool failed in prior turn
  userMessageLength: number;       // proxy for complexity at run start
  allowedToolsCount: number;       // more tools → more decision space
}

export interface CascadeDecision {
  tier: ModelTier;
  reason: string;                  // audit trail
}

/**
 * Pure function: given the current state, return which tier to use for
 * the next LLM call. All branches are deterministic — easy to unit test.
 */
export function pickModelTier(state: CascadeState): CascadeDecision {
  // Turn 0 always uses strong — initial planning is worth the cost.
  if (state.turn === 0) {
    return { tier: "strong", reason: "initial_planning" };
  }

  // Any failure or rethink signal escalates: the agent is confused, we
  // want the stronger model to re-plan rather than repeat the mistake.
  if (state.consecutiveFailures >= 1 || state.rethinkInjected) {
    return { tier: "strong", reason: "failure_escalation" };
  }

  // Very long user message + many tools available = high decision space,
  // stay with strong for the whole run. Rare case.
  if (state.userMessageLength > 2000 && state.allowedToolsCount >= 10) {
    return { tier: "strong", reason: "high_complexity_input" };
  }

  // Steady-state successful execution turn: Haiku handles it fine.
  if (state.lastTurnHadSuccess && !state.lastTurnHadFailure) {
    return { tier: "fast", reason: "execution_continuation" };
  }

  // Default: stay with strong. Conservative when signals are ambiguous.
  return { tier: "strong", reason: "ambiguous_default" };
}

/** Human-readable one-liner for console logs. */
export function decisionSummary(d: CascadeDecision): string {
  return `tier=${d.tier} (${d.reason})`;
}
