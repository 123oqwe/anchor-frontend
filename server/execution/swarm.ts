/**
 * L5 Execution — Execution Swarm.
 *
 * NOT the same as L3 Cognitive Swarm (debate about WHAT to do).
 * This is about HOW to execute — multiple parallel execution threads
 * for independent steps, with dependency-aware scheduling.
 *
 * Patterns:
 * - Independent steps run in parallel (Promise.all)
 * - Dependent steps run sequentially (A finishes → B starts)
 * - Specialized dispatch: API steps → API handler, code steps → code handler
 * - Coordinator collects results + handles partial failures
 * - Each thread has its own checkpoint
 */
import { type EditableStep } from "../orchestration/bus.js";
import { executeTool, getAllTools, type ToolResult, type ExecutionContext } from "./registry.js";
import { logExecution } from "../infra/storage/db.js";
import { text } from "../infra/compute/index.js";

// ── Dependency analysis ─────────────────────────────────────────────────────

interface ExecutionPlan {
  phases: ExecutionPhase[];   // phases run sequentially, steps within a phase run in parallel
}

interface ExecutionPhase {
  phaseIndex: number;
  steps: StepAssignment[];
}

interface StepAssignment {
  step: EditableStep;
  suggestedTool: string;
  dependsOnPhase?: number;   // must wait for this phase to complete
}

/**
 * Analyze steps and group into parallel phases.
 * Uses LLM to determine which steps are independent vs dependent.
 */
export async function planExecution(steps: EditableStep[]): Promise<ExecutionPlan> {
  if (steps.length <= 2) {
    // Simple: all sequential, no parallelism needed
    return {
      phases: steps.map((s, i) => ({
        phaseIndex: i,
        steps: [{ step: s, suggestedTool: suggestTool(s.content) }],
      })),
    };
  }

  try {
    const toolNames = getAllTools().map(t => `${t.name}: ${t.description}`).join("\n");

    const result = await text({
      task: "twin_edit_learning", // cheap model
      system: `You analyze execution steps and group them into parallel phases.
Steps in the SAME phase can run simultaneously (they don't depend on each other).
Steps in LATER phases depend on earlier phases completing first.

Available tools:
${toolNames}

Respond ONLY with JSON:
{
  "phases": [
    { "phase": 0, "steps": [{ "step_id": 1, "tool": "write_task", "reason": "why this tool" }] },
    { "phase": 1, "steps": [{ "step_id": 3, "tool": "read_url", "depends_on_phase": 0 }] }
  ]
}

Group independent steps into the same phase for parallel execution.`,
      messages: [{
        role: "user",
        content: `Plan steps:\n${steps.map(s => `${s.id}: ${s.content}`).join("\n")}`,
      }],
      maxTokens: 400,
    });

    const stripped = result.replace(/```json\s*/g, "").replace(/```/g, "");
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    if (Array.isArray(parsed.phases) && parsed.phases.length > 0) {
      return {
        phases: parsed.phases.map((p: any) => ({
          phaseIndex: p.phase ?? 0,
          steps: (p.steps ?? []).map((s: any) => {
            const originalStep = steps.find(st => st.id === s.step_id) ?? steps[0];
            return {
              step: originalStep,
              suggestedTool: s.tool ?? suggestTool(originalStep.content),
              dependsOnPhase: s.depends_on_phase,
            };
          }),
        })),
      };
    }
  } catch {}

  // Fallback: sequential phases
  return {
    phases: steps.map((s, i) => ({
      phaseIndex: i,
      steps: [{ step: s, suggestedTool: suggestTool(s.content) }],
    })),
  };
}

// ── Simple tool suggestion based on step content ────────────────────────────

function suggestTool(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("search") || lower.includes("research") || lower.includes("look up")) return "web_search";
  if ((lower.includes("email") || lower.includes("send")) && (lower.includes("@") || lower.includes("to "))) return "send_email";
  if (lower.includes("http://") || lower.includes("https://") || lower.includes("check website") || lower.includes("fetch url")) return "read_url";
  if (lower.includes("calendar") || lower.includes("schedule") || lower.includes("meeting")) return "create_calendar_event";
  if (lower.includes("```") || lower.includes("function(") || lower.includes("const ") || lower.includes("let ")) return "execute_code";
  if (lower.includes("update") && (lower.includes("status") || lower.includes("graph") || lower.includes("node"))) return "update_graph_node";
  return "write_task"; // default: create a task for it
}

// ── Execution Swarm runner ──────────────────────────────────────────────────

export interface SwarmResult {
  phases: {
    phaseIndex: number;
    results: { step: string; tool: string; success: boolean; output: string; latencyMs: number }[];
    parallelCount: number;
  }[];
  totalSuccess: number;
  totalFailed: number;
  totalSteps: number;
}

/**
 * Run an execution plan with parallel phases.
 * Steps within a phase run concurrently. Phases run sequentially.
 */
export async function runExecutionSwarm(plan: ExecutionPlan): Promise<SwarmResult> {
  console.log(`[Execution Swarm] ${plan.phases.length} phases, ${plan.phases.reduce((s, p) => s + p.steps.length, 0)} total steps`);
  logExecution("Execution Swarm", `Starting: ${plan.phases.length} phases`);

  const phaseResults: SwarmResult["phases"] = [];
  const allPreviousResults: { toolName: string; output: string; data?: any }[] = [];
  let totalSuccess = 0;
  let totalFailed = 0;

  for (const phase of plan.phases) {
    console.log(`[Execution Swarm] Phase ${phase.phaseIndex}: ${phase.steps.length} steps ${phase.steps.length > 1 ? "(parallel)" : "(sequential)"}`);

    // Execute all steps in this phase in parallel
    const stepPromises = phase.steps.map(async (assignment) => {
      const context: ExecutionContext = {
        previousResults: [...allPreviousResults],
        stepIndex: allPreviousResults.length,
        totalSteps: plan.phases.reduce((s, p) => s + p.steps.length, 0),
      };

      // Construct proper tool input using LLM
      const toolInput = await constructToolInput(assignment.suggestedTool, assignment.step.content, context);

      const start = Date.now();
      let result = await executeTool(assignment.suggestedTool, toolInput, context, "user_triggered");
      let latency = Date.now() - start;

      // Retry once if retryable
      if (!result.success && result.shouldRetry) {
        console.log(`[Execution Swarm] Retrying ${assignment.suggestedTool}...`);
        const retryStart = Date.now();
        result = await executeTool(assignment.suggestedTool, toolInput, context, "user_triggered");
        latency += Date.now() - retryStart;
      }

      return {
        step: assignment.step.content,
        tool: assignment.suggestedTool,
        success: result.success,
        output: result.output,
        latencyMs: latency,
        data: result.data,
      };
    });

    const results = await Promise.all(stepPromises);

    // Collect results for next phase's context
    for (const r of results) {
      allPreviousResults.push({ toolName: r.tool, output: r.output, data: r.data });
      if (r.success) totalSuccess++;
      else totalFailed++;
    }

    phaseResults.push({
      phaseIndex: phase.phaseIndex,
      results,
      parallelCount: phase.steps.length,
    });
  }

  logExecution("Execution Swarm", `Complete: ${totalSuccess} success, ${totalFailed} failed across ${plan.phases.length} phases`);
  console.log(`[Execution Swarm] Done: ${totalSuccess}/${totalSuccess + totalFailed} successful`);

  return { phases: phaseResults, totalSuccess, totalFailed, totalSteps: totalSuccess + totalFailed };
}

function extractUrl(content: string): string {
  const match = content.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : content;
}

// ── LLM-constructed tool input ──────────────────────────────────────────────

async function constructToolInput(toolName: string, stepContent: string, context: ExecutionContext): Promise<any> {
  const tool = getAllTools().find(t => t.name === toolName);
  if (!tool) return { title: stepContent, summary: stepContent };

  // If there are previous results AND step references them, always use LLM
  const hasPrevContext = context.previousResults.length > 0 && context.stepIndex > 0;

  // Simple tools with no previous context — deterministic
  if (!hasPrevContext) {
    if (toolName === "write_task") return { title: stepContent, priority: "high" };
    if (toolName === "record_outcome") return { summary: stepContent };
    if (toolName === "read_url") return { url: extractUrl(stepContent) };
    if (toolName === "web_search") return { query: stepContent };
  }

  // All tools with previous context, or complex tools — use LLM
  try {
    const prevContext = context.previousResults.length > 0
      ? `\nPrevious results:\n${context.previousResults.map(r => `${r.toolName}: ${r.output.slice(0, 100)}`).join("\n")}`
      : "";

    const result = await text({
      task: "twin_edit_learning",
      system: `You construct tool input parameters. Given a step description, a tool schema, and previous results, produce the correct JSON input.

Tool: ${tool.name}
Description: ${tool.description}
Input schema: ${JSON.stringify(tool.inputSchema)}
${prevContext}

RULES:
- For execute_code: produce a single code block that solves the step; use anchor.* if cross-system calls needed
- For write_task: if previous results contain useful info, incorporate it into the title
- For record_outcome: summarize ALL previous results into a meaningful summary
- Use information from previous results when relevant

Respond ONLY with a JSON object matching the schema. No markdown.`,
      messages: [{ role: "user", content: `Step: ${stepContent}` }],
      maxTokens: 200,
    });

    const stripped = result.replace(/```json\s*/g, "").replace(/```/g, "");
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return parsed;
  } catch {
    // Fallback: pass step content as all required fields
    const fallback: any = {};
    for (const key of tool.inputSchema.required ?? []) {
      fallback[key] = stepContent;
    }
    return fallback;
  }
}

// ── Should use swarm? ───────────────────────────────────────────────────────

export function shouldUseSwarm(steps: EditableStep[]): boolean {
  // Use swarm when there are 3+ steps (potential for parallelism)
  return steps.length >= 3;
}
