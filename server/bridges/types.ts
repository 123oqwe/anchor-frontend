/**
 * L8-Hand Bridge — types.
 *
 * Capability: a user-facing action (e.g. "email.send"). Has ActionClass for L6.
 * Provider : a concrete implementation of a capability. Categorized by transport:
 *   - CliProvider: spawns a subprocess one-shot OR does a single REST request.
 *                  Stateless. Token-efficient. 2026 consensus for most cases.
 *   - McpProvider: keeps a long-running subprocess with JSON-RPC over stdio.
 *                  Stateful. For browser login sessions, Claude Code delegation.
 *
 * Dispatch picks a provider based on (user preference × platform × health).
 */
import type { ActionClass } from "../permission/levels.js";
import type { ExecutionContext } from "../execution/registry.js";

export type Platform = "macos" | "windows" | "linux";

export type ProviderKind = "cli" | "mcp";

export interface CapabilityDef<Input = any, Output = any> {
  name: string;                    // e.g. "email.send", "browser.navigate"
  description: string;
  actionClass: ActionClass;        // L6 permission gate
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /** Typed generics only — not enforced at runtime here. */
  _io?: { input: Input; output: Output };
}

export interface ProviderResult<Output = any> {
  success: boolean;
  data?: Output;
  output: string;                  // human-readable summary
  error?: string;
  errorKind?: "terminal" | "retryable";
  rollback?: () => Promise<void>;
}

export interface HealthStatus {
  healthy: boolean;
  reason?: string;
  checkedAt: number;
}

export interface ProviderDef<Input = any, Output = any> {
  id: string;                      // e.g. "gmail-rest", "playwright-cli"
  kind: ProviderKind;
  capability: string;              // capability.name
  displayName: string;
  platforms: Platform[];
  requires: {
    oauth?: string;                // "google"
    apiToken?: string;             // "TODOIST_TOKEN"
    shortcuts?: string[];          // user-installed Shortcut names (macOS)
    binary?: string;               // required executable on PATH (e.g. "shortcuts", "claude")
    env?: string[];                // required env vars
  };
  /** Serial = one call at a time (browser MCP). Parallel = concurrent OK. */
  concurrency: "parallel" | "serial";
  /** For stateful providers (MCP), how long to keep idle before killing. */
  lifecycle?: { idleTimeoutMs: number };
  /** Per-user rate limit guardrail. */
  rateLimit?: { maxPerMinute: number };
  healthCheck: () => Promise<HealthStatus>;
  execute: (input: Input, ctx?: ExecutionContext) => Promise<ProviderResult<Output>>;
  /** User-friendly error translation (optional). */
  friendlyError?: (err: any) => string;
}
