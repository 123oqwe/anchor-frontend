/**
 * L5 Execution — Custom Agent ReAct loop.
 *
 * When a user-defined Custom Agent has tools in its whitelist, run an Anthropic
 * tool-use loop against those tools only. Without this, the /api/agents/custom/:id/run
 * endpoint falls back to plain text() which cannot use any tool — defeating the
 * entire point of allowing users to pick tools per agent.
 *
 * Scope:
 *   - Tools filtered to agent.tools whitelist (empty ⇒ no tool loop, plain text())
 *   - ExecutionContext carries agentId (OPT-5 KV scoping) + runId (OPT-4 traces)
 *   - Each tool call goes through registry.executeTool → L6 permission gate
 *   - LLM calls logged to llm_calls with agentName for admin trace view
 */
import Anthropic from "@anthropic-ai/sdk";
import { routeTask } from "../infra/compute/router.js";
import { getApiKey } from "../infra/compute/keys.js";
import { logCall } from "../infra/compute/telemetry.js";
import { getToolsForLLM, executeTool, type ExecutionContext } from "./registry.js";

export interface CustomAgentToolCall {
  name: string;
  input: any;
  output: string;
  success: boolean;
  latencyMs: number;
}

export interface CustomAgentReActResult {
  text: string;
  toolCalls: CustomAgentToolCall[];
  turns: number;
}

const MAX_TURNS = 8;
const MAX_TOKENS_PER_TURN = 1500;

export async function runCustomAgentReAct(opts: {
  agentId: string;
  agentName: string;
  systemPrompt: string;
  userMessage: string;
  allowedTools: string[];
  runId: string;
}): Promise<CustomAgentReActResult> {
  const { model: routedModel, capability } = routeTask("react_execution");
  const modelId = routedModel.id;
  const apiKey = getApiKey(routedModel.provider);
  if (!apiKey) throw new Error(`No API key for ${routedModel.provider}`);

  const anthropic = new Anthropic({ apiKey });

  const allTools = getToolsForLLM();
  const tools = allTools.filter(t => opts.allowedTools.includes(t.name));
  if (tools.length === 0) {
    throw new Error("No allowed tools matched registry (check agent.tools whitelist)");
  }

  const telemetryName = `Custom: ${opts.agentName}`;
  const toolCalls: CustomAgentToolCall[] = [];
  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: opts.userMessage }];
  let finalText = "";
  let turn = 0;

  for (; turn < MAX_TURNS; turn++) {
    const llmStart = Date.now();
    let response: Anthropic.Messages.Message;
    try {
      response = await anthropic.messages.create({
        model: modelId,
        max_tokens: MAX_TOKENS_PER_TURN,
        system: opts.systemPrompt,
        tools: tools as any,
        messages,
      });
      logCall({
        task: "react_execution",
        capability,
        modelId,
        providerId: routedModel.provider,
        inputTokens: (response.usage as any)?.input_tokens,
        outputTokens: (response.usage as any)?.output_tokens,
        latencyMs: Date.now() - llmStart,
        status: "success",
        runId: opts.runId,
        agentName: telemetryName,
        requestPreview: opts.userMessage.slice(0, 500),
        responsePreview: response.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(" ")
          .slice(0, 500),
      });
    } catch (err: any) {
      logCall({
        task: "react_execution",
        capability,
        modelId,
        providerId: routedModel.provider,
        latencyMs: Date.now() - llmStart,
        status: "failed",
        error: err.message?.slice(0, 200),
        runId: opts.runId,
        agentName: telemetryName,
      });
      throw err;
    }

    messages.push({ role: "assistant", content: response.content });

    const textBlocks = response.content.filter((b: any) => b.type === "text") as Anthropic.Messages.TextBlock[];
    if (textBlocks.length > 0) {
      finalText = textBlocks.map(b => b.text).join("\n");
    }

    const toolUses = response.content.filter((b: any) => b.type === "tool_use") as Anthropic.Messages.ToolUseBlock[];
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const context: ExecutionContext = {
        previousResults: toolCalls.map(c => ({ toolName: c.name, output: c.output })),
        stepIndex: toolCalls.length,
        totalSteps: MAX_TURNS,
        agentId: opts.agentId,
        runId: opts.runId,
      };

      const toolStart = Date.now();
      const result = await executeTool(tu.name, tu.input, context, "agent_chain");
      const latency = Date.now() - toolStart;

      toolCalls.push({
        name: tu.name,
        input: tu.input,
        output: result.output.slice(0, 500),
        success: result.success,
        latencyMs: latency,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.success ? result.output : `ERROR: ${result.output}`,
        ...(result.success ? {} : ({ is_error: true } as any)),
      });
    }

    messages.push({ role: "user", content: toolResults });
    if (response.stop_reason === "end_turn") break;
  }

  return { text: finalText, toolCalls, turns: turn + 1 };
}
