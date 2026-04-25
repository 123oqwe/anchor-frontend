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
import { text, textStream, object } from "../infra/compute/index.js";
import { z } from "zod";
import { pickVariant } from "../orchestration/experiment-runner.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { serializeForPrompt as graphPrompt, serializeStateForPrompt, serializeEdgesForPrompt, getNodesByType } from "../graph/reader.js";
import { serializeForPrompt as memoryPrompt, serializeTwinForPrompt } from "../memory/retrieval.js";
import { type DecisionPacket, type ContextPacket, type StageTrace } from "./packets.js";
import { shouldActivateSwarm, runSwarm } from "./swarm.js";
import { detectSkillMatch, buildSkillBasedPlan } from "./skills.js";
import { getPromptAdaptations } from "./evolution.js";
import { generateActivitySummary } from "../integrations/local/activity-monitor.js";

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

// ── Intent Classification (local, no LLM) ─────────────────────────────────
type Intent = "greeting" | "info_query" | "decision_request" | "execution_command" | "conversation";

function classifyIntent(message: string): Intent {
  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/);

  // Greetings — no pipeline needed
  if (words.length <= 3 && /^(hi|hello|hey|sup|yo|good morning|good evening|good night|thanks|thank you|ok|okay|sure|got it|cool|nice|great)/.test(lower)) {
    return "greeting";
  }

  // Execution commands — skip analysis, go straight to execution
  if (/^(send|email|create|schedule|open|search|remind|call|book|set up|draft)\b/.test(lower)) {
    return "execution_command";
  }

  // Decision requests — full pipeline
  if (/\b(should i|what should|how should|decide|prioritize|which|trade-?off|recommend|best approach|what do you think)\b/.test(lower)) {
    return "decision_request";
  }

  // Info queries — light pipeline
  if (/\b(what is|who is|when|where|how many|show me|list|status|tell me about|explain)\b/.test(lower)) {
    return "info_query";
  }

  return "conversation";
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

async function buildSystemPrompt(userMessage: string, contextRef?: string): Promise<string> {
  // Sprint A — #7: prompt experiment override. If a running experiment
  // exists for "decision.system_prompt", use that variant instead of the
  // hardcoded template. No experiment → identical to before.
  const variant = pickVariant({
    key: "decision.system_prompt",
    fallback: DECISION_SYSTEM_PROMPT,
    contextRef,
  });

  const base = variant.value
    .replace("{STATE}", serializeStateForPrompt())
    .replace("{GRAPH}", graphPrompt())
    .replace("{EDGES}", serializeEdgesForPrompt())
    .replace("{MEMORY}", await memoryPrompt(userMessage))
    .replace("{TWIN}", serializeTwinForPrompt())
    .replace("{CONSTITUTION}", buildValueConstitution());

  // Append evolution-based prompt adaptations
  const adaptations = getPromptAdaptations();

  // Inject recent activity context (Littlebird-inspired)
  let activityContext = "";
  try {
    const summary = generateActivitySummary(2); // last 2 hours
    if (summary.totalMinutes > 0) {
      const lines: string[] = ["\n\nRECENT ACTIVITY (last 2 hours — what user has been doing):"];
      if (summary.topApps.length > 0) {
        lines.push("Apps: " + summary.topApps.map(a => `${a.app}(${a.minutes}min)`).join(", "));
      }
      if (summary.activities.length > 0) {
        lines.push("Recent: " + summary.activities.slice(0, 5).map(a => `${a.app}: ${a.detail}`).join(" | "));
      }
      if (summary.meetings.length > 0) {
        lines.push("Meetings: " + summary.meetings.map(m => `${m.title}(${m.duration}min)`).join(", "));
      }
      if (summary.contentHighlights.length > 0) {
        lines.push("Working on: " + summary.contentHighlights.slice(0, 3).join(" | "));
      }
      activityContext = lines.join("\n");
    }
  } catch {}

  return base + adaptations + activityContext;
}

/** Run the Decision Agent 5-stage pipeline. */
export async function decide(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  opts?: { contextRef?: string }   // Sprint A — #7: enables A/B outcome attribution
): Promise<DecisionResult> {
  // Cache check: return cached result for identical requests
  const cacheKey = getCacheKey(message, history);
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log("[Decision Agent] Cache hit");
    return cached;
  }

  // Intent classification — skip heavy pipeline for simple messages
  const intent = classifyIntent(message);

  if (intent === "greeting") {
    const greetings = [
      "Hey! What's on your mind?",
      "Hi there. What are you thinking about?",
      "Hello! Ready when you are.",
      "Hey. What can I help you with?",
    ];
    const result: DecisionResult = {
      raw: greetings[Math.floor(Math.random() * greetings.length)],
      isPlan: false,
      packet: null,
    };
    return result;
  }

  // Sparse data detection: when data is thin, run 5-agent micro-analysis
  // instead of full pipeline. Tag kept for metrics — but NEVER blocks output.
  const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const memCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const isSparseData = nodeCount < 5 && memCount < 5 && history.length < 3;

  if (isSparseData) {
    try {
      const { runSparseAnalysis } = await import("./sparse-analysis.js");
      const analysis = await runSparseAnalysis();
      const raw = analysis.synthesizedInsight || "Tell me about yourself and I'll start building your world.";
      return { raw, isPlan: false, packet: null };
    } catch (err) {
      console.error("[Decision Agent] Sparse analysis failed:", err);
      // fall through to normal pipeline
    }
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

  const system = await buildSystemPrompt(message, opts?.contextRef);

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
  } catch (e) { console.error("[Decision Agent] JSON parse failed:", e); }

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
      const swarmResult = await runSwarm(message, graphPrompt(), await memoryPrompt(message), serializeTwinForPrompt());
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
    const parsed = await object({
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
3. Is the confidence level appropriate?`,
      messages: [{ role: "user", content: "Verify this decision trajectory." }],
      schema: z.object({
        verified_confidence: z.number().min(0).max(1),
        blind_spots: z.array(z.string()).default([]),
        calibration_note: z.string().default(""),
      }),
      maxTokens: 200,
    });

    const gap = Math.abs(packet.confidenceScore - parsed.verified_confidence);
    if (gap > 0.3) {
      packet.conflictFlags.push(`LOW_CALIBRATION: Decision confidence ${packet.confidenceScore.toFixed(2)} but verifier says ${parsed.verified_confidence.toFixed(2)} (gap: ${gap.toFixed(2)})`);
      packet.confidenceScore = (packet.confidenceScore + parsed.verified_confidence) / 2;
      console.log(`[Decision Agent] Confidence recalibrated: ${packet.confidenceScore.toFixed(2)} (verifier gap: ${gap.toFixed(2)})`);
    }
    for (const bs of parsed.blind_spots) {
      if (bs && bs.length > 5) packet.conflictFlags.push(`BLIND_SPOT: ${bs}`);
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

/**
 * Approximate tokens by character count: ~4 chars per token for mixed content.
 * Cheap, stable, doesn't require a tokenizer dependency.
 */
function approxTokens(messages: { content: string }[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Compress the older half of a long conversation into a single summary turn,
 * preserving the most recent half verbatim. Triggers when the rolling
 * conversation crosses the threshold (default 30k tokens — Mastra's default).
 *
 * Two practical wins:
 *   1. Cost stops growing linearly with conversation length
 *   2. Avoids "lost in the middle" — modern LLMs degrade on very long
 *      prompts; summarized history surfaces what matters
 *
 * Uses the cheap-tier `summarize` task (Haiku-class). The summary message is
 * tagged with role=assistant + a marker so the model knows it's
 * compressed-context, not a real assistant reply.
 */
async function compressIfNeeded(
  history: { role: "user" | "assistant"; content: string }[],
  thresholdTokens = 30_000,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (approxTokens(history) < thresholdTokens) return history;
  if (history.length < 6) return history;  // too short to compress meaningfully

  const halfIdx = Math.floor(history.length / 2);
  const oldTurns = history.slice(0, halfIdx);
  const recentTurns = history.slice(halfIdx);

  const oldText = oldTurns
    .map(t => `${t.role === "user" ? "User" : "Anchor"}: ${t.content}`)
    .join("\n");

  let summary = "";
  try {
    summary = await text({
      task: "summarize",
      system:
        "Summarize this conversation segment in 2-4 sentences. Capture: " +
        "decisions made, recurring themes, factual claims about the user, " +
        "open threads. Skip pleasantries. Output prose, no preamble.",
      messages: [{ role: "user", content: oldText }],
      maxTokens: 250,
    });
  } catch {
    // If summarization fails for any reason, fall back to original history —
    // never break the conversation flow over a compression failure.
    return history;
  }

  return [
    {
      role: "assistant",
      content: `[earlier conversation summary] ${summary}`,
    },
    ...recentTurns,
  ];
}

/** Streaming version of decide() — returns async iterable of text chunks + full text promise. */
export async function decideStream(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  opts?: { contextRef?: string }
): Promise<{ stream: AsyncIterable<string>; fullText: Promise<string> }> {
  const system = await buildSystemPrompt(message, opts?.contextRef);
  const compressed = await compressIfNeeded(history);

  return textStream({
    task: "decision",
    system,
    messages: [...compressed, { role: "user", content: message }],
    maxTokens: 2500,
  });
}
