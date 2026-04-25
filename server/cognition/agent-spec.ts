/**
 * L3 Cognition — System agent + cron spec language.
 *
 * The Soul/Body/Faculty/Examples/Rhythm structure from agent-config.ts is
 * authored DECLARATIVELY for the 11 hardcoded system agents (Twin, Decision,
 * Council, Dream, ...) using 4 wrapper functions that label each field's
 * lock state:
 *
 *   locked(value)       — Anchor curated. User cannot override. 🔒
 *   userField(default)  — User can replace. 🔓
 *   addOnly(items)      — User can append; can't remove built-ins. 🔓➕
 *   autoField()         — Runtime-computed (vitality). 🤖
 *
 * `composeSystemAgentConfig(spec)` merges spec defaults with DB-stored user
 * overrides + additions and emits an AgentConfig consumable by the existing
 * `buildSystemPromptFromConfig` pipeline. LOCKED fields are protected at
 * compose time — overrides on them are ignored with a warning, never thrown.
 *
 * SCOPE: this module only touches the new system_agent_overrides /
 * system_agent_additions tables. The 11 agent runtimes themselves
 * (twin.ts, decision.ts, etc.) opt-in by importing their spec + composer
 * from here. Agents that haven't migrated continue using their inline
 * prompts unchanged.
 */

import { db } from "../infra/storage/db.js";
import type { AgentConfig } from "./agent-config.js";

// ── Lock states ──────────────────────────────────────────────────

export type LockState = "locked" | "user" | "add_only" | "auto";

/** Type guard for the wrapped field shape. Carries a default + lock label. */
export interface FieldSpec<T> {
  readonly __lock: LockState;
  readonly default: T;
}

// ── Wrappers ────────────────────────────────────────────────────

/** 🔒 Anchor-curated; user override ignored. */
export function locked<T>(value: T): FieldSpec<T> {
  return { __lock: "locked", default: value };
}

/** 🔓 User can replace the default. Override stored in system_agent_overrides. */
export function userField<T>(defaultValue: T): FieldSpec<T> {
  return { __lock: "user", default: defaultValue };
}

/**
 * 🔓➕ User can APPEND to the default array (never remove built-ins).
 * Additions stored in system_agent_additions, one row per item.
 *
 * Note on usage: when seeding with an empty list, callers MUST supply the
 * generic explicitly — `addOnly<string>([])` not `addOnly([])` — otherwise
 * TypeScript infers `T = never[]` and downstream type-checks fail.
 */
export function addOnly<T>(items: T[]): FieldSpec<T[]> {
  return { __lock: "add_only", default: items };
}

/** 🤖 Computed at runtime (vitality, last_run_at). Never overridable. */
export function autoField<T>(): FieldSpec<T | null> {
  return { __lock: "auto", default: null };
}

// ── Spec types ──────────────────────────────────────────────────

export interface SystemAgentSpec {
  id: string;
  schemaVersion: number;
  name: string;
  description: string;
  /**
   * If true, the spec is documentary only — the agent's runtime continues
   * to use its inline prompt in cognition/<id>.ts. /api/system/agents still
   * exposes Soul/Body/Faculty for visibility + vitality, but user overrides
   * on USER fields will NOT affect the LLM call until the runtime is
   * migrated to use composeSystemAgentConfig().
   *
   * Twin = false (fully wired). All other system agents = true initially.
   * Each agent migrates from documentary→wired one at a time.
   */
  documentary_only?: boolean;

  soul: {
    purpose: FieldSpec<string>;
    voice: FieldSpec<string>;
    values: FieldSpec<string[]>;
  };
  body: {
    role: FieldSpec<string>;
    responsibilities: FieldSpec<string[]>;
    constraints: FieldSpec<string[]>;
  };
  faculty: {
    tools: FieldSpec<string[]>;
    skills: FieldSpec<string[]>;
    read_scope: FieldSpec<string[]>;
  };
  examples: FieldSpec<{ input: string; output: string }[]>;
  rhythm: {
    trigger_type: FieldSpec<"manual" | "cron" | "event" | "idle">;
    trigger_config: FieldSpec<Record<string, any>>;
    proactive: FieldSpec<boolean>;
  };
}

export interface SystemCronSpec {
  id: string;
  schemaVersion: number;
  name: string;
  description: string;
  purpose: FieldSpec<string>;
  voice: FieldSpec<string>;
  cron_pattern: FieldSpec<string>;
  conditions: FieldSpec<{ field: string; op: string; value: any }[]>;
  proactive: FieldSpec<boolean>;
}

// ── Composer ────────────────────────────────────────────────────

interface OverrideRow {
  agent_id: string;
  field_path: string;
  value: string;
}

interface AdditionRow {
  agent_id: string;
  field_path: string;
  value: string;
}

/**
 * Compose final AgentConfig from spec + DB overrides + DB additions.
 * Output shape matches AgentConfig — drop into buildSystemPromptFromConfig.
 *
 * Note: spec.faculty.tools is intentionally NOT propagated (AgentConfig
 * faculty has only skills + read_scope; tools live separately as an
 * agent-execution concern via allowedTools in the runtime).
 */
export function composeSystemAgentConfig(spec: SystemAgentSpec): AgentConfig {
  const overrides = readOverrides(spec.id);
  const additions = readAdditions(spec.id);

  return {
    soul: {
      purpose: resolveScalar(spec.soul.purpose, overrides, "soul.purpose"),
      voice: resolveScalar(spec.soul.voice, overrides, "soul.voice"),
      values: resolveAddable(spec.soul.values, additions, "soul.values"),
    },
    body: {
      role: resolveScalar(spec.body.role, overrides, "body.role"),
      responsibilities: resolveAddable(spec.body.responsibilities, additions, "body.responsibilities"),
      constraints: resolveAddable(spec.body.constraints, additions, "body.constraints"),
    },
    faculty: {
      skills: resolveAddable(spec.faculty.skills, additions, "faculty.skills"),
      read_scope: resolveScalar(spec.faculty.read_scope, overrides, "faculty.read_scope"),
    },
    examples: resolveAddable(spec.examples, additions, "examples"),
    rhythm: {
      trigger_type: resolveScalar(spec.rhythm.trigger_type, overrides, "rhythm.trigger_type"),
      trigger_config: resolveScalar(spec.rhythm.trigger_config, overrides, "rhythm.trigger_config"),
      proactive: resolveScalar(spec.rhythm.proactive, overrides, "rhythm.proactive"),
    },
    // Vitality is computed via /api/system/agents/:id/vitality from
    // agent_executions; the AgentConfig schema requires the field so we
    // emit zero defaults here. UI shows the computed values separately.
    vitality: { success_count: 0, failure_count: 0 },
  };
}

function resolveScalar<T>(
  field: FieldSpec<T>,
  overrides: Map<string, OverrideRow>,
  path: string,
): T {
  // LOCKED + AUTO: override is silently ignored (logged) — protects Anchor
  // identity from user (or compromised UI) bypass attempts.
  if (field.__lock === "locked" || field.__lock === "auto") {
    if (overrides.has(path)) {
      console.warn(`[SystemAgent] override on ${field.__lock} field ignored: ${path}`);
    }
    return field.default;
  }
  // USER: override wins if present + parses
  const o = overrides.get(path);
  if (!o) return field.default;
  try {
    return JSON.parse(o.value) as T;
  } catch {
    console.warn(`[SystemAgent] bad override JSON at ${path}, using default`);
    return field.default;
  }
}

function resolveAddable<T>(
  field: FieldSpec<T[]>,
  additions: AdditionRow[],
  path: string,
): T[] {
  // ADD_ONLY (and LOCKED arrays for safety): spec defaults retained;
  // user-added rows append. Anchor's built-in items are always there.
  const userAdded: T[] = [];
  for (const a of additions) {
    if (a.field_path !== path) continue;
    try { userAdded.push(JSON.parse(a.value) as T); } catch { /* skip bad row */ }
  }
  return [...field.default, ...userAdded];
}

function readOverrides(agentId: string): Map<string, OverrideRow> {
  const m = new Map<string, OverrideRow>();
  try {
    const rows = db.prepare(
      "SELECT agent_id, field_path, value FROM system_agent_overrides WHERE agent_id = ?"
    ).all(agentId) as OverrideRow[];
    for (const r of rows) m.set(r.field_path, r);
  } catch {
    // Table may not exist yet on first boot — empty map is correct fallback.
  }
  return m;
}

function readAdditions(agentId: string): AdditionRow[] {
  try {
    return db.prepare(
      "SELECT agent_id, field_path, value FROM system_agent_additions WHERE agent_id = ?"
    ).all(agentId) as AdditionRow[];
  } catch {
    return [];
  }
}

// ── Lock introspection (powers the API + UI) ───────────────────

/**
 * Walk a spec, return { "soul.purpose": "locked", "soul.voice": "user", ... }.
 * Used by GET /api/system/agents/:id to tell the UI which fields are
 * editable. Hardcoded layer list keeps the walk total-functioned.
 */
export function extractLockMap(spec: SystemAgentSpec): Record<string, LockState> {
  const map: Record<string, LockState> = {};
  for (const layer of ["soul", "body", "faculty", "rhythm"] as const) {
    const obj = spec[layer] as Record<string, FieldSpec<any>>;
    for (const [fieldName, field] of Object.entries(obj)) {
      map[`${layer}.${fieldName}`] = field.__lock;
    }
  }
  map["examples"] = spec.examples.__lock;
  return map;
}

/**
 * Look up a field's lock state from a dot-path. Used by API to validate
 * "is the user allowed to write to this field?" before persisting.
 */
export function getLockStateAtPath(spec: SystemAgentSpec, path: string): LockState | null {
  const parts = path.split(".");
  let cur: any = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur && typeof cur === "object" && "__lock" in cur ? (cur.__lock as LockState) : null;
}
