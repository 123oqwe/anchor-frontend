/**
 * L3 Cognition — Plan Compiler (Phase 1 of #2).
 *
 * Compiles a user-confirmed natural-language plan into structured execution
 * steps. The compiled plan goes into action_sessions / action_steps so that
 * Phase 2 SessionRunner can advance it one step at a time, and the UI can
 * see what's actually about to run before it runs.
 *
 * Design choices (Karpathy lens):
 * - Single LLM call (cheap tier) per plan — not per step
 * - Static handler→runtime mapping; LLM never "infers" runtime, it picks tool
 * - zod schema with enum constraints + tool whitelist; SDK auto-retries on
 *   shape failure
 * - Fail-soft: compile error → session.status='failed', old ReAct still runs
 * - input_template uses mustache refs ({{steps[i].output.path}}); Phase 2's
 *   runtime resolves these against actual prior outputs
 */
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { object } from "../infra/compute/index.js";
import { getAllTools, type ToolHandler } from "../execution/registry.js";

// ── Runtime mapping ────────────────────────────────────────────────────────
// We do NOT add a new "runtime" field to ToolDef — the existing `handler`
// field already carries this information. One static map keeps both surfaces
// in sync without dual sources of truth.

export type RuntimeKind = "llm" | "cli" | "browser" | "local_app" | "db" | "human";

export function handlerToRuntime(handler: ToolHandler): RuntimeKind {
  switch (handler) {
    case "db":       return "db";
    case "api":      return "local_app";
    case "browser":  return "browser";
    case "code":     return "cli";
    case "shell":    return "cli";
    case "internal": return "llm";
    case "mcp":      return "local_app";
  }
}

// ── Compiled step shape ────────────────────────────────────────────────────

export type StepType = "query" | "draft" | "side_effect" | "approval" | "verify";

export interface StructuredStep {
  name: string;
  type: StepType;
  runtime: RuntimeKind;
  tool: string | null;
  input_template_json: string;
  approval_required: boolean;
  verify_rule: string | null;
  depends_on_step_indices: number[];
}

export interface CompiledPlan {
  planSummary: string;
  steps: StructuredStep[];
}

// ── Verifier rules registry (the names compiler may pick) ──────────────────
// Phase 3 will implement these. Phase 1 just exposes the names so compiler
// can populate verify_rule deterministically. Anything not in this list is
// rejected by the schema — keeps drift at zero.

export const KNOWN_VERIFY_RULES = [
  "sent_message_exists",
  "reminder_exists",
  "calendar_event_exists",
  "targets_nonempty",
  "draft_exists",
  "record_exists",
  "browser_state_success",
] as const;

// ── Compile ────────────────────────────────────────────────────────────────

export interface CompileInput {
  goal: string;
  steps: { id: string | number; content: string }[];
}

export interface CompileResult {
  ok: true;
  sessionId: string;
  plan: CompiledPlan;
}

export interface CompileFailure {
  ok: false;
  sessionId: string;     // session row exists with status='failed'
  error: string;
}

export async function compileAndPersistPlan(
  input: CompileInput,
  source: "advisor_confirm" | "cron" | "channel" = "advisor_confirm",
  sourceRefId?: string,
): Promise<CompileResult | CompileFailure> {
  const sessionId = nanoid();

  // Insert in 'compiling' state up front so failures leave a row to inspect.
  db.prepare(
    `INSERT INTO action_sessions (id, user_id, goal, source, source_ref_id, status)
     VALUES (?,?,?,?,?, 'compiling')`
  ).run(sessionId, DEFAULT_USER_ID, input.goal.slice(0, 1000), source, sourceRefId ?? null);

  try {
    const plan = await compilePlan(input);
    persistSteps(sessionId, plan);
    db.prepare(
      "UPDATE action_sessions SET status='pending', plan_summary=?, updated_at=datetime('now') WHERE id=?"
    ).run(plan.planSummary.slice(0, 500), sessionId);
    return { ok: true, sessionId, plan };
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).slice(0, 1000);
    db.prepare(
      "UPDATE action_sessions SET status='failed', compile_error=?, updated_at=datetime('now') WHERE id=?"
    ).run(msg, sessionId);
    console.error("[PlanCompiler] compile failed:", msg);
    return { ok: false, sessionId, error: msg };
  }
}

async function compilePlan(input: CompileInput): Promise<CompiledPlan> {
  if (input.steps.length === 0) {
    throw new Error("compileEmpty: no input steps");
  }
  if (input.steps.length > 20) {
    throw new Error(`compileTooLong: ${input.steps.length} steps (max 20)`);
  }

  const tools = getAllTools().map(t => ({
    name: t.name,
    runtime: handlerToRuntime(t.handler),
    actionClass: t.actionClass,
    description: t.description.slice(0, 120),
  }));
  const toolNameSet = new Set(tools.map(t => t.name));

  // Build the schema fresh per call so the tool-name enum reflects the
  // currently-registered set. Compile-time + runtime alignment via zod.
  const StepSchema = z.object({
    name: z.string().min(1),
    type: z.enum(["query", "draft", "side_effect", "approval", "verify"]),
    runtime: z.enum(["llm", "cli", "browser", "local_app", "db", "human"]),
    tool: z.string().nullable(),
    input_template_json: z.string(),
    approval_required: z.boolean(),
    verify_rule: z.enum(KNOWN_VERIFY_RULES).nullable(),
    depends_on_step_indices: z.array(z.number()).default([]),
  });
  const PlanSchema = z.object({
    plan_summary: z.string(),
    steps: z.array(StepSchema).min(1).max(20),
  });

  const stepsList = input.steps.map((s, i) => `  ${i + 1}. ${s.content}`).join("\n");
  const toolsList = tools.map(t =>
    `- ${t.name} [runtime=${t.runtime}, class=${t.actionClass}]: ${t.description}`
  ).join("\n");
  const verifierList = KNOWN_VERIFY_RULES.map(r => `- ${r}`).join("\n");

  const system = `You are Anchor's plan compiler. Convert a user-confirmed
natural-language plan into a structured executable form.

For each step, decide:
- type: 'query' (read-only data fetch), 'draft' (LLM output for human review),
  'side_effect' (does something external — email, file write, calendar),
  'approval' (block waiting for user OK), 'verify' (assert a postcondition)
- runtime: derived from chosen tool (see runtime tag in tool list); for
  human/approval use 'human' with tool=null
- tool: pick from the registered tools list ONLY. Use null only for runtime='human'
- input_template_json: a JSON object that becomes the tool input. Reference
  prior step output with {{steps[i].output}} or {{steps[i].observation.field}}
  syntax. Keep keys aligned with the tool's input schema names where obvious.
- approval_required: true ONLY for side_effect that is hard to undo (sending
  email, financial moves, irreversible writes). False for queries / drafts.
- verify_rule: pick a name from the verifier list when there's a clear
  postcondition. NULL otherwise. Required when type='side_effect'.
- depends_on_step_indices: usually [previous index]; multi-step joins use
  multiple indices.

Tools available:
${toolsList}

Verifier rules available:
${verifierList}

Goal: ${input.goal.slice(0, 500)}`;

  const user = `User-confirmed plan steps (in order):\n${stepsList}\n\nProduce the structured plan now.`;

  const parsed = await object({
    task: "twin_edit_learning",   // cheap tier — this is routing, not reasoning
    system,
    messages: [{ role: "user", content: user }],
    schema: PlanSchema,
    maxTokens: 1500,
    agentName: "PlanCompiler",
  });

  // Post-validation that zod can't express:
  for (let i = 0; i < parsed.steps.length; i++) {
    const s = parsed.steps[i];
    if (s.runtime !== "human" && !s.tool) {
      throw new Error(`step ${i}: runtime=${s.runtime} requires a tool`);
    }
    if (s.tool && !toolNameSet.has(s.tool)) {
      throw new Error(`step ${i}: unknown tool "${s.tool}" not in registry`);
    }
    if (s.type === "side_effect" && !s.verify_rule) {
      // Don't throw — surfaces as a warning. Compiler may legitimately
      // skip verify when there's no observable postcondition.
      console.warn(`[PlanCompiler] step ${i} (${s.name}) is side_effect without verify_rule`);
    }
    try { JSON.parse(s.input_template_json); }
    catch { throw new Error(`step ${i}: input_template_json is not valid JSON`); }
  }

  return {
    planSummary: parsed.plan_summary,
    steps: parsed.steps.map(s => ({
      name: s.name,
      type: s.type,
      runtime: s.runtime,
      tool: s.tool,
      input_template_json: s.input_template_json,
      approval_required: s.approval_required,
      verify_rule: s.verify_rule,
      depends_on_step_indices: s.depends_on_step_indices,
    })),
  };
}

function persistSteps(sessionId: string, plan: CompiledPlan): void {
  // Single transaction so partial inserts can't leave a half-built session.
  const insertStep = db.prepare(
    `INSERT INTO action_steps
       (id, session_id, step_index, name, type, runtime, tool,
        input_template_json, approval_required, verify_rule,
        depends_on_step_ids_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const tx = db.transaction((steps: StructuredStep[]) => {
    const ids = steps.map(() => nanoid());
    steps.forEach((s, i) => {
      // Translate index-based deps into id-based deps
      const depIds = s.depends_on_step_indices
        .filter(idx => idx >= 0 && idx < ids.length && idx !== i)
        .map(idx => ids[idx]);
      insertStep.run(
        ids[i], sessionId, i,
        s.name.slice(0, 500),
        s.type, s.runtime,
        s.tool,
        s.input_template_json,
        s.approval_required ? 1 : 0,
        s.verify_rule,
        JSON.stringify(depIds),
      );
    });
  });
  tx(plan.steps);
}

// ── Read helpers (used by routes/sessions.ts) ──────────────────────────────

export interface SessionRow {
  id: string;
  goal: string;
  source: string;
  source_ref_id: string | null;
  status: string;
  current_step_id: string | null;
  plan_summary: string;
  compile_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StepRow {
  id: string;
  session_id: string;
  step_index: number;
  name: string;
  type: string;
  runtime: string;
  tool: string | null;
  input_template: any;
  input_resolved: any;
  status: string;
  approval_required: boolean;
  approval_decision: string | null;
  output_text: string | null;
  observation: any;
  verify_rule: string | null;
  verify_status: string;
  verify_evidence: string | null;
  retry_count: number;
  max_retries: number;
  depends_on_step_ids: string[];
  started_at: string | null;
  finished_at: string | null;
}

export function listSessions(opts: { status?: string; limit?: number } = {}): SessionRow[] {
  const wheres = ["user_id=?"];
  const args: any[] = [DEFAULT_USER_ID];
  if (opts.status) { wheres.push("status=?"); args.push(opts.status); }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return db.prepare(
    `SELECT * FROM action_sessions WHERE ${wheres.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
  ).all(...args, limit) as SessionRow[];
}

export function getSession(id: string): SessionRow | null {
  return (db.prepare("SELECT * FROM action_sessions WHERE user_id=? AND id=?").get(DEFAULT_USER_ID, id) as SessionRow | undefined) ?? null;
}

export function getSessionSteps(sessionId: string): StepRow[] {
  const rows = db.prepare(
    "SELECT * FROM action_steps WHERE session_id=? ORDER BY step_index ASC"
  ).all(sessionId) as any[];
  return rows.map(r => ({
    ...r,
    approval_required: !!r.approval_required,
    input_template: safeJson(r.input_template_json) ?? {},
    input_resolved: safeJson(r.input_resolved_json),
    observation: safeJson(r.observation_json),
    depends_on_step_ids: safeJson(r.depends_on_step_ids_json) ?? [],
  }));
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
