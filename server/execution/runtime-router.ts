/**
 * L5 Execution — Runtime Router (Phase 4 of #2).
 *
 * Single dispatch point for SessionRunner. Replaces inline executeTool +
 * timeout-by-hope with explicit per-runtime timeout + retry policy. Tools
 * still live in execution/registry.ts; this router decides HOW each runtime
 * gets called (how long to wait, whether failures are retryable, what
 * fallback observation to attach if the tool didn't supply one).
 *
 * Why a router not 6 separate executor files:
 * Karpathy principle 2 — every runtime currently dispatches via the SAME
 * executeTool() (registry handles permission gate + per-handler logic).
 * Splitting into 6 files would just be a switch statement spread across 6
 * files. One table here, callsite picks the policy by step.runtime.
 */
import { executeTool, type ToolResult, type ToolObservation } from "./registry.js";
import type { ExecutionContext } from "./registry.js";

export type RuntimeKind = "llm" | "cli" | "browser" | "local_app" | "db" | "human";

interface RuntimePolicy {
  /** Max wall-clock time before forcing failure. 0 = no timeout (human). */
  timeoutMs: number;
  /** Default retry-on-fail signal. Side-effect runtimes default to NO retry
   *  to avoid double-sending emails / double-creating reminders.  */
  defaultRetryable: boolean;
}

const POLICIES: Record<RuntimeKind, RuntimePolicy> = {
  llm:       { timeoutMs:  30_000, defaultRetryable: true  },
  cli:       { timeoutMs:  60_000, defaultRetryable: false },  // shell is side-effecty
  browser:   { timeoutMs: 120_000, defaultRetryable: false },  // navigation can re-fire
  local_app: { timeoutMs:  30_000, defaultRetryable: false },  // emails / reminders / calendar — never retry
  db:        { timeoutMs:   5_000, defaultRetryable: true  },  // DB writes are idempotent in our schemas
  human:     { timeoutMs:   0,     defaultRetryable: false },  // human runtime never times out (they get notified)
};

export function getRuntimePolicy(runtime: RuntimeKind): RuntimePolicy {
  return POLICIES[runtime];
}

/**
 * Dispatch a step's tool. Wraps executeTool with the runtime-specific timeout
 * and clamps shouldRetry by the runtime's default policy. Tool can opt OUT
 * of retry by setting shouldRetry=false; tool can opt IN only when the
 * runtime allows it (a side-effect tool can't override db→retryable).
 *
 * Returns a ToolResult with `observation` always at least synthesised
 * (runtime-tagged) so SessionRunner's verifier hook always has structured
 * input even when the tool predates Phase 3.
 */
export async function runStepDispatch(opts: {
  runtime: RuntimeKind;
  tool: string;
  input: any;
  ctx: ExecutionContext;
}): Promise<ToolResult> {
  const policy = POLICIES[opts.runtime];
  if (!policy) {
    return { success: false, output: `unknown runtime: ${opts.runtime}`, error: "UNKNOWN_RUNTIME" };
  }

  const exec = executeTool(opts.tool, opts.input, opts.ctx, "user_triggered");

  let result: ToolResult;
  try {
    result = policy.timeoutMs > 0
      ? await Promise.race([
          exec,
          new Promise<ToolResult>((_, reject) =>
            setTimeout(() => reject(new Error(`runtime ${opts.runtime} timeout (${policy.timeoutMs}ms)`)), policy.timeoutMs)
          ),
        ])
      : await exec;
  } catch (err: any) {
    return {
      success: false,
      output: `dispatch error: ${err?.message ?? err}`,
      error: err?.message,
      shouldRetry: policy.defaultRetryable,
      observation: synthObservation(opts.runtime),
    };
  }

  // Clamp retry by policy: tool may set shouldRetry=true but if the runtime
  // is non-retryable (e.g. local_app side-effect), we still treat it as
  // single-shot. Tool can always force shouldRetry=false to opt out.
  const finalShouldRetry = result.shouldRetry === false
    ? false
    : !!(result.shouldRetry && policy.defaultRetryable);

  return {
    ...result,
    shouldRetry: finalShouldRetry,
    observation: result.observation ?? synthObservation(opts.runtime, result),
  };
}

/** Build a minimal runtime-tagged observation when the tool didn't supply
 *  one. Verifiers can still inspect the right runtime branch even if no
 *  detail is available. */
function synthObservation(runtime: RuntimeKind, result?: ToolResult): ToolObservation {
  switch (runtime) {
    case "cli":       return { runtime: "cli" };
    case "browser":   return { runtime: "browser" };
    case "local_app": return { runtime: "local_app", raw: result?.data };
    case "db":        return { runtime: "db" };
    case "llm":       return { runtime: "llm", text: result?.output };
    case "human":     return { runtime: "human" };
  }
}
