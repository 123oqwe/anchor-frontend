/**
 * L3 Cognition — Decision Agent.
 *
 * 5-stage reasoning pipeline (from spec: decision-agent-contract.ts):
 *   1. Constraint extraction — find blockers, deadlines, conflicts from graph
 *   2. Option generation — produce candidate actions
 *   3. Twin alignment — check against user behavioral priors
 *   4. Boundary classification — risk level + approval requirement
 *   5. Delta selection — final recommendation
 *
 * Also generates: why-this-now explanation, conflict flags, confidence score.
 * Pure cognition — no side effects.
 */
import { text } from "../infra/compute/index.js";
import { serializeForPrompt as graphPrompt, serializeStateForPrompt, serializeEdgesForPrompt } from "../graph/reader.js";
import { serializeForPrompt as memoryPrompt, serializeTwinForPrompt } from "../memory/retrieval.js";
import { type DecisionPacket, type ContextPacket, type StageTrace } from "./packets.js";

export interface DecisionResult {
  raw: string;
  isPlan: boolean;
  packet: DecisionPacket | null;
  structured?: {
    type: string;
    suggestion_summary: string;
    reasoning: string;
    editable_steps: { id: number; content: string; time_estimate?: string }[];
    risk_level: string;
    referenced_nodes: string[];
    why_this_now?: string;
    conflict_flags?: string[];
    confidence?: number;
  };
}

const DECISION_SYSTEM_PROMPT = `You are Anchor's Decision Agent. You reason through a strict 5-stage pipeline.

{STATE}

HUMAN GRAPH:
{GRAPH}

{EDGES}

BEHAVIORAL MEMORY:
{MEMORY}

TWIN INSIGHTS (user behavioral priors — these are inferred, not facts):
{TWIN}

YOUR 5-STAGE REASONING PROCESS:
Stage 1 — CONSTRAINT EXTRACTION: Identify all blockers, deadlines, conflicts, and hard constraints from the graph.
Stage 2 — OPTION GENERATION: Generate 2-3 candidate approaches considering constraints.
Stage 3 — TWIN ALIGNMENT: Check candidates against twin priors. Flag if a candidate conflicts with user preferences. Twin priors are WEAKER than explicit user input — if the user explicitly asks for something, do it even if twin says otherwise.
Stage 4 — BOUNDARY CLASSIFICATION: Classify risk level. "low" = safe suggestion. "high" = needs careful confirmation. If it involves external communication, money, or irreversible actions → high risk.
Stage 5 — DELTA SELECTION: Choose the best candidate. Explain why NOW (not yesterday, not next week).

PRECEDENCE RULE: Explicit user instruction > Current graph state > Twin prior. Never let a twin prior override what the user explicitly asked for.

OUTPUT FORMAT — For actionable requests, respond with JSON (no markdown fences):
{
  "type": "plan",
  "suggestion_summary": "One sentence recommendation",
  "reasoning": "Why this approach (reference graph nodes and twin insights)",
  "why_this_now": "Why this is urgent/timely RIGHT NOW — reference specific deadlines, decay, or opportunities",
  "editable_steps": [
    { "id": 1, "content": "Specific action", "time_estimate": "20min" }
  ],
  "risk_level": "low" | "high",
  "boundary_classification": "advisory_only" | "draft_candidate" | "approval_required",
  "referenced_nodes": ["node labels used in reasoning"],
  "conflict_flags": ["any unresolved tensions between options or with twin priors"],
  "confidence": 0.85,
  "stages_trace": [
    { "stage": "constraint_extraction", "output": "brief: what constraints found" },
    { "stage": "option_generation", "output": "brief: what options considered" },
    { "stage": "twin_alignment", "output": "brief: alignment result" },
    { "stage": "boundary_classification", "output": "brief: risk assessment" },
    { "stage": "delta_selection", "output": "brief: why this option won" }
  ]
}

For conversational questions, respond with plain text (2-3 sentences, direct, personal). Still include why-this-now thinking internally.`;

function buildSystemPrompt(userMessage: string): string {
  return DECISION_SYSTEM_PROMPT
    .replace("{STATE}", serializeStateForPrompt())
    .replace("{GRAPH}", graphPrompt())
    .replace("{EDGES}", serializeEdgesForPrompt())
    .replace("{MEMORY}", memoryPrompt(userMessage))
    .replace("{TWIN}", serializeTwinForPrompt());
}

/** Run the Decision Agent 5-stage pipeline. */
export async function decide(
  message: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<DecisionResult> {
  const system = buildSystemPrompt(message);

  const raw = await text({
    task: "decision",
    system,
    messages: [...history, { role: "user", content: message }],
    maxTokens: 1500,
  });

  // Parse structured output
  let structured: DecisionResult["structured"] = undefined;
  let packet: DecisionPacket | null = null;

  try {
    const stripped = raw.replace(/```json\s*/g, "").replace(/```/g, "");
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.type === "plan" && Array.isArray(parsed?.editable_steps)) {
        structured = {
          type: parsed.type,
          suggestion_summary: parsed.suggestion_summary ?? "",
          reasoning: parsed.reasoning ?? "",
          editable_steps: parsed.editable_steps,
          risk_level: parsed.risk_level ?? "low",
          referenced_nodes: parsed.referenced_nodes ?? [],
          why_this_now: parsed.why_this_now,
          conflict_flags: parsed.conflict_flags ?? [],
          confidence: parsed.confidence,
        };

        // Build typed packet
        packet = {
          type: "plan",
          suggestionSummary: structured.suggestion_summary,
          reasoning: structured.reasoning,
          whyThisNow: parsed.why_this_now ?? "",
          candidates: parsed.editable_steps.map((s: any) => ({
            id: s.id,
            content: s.content,
            timeEstimate: s.time_estimate,
            riskSignals: [],
            referencedNodes: parsed.referenced_nodes ?? [],
          })),
          riskLevel: parsed.risk_level ?? "low",
          boundaryClassification: parsed.boundary_classification ?? "draft_candidate",
          conflictFlags: parsed.conflict_flags ?? [],
          confidenceScore: parsed.confidence ?? 0.7,
          stagesTrace: (parsed.stages_trace ?? []).map((s: any) => ({
            stage: s.stage,
            input: "",
            output: s.output ?? "",
          })),
        };

        // Cognitive failure detection
        detectFailures(packet, message);
      }
    }
  } catch {}

  return { raw, isPlan: !!structured, packet, structured };
}

// ── Cognitive Failure Detection (8 modes from spec) ─────────────────────────

function detectFailures(packet: DecisionPacket, userMessage: string): void {
  const failures: string[] = [];

  // 1. Situation misjudgement — confidence too high for a complex request
  if (packet.confidenceScore > 0.95 && userMessage.length > 100) {
    failures.push("HIGH_CONFIDENCE_COMPLEX: Suspiciously high confidence for complex request");
  }

  // 2. Context starvation — no referenced nodes means graph wasn't used
  const totalRefs = packet.candidates.reduce((sum, c) => sum + c.referencedNodes.length, 0);
  if (totalRefs === 0 && packet.type === "plan") {
    failures.push("CONTEXT_STARVATION: No graph nodes referenced in plan — decision may be disconnected from user's reality");
  }

  // 3. Over-planning — too many steps for a simple request
  if (packet.candidates.length > 6 && userMessage.split(/\s+/).length < 15) {
    failures.push("OVER_PLANNING: Too many steps for a brief request");
  }

  // 4. Conflict suppression — risk level low but conflict flags exist
  if (packet.riskLevel === "low" && packet.conflictFlags.length > 0) {
    failures.push("CONFLICT_SUPPRESSION: Conflicts exist but risk marked low");
    packet.riskLevel = "medium"; // auto-correct
  }

  // 5. Missing why-this-now
  if (!packet.whyThisNow || packet.whyThisNow.length < 10) {
    failures.push("MISSING_TIMING: No explanation for why this action is needed now");
  }

  // 6. No stages trace
  if (packet.stagesTrace.length === 0) {
    failures.push("NO_TRACE: Decision produced without stage-by-stage reasoning trace");
  }

  if (failures.length > 0) {
    packet.conflictFlags = [...packet.conflictFlags, ...failures];
    console.log(`[Decision Agent] Cognitive failures detected: ${failures.join(", ")}`);
  }
}
