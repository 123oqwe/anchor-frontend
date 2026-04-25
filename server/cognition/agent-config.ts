/**
 * L3 Cognition — Custom Agent configuration model.
 *
 * OpenClaw 4-layer architecture (Soul · Body · Faculty · Skill) + Hermes
 * personality patterns adapted to Anchor's user-defined agents.
 *
 * Layers (mental model):
 *   - Soul       — durable identity ("why I exist", voice, values)
 *   - Body       — role + responsibilities + constraints
 *   - Faculty    — what skills/tools/scopes I can reach for
 *   - Examples   — few-shot dialogue pairs (input → output)
 *   - Rhythm     — when I get triggered (manual / cron / event / idle)
 *   - Vitality   — health metrics (last run, success/failure counts)
 *
 * Stored as a single JSON blob in user_agents.config_json — schema-light,
 * forward-compatible. Frontend renders sections; runtime composes the
 * system prompt by walking these layers in order.
 *
 * SCOPE: this module is consumed only by routes/custom-agents.ts. System
 * agents (decision/twin/oracle-council/dream/etc.) keep their existing
 * prompt code paths.
 */

import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────────────────

export const SoulSchema = z.object({
  /** 1-2 sentence durable purpose: "Why does this agent exist?" */
  purpose: z.string().default(""),
  /** Voice / tone — "Direct, terse, no fluff." */
  voice: z.string().default(""),
  /** Core values — what this agent prioritizes. ["truth > politeness"] */
  values: z.array(z.string()).default([]),
});

export const BodySchema = z.object({
  /** Short role title — e.g., "Email Drafter", "Competitor Analyst". */
  role: z.string().default(""),
  /** Things this agent SHOULD do. */
  responsibilities: z.array(z.string()).default([]),
  /** Things this agent MUST NOT do. Hard rails. */
  constraints: z.array(z.string()).default([]),
});

export const FacultySchema = z.object({
  /** Skill IDs (rows in `skills` table) this agent may invoke. */
  skills: z.array(z.string()).default([]),
  /** Read scopes the agent can pull context from. */
  read_scope: z.array(z.string()).default(["graph", "memory.semantic"]),
});

export const ExampleSchema = z.object({
  input: z.string(),
  output: z.string(),
});

export const RhythmSchema = z.object({
  trigger_type: z.enum(["manual", "cron", "event", "idle"]).default("manual"),
  trigger_config: z.record(z.string(), z.any()).default({}),
  /** Whether the agent can ping the user proactively (false = wait to be asked). */
  proactive: z.boolean().default(false),
});

export const VitalitySchema = z.object({
  last_run_at: z.string().nullable().optional(),
  success_count: z.number().default(0),
  failure_count: z.number().default(0),
  avg_latency_ms: z.number().nullable().optional(),
  last_error: z.string().nullable().optional(),
});

export const AgentConfigSchema = z.object({
  soul: SoulSchema.default({ purpose: "", voice: "", values: [] }),
  body: BodySchema.default({ role: "", responsibilities: [], constraints: [] }),
  faculty: FacultySchema.default({ skills: [], read_scope: ["graph", "memory.semantic"] }),
  examples: z.array(ExampleSchema).default([]),
  rhythm: RhythmSchema.default({ trigger_type: "manual", trigger_config: {}, proactive: false }),
  vitality: VitalitySchema.default({ success_count: 0, failure_count: 0 }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ── Parse / safe-default ──────────────────────────────────────────────────

/**
 * Parse a config_json string and return a fully-populated AgentConfig.
 * Missing or malformed input returns the empty defaults — never throws.
 * Used everywhere we read user_agents.config_json.
 */
export function parseAgentConfig(raw: string | null | undefined): AgentConfig {
  if (!raw || raw === "{}" || raw === "") return AgentConfigSchema.parse({});
  try {
    const obj = JSON.parse(raw);
    return AgentConfigSchema.parse(obj);
  } catch {
    return AgentConfigSchema.parse({});
  }
}

// ── Prompt composition ───────────────────────────────────────────────────

/**
 * Build the system prompt the LLM sees, layer by layer.
 *
 * Order is intentional — Soul first because Hermes' research showed identity
 * needs to be the LLM's first impression; Body second so role + boundaries
 * frame everything else; Faculty third so the LLM knows its toolbelt;
 * Examples last because few-shot demos work best closest to the user message.
 *
 * Returns "" if config is empty in every meaningful layer — caller can fall
 * back to the legacy `instructions` string.
 */
export function buildSystemPromptFromConfig(config: AgentConfig): string {
  const parts: string[] = [];

  // ── Soul ─────────────────────────────────────────────
  if (config.soul.purpose || config.soul.voice || config.soul.values.length) {
    const lines: string[] = ["## Identity"];
    if (config.soul.purpose) lines.push(config.soul.purpose);
    if (config.soul.voice) lines.push(`\nVoice: ${config.soul.voice}`);
    if (config.soul.values.length) {
      lines.push(`\nValues:\n${config.soul.values.map(v => `- ${v}`).join("\n")}`);
    }
    parts.push(lines.join("\n"));
  }

  // ── Body ─────────────────────────────────────────────
  if (config.body.role || config.body.responsibilities.length || config.body.constraints.length) {
    const lines: string[] = ["## Role"];
    if (config.body.role) lines.push(config.body.role);
    if (config.body.responsibilities.length) {
      lines.push(`\nResponsibilities (do):\n${config.body.responsibilities.map(r => `- ${r}`).join("\n")}`);
    }
    if (config.body.constraints.length) {
      lines.push(`\nConstraints (don't):\n${config.body.constraints.map(c => `- ${c}`).join("\n")}`);
    }
    parts.push(lines.join("\n"));
  }

  // ── Faculty ──────────────────────────────────────────
  // Tools list itself is rendered by the existing tool-binding layer; this
  // section just announces faculty intent so the LLM picks the right tool.
  if (config.faculty.skills.length || config.faculty.read_scope.length) {
    const lines: string[] = ["## Capabilities"];
    if (config.faculty.read_scope.length) {
      lines.push(`Reads: ${config.faculty.read_scope.join(", ")}`);
    }
    if (config.faculty.skills.length) {
      lines.push(`Skills available: ${config.faculty.skills.length}`);
    }
    parts.push(lines.join("\n"));
  }

  // ── Examples ─────────────────────────────────────────
  if (config.examples.length) {
    const lines: string[] = ["## Examples"];
    for (const ex of config.examples) {
      lines.push(`\nInput: ${ex.input}\nOutput: ${ex.output}`);
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}

// ── Vitality update helper ───────────────────────────────────────────────

/**
 * Mutates a config to record one run's outcome. Pure-ish — returns a new
 * object so callers can re-serialize. Callers must persist the result.
 */
export function recordRunInVitality(
  config: AgentConfig,
  outcome: { success: boolean; latencyMs?: number; error?: string },
): AgentConfig {
  const v = config.vitality;
  const total = v.success_count + v.failure_count + 1;
  const newAvgLatency = outcome.latencyMs !== undefined
    ? Math.round(((v.avg_latency_ms ?? 0) * (total - 1) + outcome.latencyMs) / total)
    : v.avg_latency_ms ?? null;

  return {
    ...config,
    vitality: {
      last_run_at: new Date().toISOString(),
      success_count: outcome.success ? v.success_count + 1 : v.success_count,
      failure_count: outcome.success ? v.failure_count : v.failure_count + 1,
      avg_latency_ms: newAvgLatency,
      last_error: outcome.success ? null : (outcome.error ?? "unknown"),
    },
  };
}

// ── Cron-specific config ─────────────────────────────────────────────────

export const CronConditionSchema = z.object({
  /** Path into Anchor state, e.g., "user_state.energy", "vitality.success_rate" */
  field: z.string(),
  /** Comparator. */
  op: z.enum(["<", "<=", "==", "!=", ">=", ">"]),
  /** Value to compare against. */
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const CronVitalitySchema = z.object({
  last_fired_at: z.string().nullable().optional(),
  fire_count: z.number().default(0),
  success_count: z.number().default(0),
  failure_count: z.number().default(0),
  last_error: z.string().nullable().optional(),
});

export const CronConfigSchema = z.object({
  /** Why this cron exists — durable doc string. */
  purpose: z.string().default(""),
  /** Tone when notifying user. */
  voice: z.string().default(""),
  /** Pre-fire filters. Empty array means "always fire on schedule." */
  conditions: z.array(CronConditionSchema).default([]),
  /** ISO timestamp; if set and in the future, cron is paused. */
  snooze_until: z.string().nullable().default(null),
  vitality: CronVitalitySchema.default({ fire_count: 0, success_count: 0, failure_count: 0 }),
});

export type CronConfig = z.infer<typeof CronConfigSchema>;

export function parseCronConfig(raw: string | null | undefined): CronConfig {
  if (!raw || raw === "{}" || raw === "") return CronConfigSchema.parse({});
  try {
    return CronConfigSchema.parse(JSON.parse(raw));
  } catch {
    return CronConfigSchema.parse({});
  }
}

/**
 * Should this cron fire? Checks snooze + conditions.
 * Returns { fire: boolean, reason: string } so callers can log why.
 */
export function shouldCronFire(
  config: CronConfig,
  context: Record<string, any>,
): { fire: boolean; reason: string } {
  // Snooze check
  if (config.snooze_until) {
    const until = new Date(config.snooze_until).getTime();
    if (!Number.isNaN(until) && until > Date.now()) {
      return { fire: false, reason: `snoozed until ${config.snooze_until}` };
    }
  }

  // Conditions: ALL must pass (AND semantics)
  for (const cond of config.conditions) {
    const lhs = readPath(context, cond.field);
    if (!compare(lhs, cond.op, cond.value)) {
      return { fire: false, reason: `condition failed: ${cond.field} ${cond.op} ${cond.value} (got ${JSON.stringify(lhs)})` };
    }
  }

  return { fire: true, reason: "ok" };
}

function readPath(obj: any, path: string): any {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

function compare(lhs: any, op: string, rhs: any): boolean {
  switch (op) {
    case "<":  return lhs < rhs;
    case "<=": return lhs <= rhs;
    case "==": return lhs == rhs;     // intentional loose equality for type coercion
    case "!=": return lhs != rhs;
    case ">=": return lhs >= rhs;
    case ">":  return lhs > rhs;
    default:   return false;
  }
}

export function recordCronFireInVitality(
  config: CronConfig,
  outcome: { success: boolean; error?: string },
): CronConfig {
  const v = config.vitality;
  return {
    ...config,
    vitality: {
      last_fired_at: new Date().toISOString(),
      fire_count: v.fire_count + 1,
      success_count: outcome.success ? v.success_count + 1 : v.success_count,
      failure_count: outcome.success ? v.failure_count : v.failure_count + 1,
      last_error: outcome.success ? null : (outcome.error ?? "unknown"),
    },
  };
}
