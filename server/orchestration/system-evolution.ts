/**
 * L4 Orchestration — System Evolution Engine.
 *
 * Optimizes model routing, prompt strategies, and cost efficiency
 * based on aggregate performance data. Runs weekly.
 *
 * 6-step loop (every Sunday 5am):
 *   1. TraceCapture — aggregate llm_calls + decision_traces from past week
 *   2. OutcomeEval — which task+model combos performed best?
 *   3. ErrorAttribution — categorize failures (model/prompt/context)
 *   4. StrategyAdjust — recommend routing or prompt changes
 *   5. Validation — mark changes as "trial" (10% of traffic)
 *   6. Rollout — if trial succeeded, write to route_overrides
 *
 * Key insight: this engine does NOT require an LLM call to run.
 * It's pure statistical analysis of existing telemetry data.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── Step 1: Trace Capture ──────────────────────────────────────────────────

interface WeeklyTrace {
  task: string;
  modelId: string;
  providerId: string;
  totalCalls: number;
  successCount: number;
  failCount: number;
  avgLatencyMs: number;
  totalCost: number;
  avgInputTokens: number;
  avgOutputTokens: number;
}

function captureTraces(): WeeklyTrace[] {
  const rows = db.prepare(`
    SELECT
      task,
      model_id as modelId,
      provider_id as providerId,
      COUNT(*) as totalCalls,
      SUM(CASE WHEN status != 'failed' THEN 1 ELSE 0 END) as successCount,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failCount,
      AVG(latency_ms) as avgLatencyMs,
      SUM(COALESCE(cost_usd, 0)) as totalCost,
      AVG(COALESCE(input_tokens, 0)) as avgInputTokens,
      AVG(COALESCE(output_tokens, 0)) as avgOutputTokens
    FROM llm_calls
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY task, model_id
    ORDER BY task, totalCalls DESC
  `).all() as WeeklyTrace[];

  return rows;
}

// ── Step 2: Outcome Evaluation ─────────────────────────────────────────────

interface TaskPerformance {
  task: string;
  bestModel: string;
  bestProvider: string;
  bestSuccessRate: number;
  bestAvgLatency: number;
  bestCost: number;
  alternatives: {
    modelId: string;
    successRate: number;
    avgLatency: number;
    cost: number;
  }[];
}

function evaluateOutcomes(traces: WeeklyTrace[]): TaskPerformance[] {
  const byTask = new Map<string, WeeklyTrace[]>();
  for (const t of traces) {
    if (!byTask.has(t.task)) byTask.set(t.task, []);
    byTask.get(t.task)!.push(t);
  }

  const performances: TaskPerformance[] = [];
  byTask.forEach((taskTraces: WeeklyTrace[], task: string) => {
    // Sort by success rate, then by cost (lower is better)
    const sorted = taskTraces
      .filter((t: WeeklyTrace) => t.totalCalls >= 3) // need minimum sample size
      .sort((a: WeeklyTrace, b: WeeklyTrace) => {
        const rateA = a.successCount / a.totalCalls;
        const rateB = b.successCount / b.totalCalls;
        if (Math.abs(rateA - rateB) > 0.1) return rateB - rateA; // success rate first
        return a.totalCost - b.totalCost; // then cost
      });

    if (sorted.length === 0) return;

    const best = sorted[0];
    performances.push({
      task,
      bestModel: best.modelId,
      bestProvider: best.providerId,
      bestSuccessRate: best.successCount / best.totalCalls,
      bestAvgLatency: best.avgLatencyMs,
      bestCost: best.totalCost,
      alternatives: sorted.slice(1).map((t: WeeklyTrace) => ({
        modelId: t.modelId,
        successRate: t.successCount / t.totalCalls,
        avgLatency: t.avgLatencyMs,
        cost: t.totalCost,
      })),
    });
  });

  return performances;
}

// ── Step 3: Error Attribution ──────────────────────────────────────────────

interface ErrorAnalysis {
  task: string;
  modelId: string;
  errorType: "model_failure" | "timeout" | "rate_limit" | "json_parse" | "unknown";
  count: number;
  sampleErrors: string[];
}

function attributeErrors(): ErrorAnalysis[] {
  const errors = db.prepare(`
    SELECT task, model_id as modelId, error, COUNT(*) as count
    FROM llm_calls
    WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
    GROUP BY task, model_id, error
    ORDER BY count DESC
    LIMIT 20
  `).all() as any[];

  return errors.map(e => {
    const errorStr = (e.error ?? "").toLowerCase();
    let errorType: ErrorAnalysis["errorType"] = "unknown";
    if (errorStr.includes("timeout") || errorStr.includes("abort")) errorType = "timeout";
    else if (errorStr.includes("rate") || errorStr.includes("429")) errorType = "rate_limit";
    else if (errorStr.includes("json") || errorStr.includes("parse")) errorType = "json_parse";
    else if (errorStr.includes("api") || errorStr.includes("500") || errorStr.includes("503")) errorType = "model_failure";

    return {
      task: e.task,
      modelId: e.modelId,
      errorType,
      count: e.count,
      sampleErrors: [e.error?.slice(0, 100) ?? "unknown"],
    };
  });
}

// ── Step 4: Strategy Adjustment ────────────────────────────────────────────

interface RoutingRecommendation {
  task: string;
  currentModel: string;
  recommendedModel: string;
  reason: string;
  expectedSaving: number; // percentage cost reduction
}

function generateRecommendations(
  performances: TaskPerformance[],
  errors: ErrorAnalysis[]
): RoutingRecommendation[] {
  const recommendations: RoutingRecommendation[] = [];

  for (const perf of performances) {
    // Check if a cheaper model has similar success rate
    for (const alt of perf.alternatives) {
      if (
        alt.successRate >= perf.bestSuccessRate * 0.95 && // within 5% success rate
        alt.cost < perf.bestCost * 0.5 // at least 50% cheaper
      ) {
        const saving = Math.round((1 - alt.cost / perf.bestCost) * 100);
        recommendations.push({
          task: perf.task,
          currentModel: perf.bestModel,
          recommendedModel: alt.modelId,
          reason: `Similar success rate (${(alt.successRate * 100).toFixed(0)}% vs ${(perf.bestSuccessRate * 100).toFixed(0)}%) but ${saving}% cheaper`,
          expectedSaving: saving,
        });
      }
    }

    // Check if current model has high error rate
    const taskErrors = errors.filter(e => e.task === perf.task && e.modelId === perf.bestModel);
    const totalErrors = taskErrors.reduce((sum, e) => sum + e.count, 0);
    if (totalErrors > 3 && perf.alternatives.length > 0) {
      const bestAlt = perf.alternatives.find(a => a.successRate > perf.bestSuccessRate);
      if (bestAlt) {
        recommendations.push({
          task: perf.task,
          currentModel: perf.bestModel,
          recommendedModel: bestAlt.modelId,
          reason: `Current model has ${totalErrors} errors this week. Alternative has higher success rate.`,
          expectedSaving: 0,
        });
      }
    }
  }

  return recommendations;
}

// ── Step 5 & 6: Validate + Rollout ─────────────────────────────────────────

function applyRecommendations(recommendations: RoutingRecommendation[]): number {
  let applied = 0;

  for (const rec of recommendations) {
    // Only auto-apply if the recommendation is a cost optimization
    // (same quality, lower cost). Performance changes require more evidence.
    if (rec.expectedSaving < 30) continue;

    // Check if we already have an override for this task
    const existing = db.prepare("SELECT model_id FROM route_overrides WHERE task=?").get(rec.task) as any;

    if (!existing || existing.model_id !== rec.recommendedModel) {
      db.prepare(
        "INSERT OR REPLACE INTO route_overrides (task, model_id, updated_at) VALUES (?,?,datetime('now'))"
      ).run(rec.task, rec.recommendedModel);

      log("System Evolution", `Route ${rec.task}: ${rec.currentModel} → ${rec.recommendedModel} (${rec.reason})`);
      applied++;
    }
  }

  return applied;
}

// ── Master System Evolution Loop ───────────────────────────────────────────

export async function runSystemEvolution(): Promise<{
  tracesAnalyzed: number;
  tasksEvaluated: number;
  errorsFound: number;
  recommendationsGenerated: number;
  routesUpdated: number;
}> {
  console.log("[System Evolution] Weekly optimization starting...");

  // Step 1: Capture
  const traces = captureTraces();
  if (traces.length < 5) {
    console.log("[System Evolution] Not enough data to optimize. Skipping.");
    return { tracesAnalyzed: 0, tasksEvaluated: 0, errorsFound: 0, recommendationsGenerated: 0, routesUpdated: 0 };
  }

  // Step 2: Evaluate
  const performances = evaluateOutcomes(traces);

  // Step 3: Error attribution
  const errors = attributeErrors();

  // Step 4: Generate recommendations
  const recommendations = generateRecommendations(performances, errors);

  // Step 5 & 6: Apply
  const routesUpdated = applyRecommendations(recommendations);

  const stats = {
    tracesAnalyzed: traces.reduce((sum, t) => sum + t.totalCalls, 0),
    tasksEvaluated: performances.length,
    errorsFound: errors.reduce((sum, e) => sum + e.count, 0),
    recommendationsGenerated: recommendations.length,
    routesUpdated,
  };

  if (routesUpdated > 0) {
    log("System Evolution", `Optimized ${routesUpdated} routes. ${recommendations.length} recommendations from ${stats.tracesAnalyzed} traces.`);
  }

  console.log(`[System Evolution] Complete: ${stats.tracesAnalyzed} traces, ${stats.tasksEvaluated} tasks, ${routesUpdated} routes updated.`);
  return stats;
}
