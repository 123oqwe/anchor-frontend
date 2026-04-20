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

/**
 * Programmatic Tool Calling (PTC) addendum — appended to system prompt when
 * the agent has `execute_code` available. Tells the LLM to prefer one
 * multi-step code block over chaining N individual tool calls.
 */
const PTC_GUIDANCE = `

──── EXECUTION STYLE ────
You have execute_code — it runs Python or Node on the user's Mac with a
preloaded \`anchor\` module that calls Anchor directly. For any task needing
MORE THAN ONE operation, prefer ONE execute_code block over chaining tool
calls. This is faster, uses less context, and makes the trace cleaner.

Python example — research, filter, draft, save:

    import anchor

    people = anchor.graph.query(query="active", limit=5)
    snippets = []
    for p in people:
        mems = anchor.memory.search(query=p["label"], limit=2)
        snippets.append(f"{p['label']}: {len(mems)} recent memories")

    summary = anchor.think(
        prompt="Write a 2-sentence weekly digest from: " + "\\n".join(snippets),
        maxTokens=300,
    )

    anchor.state.set(key="last_digest", value=summary["answer"])
    print(summary["answer"])

anchor module (Python & Node identical API):
  BRIDGE (physical world):
    anchor.email.send(to, subject, body)
    anchor.calendar.create_event(title, date, time, durationMinutes)
    anchor.browser.navigate(url, selector?, screenshot?)
    anchor.desktop.automate(task, app?)
    anchor.dev.delegate(task)
  KERNEL (Anchor internals):
    anchor.graph.query(query?, type?, status?, limit=10)
    anchor.memory.search(query, limit=5)
    anchor.memory.write(title, content, tags?)
    anchor.state.get(key)           # per-agent KV (survives runs)
    anchor.state.set(key, value)
    anchor.web.search(query)
    anchor.web.read_url(url)
    anchor.tasks.create(title, priority?)
    anchor.think(prompt, system?, maxTokens=500)   # sub-LLM, max 5/run
    anchor.parallel([(method, args), ...])         # fan out concurrently

Working dir is your workspace (~/Documents/Anchor/agents/<name>/) — files you
write land there and are visible to the user in Finder. Errors raise
AnchorError in Python / throw in Node — wrap risky ops in try/except.

When the task is a SINGLE external action (just send one email), a direct
tool call is fine. PTC is for multi-step work.
────`;


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

  // PTC guidance: when execute_code is available, coach the LLM to prefer one
  // multi-step code block over many small tool calls (Hermes pattern — saves
  // 4-5x tokens on multi-step tasks).
  const hasExecuteCode = opts.allowedTools.includes("execute_code");
  const systemWithPtc = hasExecuteCode
    ? opts.systemPrompt + PTC_GUIDANCE
    : opts.systemPrompt;

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
        system: systemWithPtc,
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
