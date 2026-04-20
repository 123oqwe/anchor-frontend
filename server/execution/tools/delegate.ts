/**
 * delegate — Claude Code-style subagent spawn.
 *
 * Parent agent calls `delegate({ instructions, task, tools })` to dispatch a
 * specialized child with FRESH context. Child runs the full ReAct loop, hits
 * its own tools, returns a summary. Parent sees only the summary (not the
 * child's full trace) — this keeps parent context small.
 *
 * Use cases:
 *   • Parallelizable work: "analyze each of these 7 days" → 7 delegates
 *   • Role specialization: researcher → writer → reviewer
 *   • Context isolation: child explores aggressively without polluting parent
 *
 * Safety:
 *   • Max depth 3 (parent → child → grandchild, no deeper) — prevents runaway
 *   • Child tool whitelist = parent whitelist ∩ requested tools
 *   • Child shares parent's agentId (so KV + workspace are shared with parent)
 *   • Child runId = parent runId + "-sub-<nanoid>" for trace correlation
 */
import { nanoid } from "nanoid";
import { registerTool, type ToolResult } from "../registry.js";
import { localAgentRegistry } from "../local-impl.js";

const MAX_DELEGATION_DEPTH = 3;

export function registerDelegateTool(): void {
  registerTool({
    name: "delegate",
    description:
      "Spawn a subagent with fresh context to do a focused task. The subagent runs its own ReAct loop with tools you specify, then returns a concise summary. " +
      "Use this to parallelize work (fan out N delegates) or to assign role-specialized tasks (researcher / writer / reviewer). " +
      "Prefer this over keeping a huge multi-step task in your own context — it keeps your context small and focused. " +
      "Max depth 3. Child tools must be a subset of your own whitelist.",
    handler: "internal",
    actionClass: "delegate_agent",
    inputSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "System prompt for the subagent — describe its role and approach",
        },
        task: {
          type: "string",
          description: "The specific task the subagent should accomplish",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Tool names the subagent can use (must be subset of your own). Omit to grant all of yours.",
        },
      },
      required: ["instructions", "task"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const parentAgentId = ctx?.agentId;
      if (!parentAgentId) return {
        success: false,
        output: "delegate requires agent context (only callable from custom agents)",
        error: "NO_AGENT_CONTEXT",
      };

      // Depth guard via runId chain: count "-sub-" occurrences in runId
      const parentRunId = ctx?.runId ?? "";
      const currentDepth = (parentRunId.match(/-sub-/g) ?? []).length;
      if (currentDepth >= MAX_DELEGATION_DEPTH) {
        return {
          success: false,
          output: `Max delegation depth (${MAX_DELEGATION_DEPTH}) exceeded`,
          error: "MAX_DEPTH",
        };
      }

      const parent = await localAgentRegistry.getAgent(parentAgentId);
      if (!parent) return { success: false, output: "Parent agent not found", error: "NO_PARENT" };

      // Child tools = requested ∩ parent's whitelist
      const requestedTools: string[] = Array.isArray(input.tools) && input.tools.length > 0
        ? input.tools as string[]
        : parent.tools;
      const childTools = requestedTools.filter((t) => parent.tools.includes(t));

      if (childTools.length === 0) {
        return {
          success: false,
          output: "Subagent has no tools (requested set empty or not subset of parent's whitelist)",
          error: "NO_TOOLS",
        };
      }

      const subRunId = `${parentRunId || nanoid(8)}-sub-${nanoid(6)}`;

      // Dynamic import to avoid circular module init
      const { runCustomAgentReAct } = await import("../custom-agent-react.js");

      const start = Date.now();
      try {
        const result = await runCustomAgentReAct({
          agentId: parent.id,
          agentName: `${parent.name} (sub)`,
          systemPrompt: input.instructions,
          userMessage: input.task,
          allowedTools: childTools,
          runId: subRunId,
        });

        const summary = result.text?.trim() || `(subagent ran ${result.turns} turns with ${result.toolCalls.length} tool calls but produced no text)`;
        return {
          success: true,
          output: summary.slice(0, 4000),
          data: {
            subRunId,
            turns: result.turns,
            toolCalls: result.toolCalls.length,
            durationMs: Date.now() - start,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          output: `Subagent failed: ${err.message}`,
          error: "SUBAGENT_FAILED",
          data: { subRunId, durationMs: Date.now() - start },
        };
      }
    },
  });
}
