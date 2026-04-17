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
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { bus, type StepChange } from "../orchestration/bus.js";
import { text } from "../infra/compute/index.js";
import { writeMemory, writeTwinInsight, writeDialecticInsight } from "../memory/retrieval.js";
import { createNode } from "../graph/writer.js";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── 1. Learn from user edits ────────────────────────────────────────────────

export async function twinLearnFromEdits(changes: StepChange[]) {
  const meaningful = changes.filter(c => c.type !== "kept");
  if (meaningful.length === 0) return;
  console.log("[Twin Sidecar] Learning from user edits...");

  try {
    const result = await text({
      task: "twin_edit_learning",
      system: `You are Anchor's Twin Agent. Observe how the user modifies AI suggestions.
Extract ONE insight AND check if this reveals something the system should STOP suggesting.

Respond ONLY with JSON:
{"category":"string","insight":"string","confidence":0.0-1.0,"contraindication":"string or null"}

contraindication = something the system should NOT suggest in the future (null if none).
Example: user always deletes "schedule a call" → contraindication: "Do not suggest phone calls"`,
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

    const jsonMatch = result.replace(/```json\s*/g, "").replace(/```/g, "").match(/\{[^}]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      writeTwinInsight({ category: parsed.category ?? "behavior", insight: parsed.insight, confidence: parsed.confidence ?? 0.7 });
      const nodeType = (parsed.category ?? "").includes("preference") ? "preference" : "behavioral_pattern";
      const shortLabel = `${(parsed.category ?? "pattern").replace(/_/g, " ")}: ${parsed.insight.split(/[.!,;]/)[0].trim()}`.slice(0, 40);
      createNode({ domain: "growth", label: shortLabel, type: nodeType, status: "active", captured: "Twin Agent inference", detail: parsed.insight });

      // Contraindication → write to graph as a constraint
      if (parsed.contraindication) {
        createNode({ domain: "growth", label: `Avoid: ${parsed.contraindication.slice(0, 30)}`, type: "constraint", status: "active", captured: "Twin contraindication", detail: parsed.contraindication });
        log("Twin Agent", `Contraindication: ${parsed.contraindication.slice(0, 50)}`);
      }

      // Dialectic detection
      const modified = changes.filter(c => c.type === "modified");
      for (const m of modified) {
        if (m.before && m.after && m.before !== m.after) {
          writeDialecticInsight({ stated: `System: "${m.before}"`, observed: `User: "${m.after}"`, tension: "User rejected suggestion" });
        }
      }

      log("Twin Agent", `Edit insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Sidecar] Error:", err.message);
    log("Twin Agent", `Edit learning failed: ${err.message}`, "failed");
  }
}

// ── 2. Learn from execution results ─────────────────────────────────────────

export async function twinLearnFromResults(payload: { steps_result: any[]; plan_summary: string }) {
  console.log("[Twin Agent] Learning from execution results...");
  try {
    const result = await text({
      task: "twin_result_learning",
      system: `You are Anchor's Twin Agent. Analyze execution results. Extract ONE insight.
Respond ONLY with JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Plan: ${payload.plan_summary}\n\nResults:\n${payload.steps_result.map(s => `[${s.status}] ${s.step}: ${s.result}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    const jsonMatch = result.replace(/```json\s*/g, "").replace(/```/g, "").match(/\{[^}]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      writeTwinInsight({ category: parsed.category ?? "behavior", insight: parsed.insight, confidence: parsed.confidence ?? 0.7 });
      writeMemory({ type: "episodic", title: "Execution Result", content: `Plan: ${payload.plan_summary}. ${payload.steps_result.length} steps.`, tags: ["execution", "result"], source: "Execution Agent", confidence: 0.9 });
      log("Twin Agent", `Result insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Agent] Error:", err.message);
    log("Twin Agent", `Result learning failed: ${err.message}`, "failed");
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
    log("Twin Agent", `High rejection rate detected: ${rejections.length}/${total}`);
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
    const result = await text({
      task: "twin_edit_learning",
      system: `You detect behavioral DRIFT — when a user's patterns are changing over time.
Compare recent vs older behavioral insights.

Respond ONLY with JSON:
{
  "drift_detected": true|false,
  "drift_description": "what changed (or null if no drift)",
  "old_pattern": "what they used to do",
  "new_pattern": "what they do now",
  "confidence": 0.0-1.0
}`,
      messages: [{
        role: "user",
        content: `RECENT (last 7 days):\n${recent.map(r => `[${r.category}] ${r.insight}`).join("\n")}\n\nOLDER (7-30 days ago):\n${older.map(o => `[${o.category}] ${o.insight}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    const jsonMatch = result.replace(/```json\s*/g, "").replace(/```/g, "").match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.drift_detected && parsed.drift_description) {
      writeTwinInsight({
        category: "drift",
        insight: `DRIFT: ${parsed.drift_description}. Was: ${parsed.old_pattern ?? "unknown"}. Now: ${parsed.new_pattern ?? "unknown"}.`,
        confidence: parsed.confidence ?? 0.6,
      });
      createNode({
        domain: "growth",
        label: `Drift: ${parsed.drift_description.slice(0, 30)}`,
        type: "behavioral_pattern",
        status: "evolving",
        captured: "Twin drift detection",
        detail: `Old: ${parsed.old_pattern}. New: ${parsed.new_pattern}.`,
      });
      log("Twin Agent", `Drift detected: ${parsed.drift_description.slice(0, 60)}`);
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
    log("Twin Agent", `Decision quality declining: ${poorCount}/${recentOutcomes.length} poor`);
  }

  log("Twin Agent", `Outcome tracked: ${successCount}/${total} success`);
}
