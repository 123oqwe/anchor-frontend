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
import { createHash } from "crypto";
import { text, textStream } from "../infra/compute/index.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { serializeForPrompt as graphPrompt, serializeStateForPrompt, serializeEdgesForPrompt, getNodesByType } from "../graph/reader.js";
import { serializeForPrompt as memoryPrompt, serializeTwinForPrompt } from "../memory/retrieval.js";
import { type DecisionPacket, type ContextPacket, type StageTrace } from "./packets.js";
import { shouldActivateSwarm, runSwarm } from "./swarm.js";
import { detectSkillMatch, buildSkillBasedPlan } from "./skills.js";
import { getPromptAdaptations } from "./evolution.js";

// ── Decision cache (LRU, 50 entries, 5min TTL) ────────────────────────────
const CACHE_MAX = 50;
const CACHE_TTL_MS = 5 * 60 * 1000;
const decisionCache = new Map<string, { result: DecisionResult; timestamp: number }>();

function getCacheKey(message: string, history?: { role: string; content: string }[]): string {
  const graphVersion = (db.prepare("SELECT MAX(updated_at) as v FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.v ?? "";
  const memVersion = (db.prepare("SELECT MAX(created_at) as v FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.v ?? "";
  const historyHash = history?.length ? createHash("md5").update(history.map(h => `${h.role}:${h.content.slice(0, 50)}`).join("|")).digest("hex").slice(0, 8) : "0";
  return createHash("md5").update(`${message}|${graphVersion}|${memVersion}|${historyHash}`).digest("hex");
}

function getFromCache(key: string): DecisionResult | null {
  const entry = decisionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { decisionCache.delete(key); return null; }
  return entry.result;
}

function putInCache(key: string, result: DecisionResult): void {
  if (decisionCache.size >= CACHE_MAX) {
    const oldest = decisionCache.keys().next().value;
    if (oldest) decisionCache.delete(oldest);
  }
  decisionCache.set(key, { result, timestamp: Date.now() });
}

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

/** Build user's value constitution from L1 graph value/constraint/preference nodes. */
function buildValueConstitution(): string {
  const values = getNodesByType("value" as any);
  const constraints = getNodesByType("constraint" as any);
  const preferences = getNodesByType("preference" as any);

  if (values.length === 0 && constraints.length === 0 && preferences.length === 0) {
    return "";
  }

  const lines: string[] = ["USER VALUE CONSTITUTION (respect these in ALL recommendations):"];
  if (values.length > 0) {
    lines.push("VALUES (what the user cares about deeply — never contradict):");
    for (const v of values) lines.push(`  - ${v.label}: ${v.detail}`);
  }
  if (constraints.length > 0) {
    lines.push("CONSTRAINTS (hard limits — never violate):");
    for (const c of constraints) lines.push(`  - ${c.label} (${c.status}): ${c.detail}`);
  }
  if (preferences.length > 0) {
    lines.push("PREFERENCES (how the user likes things done — follow unless user explicitly overrides):");
    for (const p of preferences) lines.push(`  - ${p.label}: ${p.detail}`);
  }
  lines.push("");
  lines.push("HIERARCHY: Safety > User values > Constraints > Preferences > Efficiency");
  return lines.join("\n");
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

{CONSTITUTION}

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
  const base = DECISION_SYSTEM_PROMPT
    .replace("{STATE}", serializeStateForPrompt())
    .replace("{GRAPH}", graphPrompt())
    .replace("{EDGES}", serializeEdgesForPrompt())
    .replace("{MEMORY}", memoryPrompt(userMessage))
    .replace("{TWIN}", serializeTwinForPrompt())
    .replace("{CONSTITUTION}", buildValueConstitution());

  // Append evolution-based prompt adaptations
  const adaptations = getPromptAdaptations();
  return base + adaptations;
}

/** Run the Decision Agent 5-stage pipeline. */
export async function decide(
  message: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<DecisionResult> {
  // Cache check: return cached result for identical requests
  const cacheKey = getCacheKey(message, history);
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log("[Decision Agent] Cache hit");
    return cached;
  }

  // "I don't know" threshold: if we have too little context, be honest
  const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const memCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (nodeCount < 3 && memCount < 5 && history.length < 3) {
    return {
      raw: "I don't have enough context about you yet to give a truly personal recommendation. Tell me more about your situation — your goals, constraints, and what you're working on — so I can give you advice that's actually grounded in your reality.",
      isPlan: false,
      packet: null,
    };
  }

  // Skill-aware routing: check if a learned skill matches this request
  const userState = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  const skillMatch = detectSkillMatch(message, userState ?? { energy: 70, focus: 70, stress: 30 });
  if (skillMatch && skillMatch.confidence > 0.7) {
    console.log(`[Decision Agent] Skill match: "${skillMatch.name}" (${(skillMatch.confidence * 100).toFixed(0)}%)`);
    const skillResult = await buildSkillBasedPlan(skillMatch, message);
    putInCache(cacheKey, skillResult);
    return skillResult;
  }

  const system = buildSystemPrompt(message);

  const raw = await text({
    task: "decision",
    system,
    messages: [...history, { role: "user", content: message }],
    maxTokens: 2500,
  });

  // Parse structured output
  let structured: DecisionResult["structured"] = undefined;
  let packet: DecisionPacket | null = null;

  try {
    const stripped = raw.replace(/```json\s*/g, "").replace(/```/g, "");
    let jsonStr = stripped.match(/\{[\s\S]*\}/)?.[0];
    if (jsonStr) {
      // Auto-repair truncated JSON
      if (!jsonStr.trim().endsWith("}")) {
        const open = (jsonStr.match(/\[/g) || []).length - (jsonStr.match(/\]/g) || []).length;
        const braces = (jsonStr.match(/\{/g) || []).length - (jsonStr.match(/\}/g) || []).length;
        jsonStr += "]".repeat(Math.max(0, open)) + "}".repeat(Math.max(0, braces));
      }
      let parsed: any;
      try { parsed = JSON.parse(jsonStr); } catch {
        try { parsed = JSON.parse(jsonStr.replace(/,\s*\]/, "]").replace(/,\s*\}/, "}")); } catch { parsed = null; }
      }
      if (parsed && parsed.type === "plan" && Array.isArray(parsed.editable_steps)) {
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
  } catch (e) { /* JSON parse failed, return plain text */ }

  // Check if Swarm should be activated for complex decisions
  if (packet && packet.type === "plan") {
    const shouldSwarm = shouldActivateSwarm({
      decisionConfidence: packet.confidenceScore,
      stepCount: packet.candidates.length,
      constraintCount: packet.conflictFlags.length,
      isMultiDomain: (packet.candidates[0]?.referencedNodes?.length ?? 0) > 5,
    });
    if (shouldSwarm) {
      console.log("[Decision Agent] Escalating to Swarm debate...");
      const swarmResult = await runSwarm(message, graphPrompt(), memoryPrompt(message), serializeTwinForPrompt());
      // Merge swarm result into packet
      if (swarmResult.candidatePlans.length > 0) {
        const plan = swarmResult.candidatePlans.find(p => p.recommended) ?? swarmResult.candidatePlans[0];
        packet.candidates = plan.stages.map((s, i) => ({
          id: i + 1, content: s, riskSignals: plan.risks, referencedNodes: [],
        }));
        packet.conflictFlags = [
          ...packet.conflictFlags,
          ...swarmResult.plannerDisagreements.filter(d => !d.resolved).map(d => `DEBATE: ${d.topic}`),
        ];
        if (structured) {
          structured.editable_steps = plan.stages.map((s, i) => ({ id: i + 1, content: s }));
          structured.conflict_flags = packet.conflictFlags;
        }
      }
    }
  }

  // Trajectory confidence verification — only for plans with 3+ steps
  if (packet && packet.type === "plan" && packet.candidates.length >= 3) {
    await verifyTrajectoryConfidence(packet, message);
  }

  const result = { raw, isPlan: !!structured, packet, structured };
  putInCache(cacheKey, result);
  return result;
}

// ── Trajectory Confidence Verifier (ACC pattern, 2026) ──────────────────────

async function verifyTrajectoryConfidence(packet: DecisionPacket, userMessage: string): Promise<void> {
  try {
    const verifierResult = await text({
      task: "twin_edit_learning",  // cheap model
      system: `You are an independent confidence calibrator. Evaluate whether this decision plan is well-reasoned.

User asked: "${userMessage.slice(0, 200)}"

Plan summary: ${packet.suggestionSummary}
Why now: ${packet.whyThisNow}
Risk level: ${packet.riskLevel}
Steps: ${packet.candidates.length}
Conflict flags: ${packet.conflictFlags.join("; ") || "none"}
Original confidence: ${packet.confidenceScore}

Evaluate:
1. Is the reasoning sound given the information?
2. Are there blind spots the plan missed?
3. Is the confidence level appropriate?

Respond ONLY with JSON: {"verified_confidence": 0.0-1.0, "blind_spots": ["any missed issues"], "calibration_note": "brief note"}`,
      messages: [{ role: "user", content: "Verify this decision trajectory." }],
      maxTokens: 200,
    });

    const stripped = verifierResult.replace(/```json\s*/g, "").replace(/```/g, "");
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    if (parsed.verified_confidence !== undefined) {
      const gap = Math.abs(packet.confidenceScore - parsed.verified_confidence);
      if (gap > 0.3) {
        packet.conflictFlags.push(`LOW_CALIBRATION: Decision confidence ${packet.confidenceScore.toFixed(2)} but verifier says ${parsed.verified_confidence.toFixed(2)} (gap: ${gap.toFixed(2)})`);
        // Adjust to average
        packet.confidenceScore = (packet.confidenceScore + parsed.verified_confidence) / 2;
        console.log(`[Decision Agent] Confidence recalibrated: ${packet.confidenceScore.toFixed(2)} (verifier gap: ${gap.toFixed(2)})`);
      }
      if (parsed.blind_spots?.length > 0) {
        for (const bs of parsed.blind_spots) {
          if (bs && bs.length > 5) packet.conflictFlags.push(`BLIND_SPOT: ${bs}`);
        }
      }
    }
  } catch (err: any) {
    // Verifier failure is non-fatal — just log
    console.log(`[Decision Agent] Verifier skipped: ${err.message?.slice(0, 50)}`);
  }
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

  // 7. Twin over-reliance — low-confidence twin priors driving the decision
  const twinTrace = packet.stagesTrace.find(s => s.stage === "twin_alignment");
  if (twinTrace && twinTrace.output.toLowerCase().includes("strongly influenced") && packet.confidenceScore > 0.8) {
    // Check if twin insights are actually low-confidence
    const twinInsights = db.prepare(
      "SELECT AVG(confidence) as avg FROM twin_insights WHERE user_id=?"
    ).get(DEFAULT_USER_ID) as any;
    if (twinInsights?.avg && twinInsights.avg < 0.6) {
      failures.push("TWIN_OVER_RELIANCE: Decision heavily influenced by twin priors that have low average confidence (<0.6). Consider weighing graph facts more.");
    }
  }

  // 8. Open-loop-as-task — treating unresolved questions as completed action items
  for (const candidate of packet.candidates) {
    const content = candidate.content.toLowerCase();
    if (content.includes("?") || content.includes("figure out") || content.includes("determine") || content.includes("find out") || content.includes("investigate")) {
      // This is a question/investigation, not a concrete action
      if (!content.includes("research") && !content.includes("ask") && !content.includes("check")) {
        failures.push(`OPEN_LOOP_AS_TASK: Step ${candidate.id} ("${candidate.content.slice(0, 40)}") looks like an open question, not a concrete action. Rephrase as a specific action.`);
      }
    }
  }

  if (failures.length > 0) {
    packet.conflictFlags = [...packet.conflictFlags, ...failures];
    console.log(`[Decision Agent] Cognitive failures detected: ${failures.join(", ")}`);
  }
}

// ── Streaming Decision — for SSE responses ─────────────────────────────────

/** Streaming version of decide() — returns async iterable of text chunks + full text promise. */
export async function decideStream(
  message: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<{ stream: AsyncIterable<string>; fullText: Promise<string> }> {
  const system = buildSystemPrompt(message);

  return textStream({
    task: "decision",
    system,
    messages: [...history, { role: "user", content: message }],
    maxTokens: 2500,
  });
}
