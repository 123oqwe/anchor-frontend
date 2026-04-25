/**
 * L3 Cognition — Twin Agent.
 *
 * Learns user behavior from 4 sources:
 *   1. Edit diffs (user modifies suggestions)
 *   2. Execution results (did the plan work?)
 *   3. Accept/reject patterns (what types of plans get approved?)
 *   4. Outcome tracking (was the decision good in retrospect?)
 *
 * Produces:
 *   - Behavioral insights (preferences, tendencies)
 *   - Drift markers (behavior is changing)
 *   - Contraindications (what NOT to suggest)
 *
 * Pure cognition — no orchestration, no execution.
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { bus, type StepChange } from "../orchestration/bus.js";
import { text, object } from "../infra/compute/index.js";
import { writeMemory, writeTwinInsight, writeDialecticInsight } from "../memory/retrieval.js";
import { createNode } from "../graph/writer.js";
import { z } from "zod";
// Phase 2 pilot: Twin's identity/role/voice live in TwinAgentSpec, composed
// at runtime with user overrides. The legacy hardcoded prompt remains as
// fallback if the composer returns empty (defensive — composer never
// throws, but a malformed spec or DB issue could yield <50 chars).
import { TwinAgentSpec } from "./system-agents/twin.js";
import { composeSystemAgentConfig } from "./agent-spec.js";
import { buildSystemPromptFromConfig } from "./agent-config.js";
import { pickVariant } from "../orchestration/experiment-runner.js";

// Twin always returns the same minimal shape: a category + insight + confidence,
// optionally a contraindication. Defining once + reusing avoids the historical
// pattern of "ask LLM for JSON, regex out the brace block, hope JSON.parse
// doesn't throw." generateObject + this schema makes the contract explicit
// and the parse failure-proof (Vercel AI SDK auto-retries on mismatch).
const TwinInsightSchema = z.object({
  category: z.string().min(1),
  insight: z.string().min(1),
  confidence: z.number().min(0).max(1),
  contraindication: z.string().optional(),
});

const TwinDriftSchema = z.object({
  drift_detected: z.boolean(),
  drift_description: z.string().nullable(),
  old_pattern: z.string().nullable(),
  new_pattern: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

// ── 1. Learn from user edits ────────────────────────────────────────────────

export async function twinLearnFromEdits(changes: StepChange[]) {
  const meaningful = changes.filter(c => c.type !== "kept");
  if (meaningful.length === 0) return;
  console.log("[Twin Sidecar] Learning from user edits...");

  try {
    // Compose Soul/Body/Faculty header from spec + user overrides. The
    // schema-only operational instructions (output JSON shape, example)
    // stay inline because they're how this CALL works, not who Twin IS.
    const composed = composeSystemAgentConfig(TwinAgentSpec);
    const specHeader = buildSystemPromptFromConfig(composed);

    const operationalInstructions = `Extract ONE insight AND check if this reveals something the system should STOP suggesting.

Respond ONLY with JSON:
{"category":"string","insight":"string","confidence":0.0-1.0,"contraindication":"string or null"}

contraindication = something the system should NOT suggest in the future (null if none).
Example: user always deletes "schedule a call" → contraindication: "Do not suggest phone calls"`;

    // Defensive fallback: if composer returned empty/nearly-empty, use
    // legacy preamble so we never ship a contentless system prompt.
    const baseSystem = specHeader && specHeader.length >= 50
      ? `${specHeader}\n\n${operationalInstructions}`
      : `You are Anchor's Twin Agent. Observe how the user modifies AI suggestions.\n${operationalInstructions}`;
    // Sprint A — #7 prompt A/B. No experiment → identical to baseSystem.
    const finalSystem = pickVariant({ key: "twin.edit_learning_prompt", fallback: baseSystem }).value;

    const parsed = await object({
      task: "twin_edit_learning",
      schema: TwinInsightSchema,
      system: finalSystem,
      messages: [{
        role: "user",
        content: `Changes:\n${meaningful.map(c => {
          if (c.type === "deleted") return `DELETED: "${c.before}"`;
          if (c.type === "modified") return `CHANGED: "${c.before}" → "${c.after}"`;
          if (c.type === "added") return `ADDED: "${c.content}"`;
          return "";
        }).join("\n")}`,
      }],
      maxTokens: 250,
    });

    if (parsed.insight) {
      writeTwinInsight({ category: parsed.category, insight: parsed.insight, confidence: parsed.confidence });
      const nodeType = parsed.category.includes("preference") ? "preference" : "behavioral_pattern";
      const shortLabel = `${parsed.category.replace(/_/g, " ")}: ${parsed.insight.split(/[.!,;]/)[0].trim()}`.slice(0, 40);
      createNode({ domain: "growth", label: shortLabel, type: nodeType, status: "active", captured: "Twin Agent inference", detail: parsed.insight });

      // Contraindication → write to graph as a constraint
      if (parsed.contraindication) {
        createNode({ domain: "growth", label: `Avoid: ${parsed.contraindication.slice(0, 30)}`, type: "constraint", status: "active", captured: "Twin contraindication", detail: parsed.contraindication });
        logExecution("Twin Agent", `Contraindication: ${parsed.contraindication.slice(0, 50)}`);
      }

      // Dialectic detection
      const modified = changes.filter(c => c.type === "modified");
      for (const m of modified) {
        if (m.before && m.after && m.before !== m.after) {
          writeDialecticInsight({ stated: `System: "${m.before}"`, observed: `User: "${m.after}"`, tension: "User rejected suggestion" });
        }
      }

      logExecution("Twin Agent", `Edit insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Sidecar] Error:", err.message);
    logExecution("Twin Agent", `Edit learning failed: ${err.message}`, "failed");
  }
}

// ── 2. Learn from execution results ─────────────────────────────────────────

export async function twinLearnFromResults(payload: { steps_result: any[]; plan_summary: string }) {
  console.log("[Twin Agent] Learning from execution results...");
  try {
    const parsed = await object({
      task: "twin_result_learning",
      schema: TwinInsightSchema,
      system: `You are Anchor's Twin Agent. Analyze execution results. Extract ONE insight.`,
      messages: [{
        role: "user",
        content: `Plan: ${payload.plan_summary}\n\nResults:\n${payload.steps_result.map(s => `[${s.status}] ${s.step}: ${s.result}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    if (parsed.insight) {
      writeTwinInsight({ category: parsed.category, insight: parsed.insight, confidence: parsed.confidence });
      writeMemory({ type: "episodic", title: "Execution Result", content: `Plan: ${payload.plan_summary}. ${payload.steps_result.length} steps.`, tags: ["execution", "result"], source: "Execution Agent", confidence: 0.9 });
      logExecution("Twin Agent", `Result insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Agent] Error:", err.message);
    logExecution("Twin Agent", `Result learning failed: ${err.message}`, "failed");
  }
}

// ── 3. Accept/reject pattern tracking ───────────────────────────────────────

export function trackPlanDecision(action: "confirmed" | "rejected", stepSummary: string, stepCount: number) {
  // Record the decision
  writeMemory({
    type: "episodic",
    title: `Plan ${action}`,
    content: `${stepCount} steps ${action}: ${stepSummary.slice(0, 150)}`,
    tags: ["twin", "plan-decision", action],
    source: "Twin Agent",
    confidence: 0.9,
  });

  // Check pattern: are rejections increasing?
  const recentDecisions = db.prepare(
    "SELECT content, tags FROM memories WHERE user_id=? AND source='Twin Agent' AND tags LIKE '%plan-decision%' ORDER BY created_at DESC LIMIT 10"
  ).all(DEFAULT_USER_ID) as any[];

  const rejections = recentDecisions.filter(d => d.tags?.includes?.("rejected") || d.tags?.includes("rejected") || (typeof d.tags === "string" && d.tags.includes("rejected")));
  const total = recentDecisions.length;

  if (total >= 5 && rejections.length / total > 0.5) {
    writeTwinInsight({
      category: "plan_rejection_pattern",
      insight: `User rejects more than half of suggested plans. System may be misaligned with user preferences. Recent rejection rate: ${rejections.length}/${total}.`,
      confidence: 0.85,
    });
    logExecution("Twin Agent", `High rejection rate detected: ${rejections.length}/${total}`);
  }
}

// ── 4. Drift detection ──────────────────────────────────────────────────────

export async function detectDrift(): Promise<void> {
  // Compare recent insights (last 7 days) vs older insights (7-30 days)
  const recent = db.prepare(
    "SELECT category, insight FROM twin_insights WHERE user_id=? AND created_at >= datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 10"
  ).all(DEFAULT_USER_ID) as any[];

  const older = db.prepare(
    "SELECT category, insight FROM twin_insights WHERE user_id=? AND created_at < datetime('now', '-7 days') AND created_at >= datetime('now', '-30 days') ORDER BY created_at DESC LIMIT 10"
  ).all(DEFAULT_USER_ID) as any[];

  if (recent.length < 3 || older.length < 3) return; // not enough data

  try {
    const parsed = await object({
      task: "twin_edit_learning",
      schema: TwinDriftSchema,
      system: `You detect behavioral DRIFT — when a user's patterns are changing over time.
Compare recent vs older behavioral insights.`,
      messages: [{
        role: "user",
        content: `RECENT (last 7 days):\n${recent.map(r => `[${r.category}] ${r.insight}`).join("\n")}\n\nOLDER (7-30 days ago):\n${older.map(o => `[${o.category}] ${o.insight}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    if (parsed.drift_detected && parsed.drift_description) {
      writeTwinInsight({
        category: "drift",
        insight: `DRIFT: ${parsed.drift_description}. Was: ${parsed.old_pattern ?? "unknown"}. Now: ${parsed.new_pattern ?? "unknown"}.`,
        confidence: parsed.confidence,
      });
      createNode({
        domain: "growth",
        label: `Drift: ${parsed.drift_description.slice(0, 30)}`,
        type: "behavioral_pattern",
        status: "evolving",
        captured: "Twin drift detection",
        detail: `Old: ${parsed.old_pattern}. New: ${parsed.new_pattern}.`,
      });
      logExecution("Twin Agent", `Drift detected: ${parsed.drift_description.slice(0, 60)}`);
    }
  } catch (err: any) {
    console.error("[Twin Agent] Drift detection error:", err.message);
  }
}

// ── 5. Decision outcome tracking ────────────────────────────────────────────

export async function evaluateDecisionOutcome(
  originalPlan: string,
  executionResults: { step: string; status: string; result: string }[],
): Promise<void> {
  const successCount = executionResults.filter(r => r.status === "done").length;
  const failCount = executionResults.filter(r => r.status === "failed").length;
  const total = executionResults.length;

  if (total === 0) return;

  const successRate = successCount / total;

  // Record outcome
  writeMemory({
    type: "episodic",
    title: `Decision Outcome: ${successRate >= 0.8 ? "good" : successRate >= 0.5 ? "mixed" : "poor"}`,
    content: `Plan: ${originalPlan.slice(0, 100)}. Success: ${successCount}/${total}. Failures: ${failCount}.`,
    tags: ["decision-outcome", successRate >= 0.8 ? "good" : "poor"],
    source: "Twin Agent",
    confidence: 0.9,
  });

  // Track outcome patterns
  const recentOutcomes = db.prepare(
    "SELECT tags FROM memories WHERE user_id=? AND source='Twin Agent' AND tags LIKE '%decision-outcome%' ORDER BY created_at DESC LIMIT 10"
  ).all(DEFAULT_USER_ID) as any[];

  const poorCount = recentOutcomes.filter(o => {
    const tags = typeof o.tags === "string" ? o.tags : JSON.stringify(o.tags);
    return tags.includes("poor");
  }).length;

  if (recentOutcomes.length >= 5 && poorCount / recentOutcomes.length > 0.4) {
    writeTwinInsight({
      category: "decision_quality",
      insight: `Decision quality declining: ${poorCount} of last ${recentOutcomes.length} decisions had poor outcomes. System may need to recalibrate its recommendation strategy.`,
      confidence: 0.8,
    });
    logExecution("Twin Agent", `Decision quality declining: ${poorCount}/${recentOutcomes.length} poor`);
  }

  logExecution("Twin Agent", `Outcome tracked: ${successCount}/${total} success`);
}
