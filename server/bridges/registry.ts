/**
 * Bridge registry — capabilities + providers + dispatch.
 *
 * Single source of truth for the Hand layer. L5 tools become thin shims
 * that call dispatchCapability() and let the registry pick the provider.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { checkPermission } from "../permission/gate.js";
import type { ExecutionContext } from "../execution/registry.js";
import type { CapabilityDef, ProviderDef, Platform, ProviderResult, ProviderKind } from "./types.js";
import { cachedHealthCheck } from "./health.js";
import { logProviderAttempt, acquireProviderRateLimit } from "./telemetry.js";
import { checkAppApproval } from "./app-approval.js";

const capabilities = new Map<string, CapabilityDef>();
const providers = new Map<string, ProviderDef>();            // id → provider
const providersByCapability = new Map<string, ProviderDef[]>(); // capability.name → providers

export function currentPlatform(): Platform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function registerCapability(cap: CapabilityDef): void {
  capabilities.set(cap.name, cap);
  if (!providersByCapability.has(cap.name)) providersByCapability.set(cap.name, []);
  console.log(`[Bridge] Capability registered: ${cap.name} (${cap.actionClass})`);
}

export function registerProvider(provider: ProviderDef): void {
  if (!capabilities.has(provider.capability)) {
    throw new Error(`Cannot register provider ${provider.id}: capability ${provider.capability} not registered`);
  }
  providers.set(provider.id, provider);
  const arr = providersByCapability.get(provider.capability) ?? [];
  arr.push(provider);
  providersByCapability.set(provider.capability, arr);
  console.log(`[Bridge] Provider registered: ${provider.id} (${provider.kind}) → ${provider.capability}`);
}

export function getCapabilities(): CapabilityDef[] {
  return Array.from(capabilities.values());
}

export function getProviders(): ProviderDef[] {
  return Array.from(providers.values());
}

export function getProvidersFor(capabilityName: string): ProviderDef[] {
  return providersByCapability.get(capabilityName) ?? [];
}

export function getProvider(id: string): ProviderDef | undefined {
  return providers.get(id);
}

// ── User preference for provider order ───────────────────────────────────────

function getUserPreferredOrder(capabilityName: string): string[] {
  const row = db.prepare(
    "SELECT provider_order, disabled_providers FROM capability_preferences WHERE user_id=? AND capability=?"
  ).get(DEFAULT_USER_ID, capabilityName) as any;
  if (!row) return [];
  try {
    return JSON.parse(row.provider_order ?? "[]");
  } catch { return []; }
}

function getDisabledProviders(capabilityName: string): Set<string> {
  const row = db.prepare(
    "SELECT disabled_providers FROM capability_preferences WHERE user_id=? AND capability=?"
  ).get(DEFAULT_USER_ID, capabilityName) as any;
  if (!row) return new Set();
  try {
    return new Set(JSON.parse(row.disabled_providers ?? "[]"));
  } catch { return new Set(); }
}

export function setProviderOrder(capabilityName: string, order: string[]): void {
  db.prepare(
    `INSERT INTO capability_preferences (user_id, capability, provider_order, disabled_providers)
     VALUES (?, ?, ?, '[]')
     ON CONFLICT(user_id, capability) DO UPDATE SET provider_order=excluded.provider_order`
  ).run(DEFAULT_USER_ID, capabilityName, JSON.stringify(order));
}

export function setProviderDisabled(capabilityName: string, providerIds: string[]): void {
  db.prepare(
    `INSERT INTO capability_preferences (user_id, capability, provider_order, disabled_providers)
     VALUES (?, ?, '[]', ?)
     ON CONFLICT(user_id, capability) DO UPDATE SET disabled_providers=excluded.disabled_providers`
  ).run(DEFAULT_USER_ID, capabilityName, JSON.stringify(providerIds));
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Dispatch priority — ordered by user SETUP FRICTION, not transport kind.
 *
 * Jobs principle: the user is already logged into Mail.app, Calendar.app, and
 * Chrome. Don't ask them to OAuth again. Put zero-setup paths first so first
 * launch just works.
 *
 *  Tier 0 — already-logged-in native app (AppleScript Mail/Calendar/iMessage)
 *  Tier 1 — already-logged-in browser profile (Playwright + Chrome userDataDir)
 *  Tier 2 — already-logged-in MCP tooling (Claude Code / Playwright MCP)
 *  Tier 3 — OAuth / API keys (requires the user to click Connect)
 *  Tier 4 — Vision fallback (Codex-style, last resort)
 */
function setupTierOf(p: ProviderDef): number {
  // Explicit per-id overrides first (these are the zero-setup providers)
  const tier0 = new Set([
    "applemail-applescript", "applecalendar-applescript",
    "applereminders-applescript", "imessage-applescript",
  ]);
  if (tier0.has(p.id)) return 0;

  if (p.id.startsWith("browser-profile-")) return 1;

  // MCP tooling the user either has installed (claude) or gets via npx
  if (p.kind === "mcp") return 2;

  // OAuth/API: any provider declaring it needs OAuth
  if (p.requires?.oauth) return 3;
  if (p.requires?.apiToken) return 3;

  // Shortcuts-based providers require the user to import a .shortcut first
  if (p.requires?.shortcuts && p.requires.shortcuts.length > 0) return 3;

  // Vision always last
  if (p.kind === "vision") return 4;

  // Remaining CLI with no extra requirements → tier 0.5 (zero-setup, not native)
  return 0;
}

function orderProviders(
  compatible: ProviderDef[],
  userPref: string[],
  disabled: Set<string>
): ProviderDef[] {
  const active = compatible.filter(p => !disabled.has(p.id));
  const byId = new Map(active.map(p => [p.id, p]));
  const ordered: ProviderDef[] = [];
  const seen = new Set<string>();

  // User preference wins (explicit overrides hierarchy)
  for (const id of userPref) {
    const p = byId.get(id);
    if (p && !seen.has(id)) { ordered.push(p); seen.add(id); }
  }

  // Remaining providers: by setup tier (0 is zero-friction, 4 is last-resort)
  const rest = active.filter(p => !seen.has(p.id));
  rest.sort((a, b) => setupTierOf(a) - setupTierOf(b));
  ordered.push(...rest);

  return ordered;
}

function classifyError(err: any): "terminal" | "retryable" {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  // Auth / permission / not-found → terminal (fallback to other provider instead of retry)
  if (/(401|403|unauthor|forbidden|invalid.*token|expired|permission|denied|not found|404)/.test(msg)) {
    return "terminal";
  }
  // Timeout / 500 / network → retryable (try next provider)
  return "retryable";
}

export interface DispatchResult<Output = any> extends ProviderResult<Output> {
  providerId?: string;
  capabilityName: string;
}

export async function dispatchCapability<I = any, O = any>(
  capabilityName: string,
  input: I,
  ctx?: ExecutionContext,
  source: "user_triggered" | "cron" | "agent_chain" = "agent_chain"
): Promise<DispatchResult<O>> {
  const cap = capabilities.get(capabilityName);
  if (!cap) {
    return {
      success: false, output: `Unknown capability: ${capabilityName}`,
      error: "UNKNOWN_CAPABILITY", capabilityName,
    };
  }

  // L6 Permission Gate on the CAPABILITY (not per-provider — providers are implementation detail)
  const gate = checkPermission({
    actionClass: cap.actionClass,
    description: `${capabilityName}(${JSON.stringify(input).slice(0, 100)})`,
    source,
  });
  if (gate.decision === "deny") {
    return {
      success: false, output: `Permission denied: ${gate.reason}`,
      error: "PERMISSION_DENIED", capabilityName,
    };
  }
  if (gate.decision === "require_confirmation") {
    return {
      success: false, output: `Requires confirmation: ${gate.reason}`,
      error: "NEEDS_CONFIRMATION", capabilityName,
    };
  }

  // Platform filter
  const platform = currentPlatform();
  const compatible = getProvidersFor(capabilityName).filter(p => p.platforms.includes(platform));
  if (compatible.length === 0) {
    return {
      success: false, output: `No provider available for ${capabilityName} on ${platform}`,
      error: "NO_PROVIDER", capabilityName,
    };
  }

  // Order by user preference
  const userPref = getUserPreferredOrder(capabilityName);
  const disabled = getDisabledProviders(capabilityName);
  const ordered = orderProviders(compatible, userPref, disabled);
  if (ordered.length === 0) {
    return {
      success: false, output: `All providers for ${capabilityName} disabled by user`,
      error: "ALL_DISABLED", capabilityName,
    };
  }

  // Try providers in order — fallback chain
  const attemptLog: string[] = [];
  for (const provider of ordered) {
    const healthStart = Date.now();
    const health = await cachedHealthCheck(provider);
    if (!health.healthy) {
      const reason = health.reason ?? "unhealthy";
      logProviderAttempt({
        capability: capabilityName, providerId: provider.id,
        status: "skipped", reason,
        latencyMs: Date.now() - healthStart, runId: ctx?.runId,
      });
      attemptLog.push(`${provider.id}: skipped (${reason})`);
      continue;
    }

    // Codex-style App Approval (layered over L6)
    if (provider.targetApp && provider.targetApp !== "*") {
      const appGate = checkAppApproval(provider.targetApp);
      if (appGate.decision !== "allow") {
        logProviderAttempt({
          capability: capabilityName, providerId: provider.id,
          status: "skipped", reason: `app-approval: ${appGate.decision} (${(appGate as any).reason})`,
          latencyMs: Date.now() - healthStart, runId: ctx?.runId,
        });
        attemptLog.push(`${provider.id}: ${appGate.decision} — ${(appGate as any).reason}`);
        continue;
      }
    }

    // Rate limit
    if (provider.rateLimit) {
      await acquireProviderRateLimit(provider.id, provider.rateLimit.maxPerMinute);
    }

    const execStart = Date.now();
    try {
      const result = await provider.execute(input, ctx);
      const latency = Date.now() - execStart;
      logProviderAttempt({
        capability: capabilityName, providerId: provider.id,
        status: result.success ? "success" : "failed",
        errorKind: result.errorKind,
        reason: result.success ? undefined : (result.error ?? result.output).slice(0, 200),
        latencyMs: latency, runId: ctx?.runId,
      });

      if (result.success) {
        return { ...result, providerId: provider.id, capabilityName };
      }
      attemptLog.push(`${provider.id}: ${result.error ?? "failed"}`);
      // Terminal error on this provider → still try next (maybe other provider has different auth)
      // Retryable → continue to next
      continue;
    } catch (err: any) {
      const latency = Date.now() - execStart;
      const errorKind = classifyError(err);
      logProviderAttempt({
        capability: capabilityName, providerId: provider.id,
        status: "failed", errorKind,
        reason: err.message?.slice(0, 200),
        latencyMs: latency, runId: ctx?.runId,
      });
      const friendly = provider.friendlyError?.(err) ?? err.message;
      attemptLog.push(`${provider.id}: ${friendly}`);
    }
  }

  return {
    success: false,
    output: `All providers failed for ${capabilityName}:\n  ${attemptLog.join("\n  ")}`,
    error: "ALL_PROVIDERS_FAILED",
    capabilityName,
  };
}
