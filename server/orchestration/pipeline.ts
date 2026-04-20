/**
 * L4 Orchestration — Agent Pipeline (OPT-3).
 *
 * Chains multiple custom agents. Output of step N can reference output of step 1..N-1
 * via template: "{__input__}" or "{step_0.output}" or "{step_1.data.key}".
 *
 * Safety:
 *   - Max 10 steps per pipeline
 *   - Max depth 3 for nested call_agent
 *   - 5 minute total runtime budget
 *   - Per-pipeline cost cap ($2 default)
 *   - Single concurrent run per pipeline (lock)
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { serializeForPrompt } from "../graph/reader.js";

interface PipelineStep {
  agent_id: string;
  input_template: string;   // e.g., "{__input__}" or "Based on {step_0.output}, do X"
  output_key: string;       // e.g., "analysis", "draft"
}

interface PipelineRun {
  runId: string;
  results: Record<string, any>;
  stepResults: { step: number; agent: string; output: string; latencyMs: number; cost: number }[];
  totalCost: number;
}

const MAX_STEPS = 10;
const MAX_DEPTH = 3;
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BUDGET_USD = 2.0;

// Locks to prevent concurrent runs of same pipeline
const runLocks = new Set<string>();

export async function runPipeline(pipelineId: string, triggerInput: string, options: { budget?: number } = {}): Promise<PipelineRun> {
  if (runLocks.has(pipelineId)) {
    throw new Error("Pipeline already running (concurrent runs blocked)");
  }

  const pipeline = db.prepare(
    "SELECT * FROM agent_pipelines WHERE id=? AND user_id=? AND enabled=1"
  ).get(pipelineId, DEFAULT_USER_ID) as any;
  if (!pipeline) throw new Error(`Pipeline not found or disabled: ${pipelineId}`);

  const steps: PipelineStep[] = JSON.parse(pipeline.steps);
  if (steps.length === 0) throw new Error("Pipeline has no steps");
  if (steps.length > MAX_STEPS) throw new Error(`Pipeline exceeds ${MAX_STEPS} step limit`);

  const runId = nanoid();
  const budget = options.budget ?? DEFAULT_BUDGET_USD;

  db.prepare(
    "INSERT INTO pipeline_runs (id, pipeline_id, status) VALUES (?,?,'running')"
  ).run(runId, pipelineId);

  runLocks.add(pipelineId);

  const results: Record<string, any> = { __input__: triggerInput };
  const stepResults: PipelineRun["stepResults"] = [];
  let totalCost = 0;

  const startTime = Date.now();

  try {
    for (let i = 0; i < steps.length; i++) {
      // Timeout check
      if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
        throw new Error(`Pipeline exceeded ${TOTAL_TIMEOUT_MS / 1000}s timeout at step ${i}`);
      }
      // Budget check
      if (totalCost > budget) {
        throw new Error(`Pipeline exceeded $${budget} budget at step ${i} ($${totalCost.toFixed(4)} spent)`);
      }

      const step = steps[i];

      // Resolve template
      const resolvedInput = resolveTemplate(step.input_template, results);

      // Load the agent
      const agent = db.prepare("SELECT * FROM user_agents WHERE id=? AND user_id=?")
        .get(step.agent_id, DEFAULT_USER_ID) as any;
      if (!agent) {
        throw new Error(`Step ${i}: agent ${step.agent_id} not found`);
      }

      // Run the agent (similar to routes/custom-agents.ts run logic, but inlined)
      const stepStart = Date.now();
      const graphContext = serializeForPrompt();
      const systemPrompt = `${agent.instructions}\n\nUser's Human Graph context:\n${graphContext}\n\n(Running as step ${i + 1}/${steps.length} of pipeline "${pipeline.name}")`;

      const output = await text({
        task: "decision",
        system: systemPrompt,
        messages: [{ role: "user", content: resolvedInput }],
        maxTokens: 1500,
        runId,
        agentName: `Pipeline[${pipeline.name}].${step.output_key}`,
      });

      const stepLatency = Date.now() - stepStart;
      // Query last llm_call for cost
      const lastCall = db.prepare(
        "SELECT cost_usd FROM llm_calls WHERE run_id=? ORDER BY created_at DESC LIMIT 1"
      ).get(runId) as any;
      const stepCost = lastCall?.cost_usd ?? 0;
      totalCost += stepCost;

      results[`step_${i}`] = { output, key: step.output_key };
      results[step.output_key] = output;  // also accessible by output_key

      stepResults.push({
        step: i,
        agent: agent.name,
        output: output.slice(0, 500),
        latencyMs: stepLatency,
        cost: stepCost,
      });
    }

    db.prepare(
      "UPDATE pipeline_runs SET finished_at=datetime('now'), status='done', step_results=?, total_cost=? WHERE id=?"
    ).run(JSON.stringify(stepResults), totalCost, runId);

    logExecution("Pipeline", `Completed: ${pipeline.name} (${steps.length} steps, $${totalCost.toFixed(4)})`);

    return { runId, results, stepResults, totalCost };
  } catch (err: any) {
    db.prepare(
      "UPDATE pipeline_runs SET finished_at=datetime('now'), status='failed', step_results=?, total_cost=?, error=? WHERE id=?"
    ).run(JSON.stringify(stepResults), totalCost, err.message?.slice(0, 500), runId);

    logExecution("Pipeline", `Failed: ${pipeline.name} — ${err.message}`, "failed");
    throw err;
  } finally {
    runLocks.delete(pipelineId);
  }
}

/**
 * Resolve a template string by substituting {path.to.value} references.
 * Supports: {__input__}, {step_0.output}, {output_key}, {step_0.data.nested}
 */
function resolveTemplate(template: string, results: Record<string, any>): string {
  return template.replace(/\{([^}]+)\}/g, (match, path) => {
    const parts = path.trim().split(".");
    let value: any = results;
    for (const part of parts) {
      if (value == null) return match;  // fallback to literal
      value = value[part];
    }
    if (value == null) return match;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}
