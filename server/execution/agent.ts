/**
 * L5 Execution — Execution Agent (ReAct loop with checkpoints).
 *
 * Patterns used:
 * - Anthropic tool_use agent loop (stateless, iteration-capped)
 * - Checkpoint-based recovery (save state per step)
 * - Tool composition (previous results injected as context)
 * - Structured error classification (success / error / retry / skip)
 * - Per-tool execution logging with input/output/latency
 * - Unified tool interface via registry
 */
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { bus, type EditableStep } from "../orchestration/bus.js";
import { routeTask } from "../infra/compute/router.js";
import { getApiKey } from "../infra/compute/keys.js";
import { getAllTools, executeTool, getToolsForLLM, type ToolResult, type ExecutionContext } from "./registry.js";
import { shouldUseSwarm, planExecution, runExecutionSwarm } from "./swarm.js";

// ── Checkpoint ──────────────────────────────────────────────────────────────

interface Checkpoint {
  stepIndex: number;
  toolName: string;
  input: any;
  result: ToolResult;
  timestamp: string;
}

// ── Context helpers ────────────────────────────────────────────────────────

/** Get context for execution: relevant graph nodes, memories, recent activity. */
function getExecutionContext(steps: EditableStep[]): string {
  const lines: string[] = [];
  const stepsText = steps.map(s => s.content).join(" ");

  // Find mentioned people in the plan steps
  const people = db.prepare(
    "SELECT id, label, detail, status FROM graph_nodes WHERE user_id=? AND type='person'"
  ).all(DEFAULT_USER_ID) as any[];

  const mentionedPeople = people.filter((p: any) => {
    const firstName = p.label.split(/[\s(]/)[0];
    return firstName.length >= 2 && stepsText.toLowerCase().includes(firstName.toLowerCase());
  });

  if (mentionedPeople.length > 0) {
    lines.push("PEOPLE MENTIONED:");
    for (const p of mentionedPeople) {
      lines.push(`  ${p.label} (${p.status}): ${(p.detail ?? "").slice(0, 100)}`);
      // Get recent memories about this person
      const mems = db.prepare(
        "SELECT title, content FROM memories WHERE user_id=? AND (content LIKE ? OR title LIKE ?) ORDER BY created_at DESC LIMIT 2"
      ).all(DEFAULT_USER_ID, `%${p.label.split(/[\s(]/)[0]}%`, `%${p.label.split(/[\s(]/)[0]}%`) as any[];
      for (const m of mems) {
        lines.push(`    Memory: ${m.content.slice(0, 80)}`);
      }
    }
  }

  // Recent activity context (last 2 hours)
  const recentActivity = db.prepare(
    "SELECT app_name, window_title, content FROM activity_captures WHERE user_id=? AND captured_at >= datetime('now', '-2 hours') AND window_title != '' ORDER BY captured_at DESC LIMIT 5"
  ).all(DEFAULT_USER_ID) as any[];

  if (recentActivity.length > 0) {
    lines.push("RECENT ACTIVITY:");
    for (const a of recentActivity) {
      lines.push(`  ${(a as any).app_name}: ${(a as any).window_title.slice(0, 60)}`);
    }
  }

  return lines.join("\n") || "No additional context available.";
}

/** Get writing style hint from evolution_state. */
function getWritingStyleHint(): string {
  const style = db.prepare(
    "SELECT current_value FROM evolution_state WHERE user_id=? AND dimension='writing_style'"
  ).get(DEFAULT_USER_ID) as any;
  if (style?.current_value) return style.current_value;
  // Fallback: analyze recent messages
  const msgs = db.prepare(
    "SELECT content FROM messages WHERE user_id=? AND role='user' AND mode='personal' ORDER BY created_at DESC LIMIT 10"
  ).all(DEFAULT_USER_ID) as any[];
  if (msgs.length < 3) return "professional, concise";
  const avgLen = msgs.reduce((s: number, m: any) => s + m.content.length, 0) / msgs.length;
  if (avgLen < 50) return "very concise, direct, minimal";
  if (avgLen > 200) return "detailed, analytical, thorough";
  return "balanced, professional";
}

// ── Main ReAct execution ────────────────────────────────────────────────────

export async function runExecutionReAct(steps: EditableStep[]) {
  // Route: 3+ steps → Execution Swarm (parallel phases), 1-2 steps → sequential ReAct
  if (shouldUseSwarm(steps)) {
    console.log(`[Execution Agent] ${steps.length} steps → routing to Execution Swarm`);
    logExecution("Execution Agent", `Swarm mode: ${steps.length} steps`);
    try {
      const plan = await planExecution(steps);
      const swarmResult = await runExecutionSwarm(plan);

      // Convert swarm results to standard format for EXECUTION_DONE event
      const stepsResult = swarmResult.phases.flatMap(p =>
        p.results.map(r => ({ step: r.tool, status: r.success ? "done" : "error", result: r.output }))
      );

      bus.publish({
        type: "EXECUTION_DONE",
        payload: { steps_result: stepsResult, plan_summary: steps.map(s => s.content).join("; ") },
      });
      return;
    } catch (err: any) {
      console.error("[Execution Swarm] Failed, falling back to ReAct:", err.message);
      // Fall through to sequential ReAct
    }
  }

  console.log(`[Execution Agent] ReAct starting with ${steps.length} steps...`);
  logExecution("Execution Agent", `ReAct: ${steps.length} steps`);

  const { model: routedModel } = routeTask("react_execution");
  const modelId = routedModel.id;
  console.log(`[Execution] react_execution → ${routedModel.name} (${routedModel.provider})`);

  const apiKey = getApiKey(routedModel.provider);
  if (!apiKey) {
    logExecution("Execution Agent", "No API key for execution model", "failed");
    bus.publish({ type: "EXECUTION_DONE", payload: { steps_result: [], plan_summary: steps.map(s => s.content).join("; ") } });
    return;
  }

  const anthropic = new Anthropic({ apiKey });

  // Build tool list from registry
  const toolDefs = getToolsForLLM();

  const stepsText = steps.map(s => `Step ${s.id}: ${s.content}${s.time_estimate ? ` (est: ${s.time_estimate})` : ""}`).join("\n");
  const stepsResult: { step: string; status: string; result: string; input?: any; latencyMs?: number }[] = [];
  const checkpoints: Checkpoint[] = [];
  const messages: Anthropic.Messages.MessageParam[] = [{
    role: "user",
    content: `Execute this plan step by step. Use one tool per step. After all steps, call record_outcome with a summary of what was accomplished.\n\nPlan:\n${stepsText}`,
  }];

  const MAX_TURNS = 12;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.messages.create({
        model: modelId,
        max_tokens: 1024,
        system: `You are Anchor's Execution Agent. Execute each plan step using the available tools.

RULES:
1. Use exactly ONE tool per plan step.
2. After executing all steps, call record_outcome with a summary.
3. If a tool returns an error, note it and continue to the next step.
4. Do not skip steps — attempt each one.
5. When drafting emails or messages, use the CONTEXT below to personalize content.
6. Match the user's writing style: ${getWritingStyleHint()}

CONTEXT (use this to make emails/drafts specific and personal):
${getExecutionContext(steps)}

Available tools: ${toolDefs.map(t => t.name).join(", ")}`,
        tools: toolDefs as any,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b: any) => b.type === "tool_use") as Anthropic.Messages.ToolUseBlock[];

      if (toolUses.length === 0) break;

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        // Build execution context (tool composition)
        const context: ExecutionContext = {
          previousResults: stepsResult.map(r => ({ toolName: r.step, output: r.result, data: undefined })),
          stepIndex: stepsResult.length,
          totalSteps: steps.length,
        };

        // Execute via registry (includes L6 gate + logging)
        const start = Date.now();
        const result = await executeTool(tu.name, tu.input, context, "user_triggered");
        const latency = Date.now() - start;

        // Checkpoint
        checkpoints.push({
          stepIndex: stepsResult.length,
          toolName: tu.name,
          input: tu.input,
          result,
          timestamp: new Date().toISOString(),
        });

        stepsResult.push({
          step: tu.name,
          status: result.success ? "done" : "error",
          result: result.output,
          input: tu.input,
          latencyMs: latency,
        });

        // Return result to LLM (mark errors so LLM adapts)
        const resultContent = result.success
          ? result.output
          : `ERROR: ${result.output}${result.shouldRetry ? " (retryable)" : ""}`;

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: resultContent,
          ...(result.success ? {} : { is_error: true } as any),
        });
      }

      messages.push({ role: "user", content: toolResults });
      if (response.stop_reason === "end_turn") break;
    }

    const successCount = stepsResult.filter(r => r.status === "done").length;
    const errorCount = stepsResult.filter(r => r.status === "error").length;
    logExecution("Execution Agent", `ReAct done: ${successCount} success, ${errorCount} errors, ${stepsResult.length} total`);
    console.log(`[Execution Agent] ReAct done. ${successCount}/${stepsResult.length} successful.`);

    bus.publish({
      type: "EXECUTION_DONE",
      payload: {
        steps_result: stepsResult,
        plan_summary: steps.map(s => s.content).join("; "),
      },
    });
  } catch (err: any) {
    console.error("[Execution Agent] ReAct error:", err.message);
    logExecution("Execution Agent", `ReAct failed: ${err.message}`, "failed");

    // Emit partial results even on failure
    if (stepsResult.length > 0) {
      bus.publish({
        type: "EXECUTION_DONE",
        payload: {
          steps_result: stepsResult,
          plan_summary: steps.map(s => s.content).join("; ") + " (partial — error during execution)",
        },
      });
    }
  }
}
