/**
 * handoff — swarm-style peer transfer.
 *
 * Where `delegate` (P1.6) is hierarchical (parent fans out child subagent,
 * waits for summary), `handoff` is peer-to-peer: agent A writes intermediate
 * state to the blackboard, hands off to agent B with a task description. B
 * runs in the SAME mission (same blackboard visibility) but fresh ReAct
 * context. Typical swarm pipeline:
 *
 *   researcher → (handoff) → writer → (handoff) → reviewer → final
 *
 * Implementation: this is a thin wrapper around delegate's recursion pattern
 * but (1) looks up the target agent by NAME, (2) preserves missionId (so
 * blackboard is shared), (3) bumps a __handoff_count__ counter on the
 * blackboard to cap chain depth at 5.
 */
import { nanoid } from "nanoid";
import { registerTool, type ToolResult } from "../registry.js";
import { localAgentRegistry } from "../local-impl.js";
import { db, DEFAULT_USER_ID } from "../../infra/storage/db.js";

const MAX_HANDOFF_CHAIN = 5;
const HANDOFF_COUNTER_KEY = "__handoff_count__";

export function registerHandoffTool(): void {
  registerTool({
    name: "handoff",
    description:
      "Transfer control to a peer agent in the same mission. The target agent runs with fresh context but SHARED blackboard — so anything you wrote to anchor.blackboard.* is visible to them. " +
      "Use this for role-specialized pipelines (researcher → writer → reviewer). " +
      "Before calling handoff, write intermediate results to blackboard so the next agent can pick them up. " +
      "Max chain length 5 per mission.",
    handler: "internal",
    actionClass: "delegate_agent",
    inputSchema: {
      type: "object",
      properties: {
        to_agent: {
          type: "string",
          description: "Name of the agent to hand off to (case-sensitive, must exist in user_agents)",
        },
        task: {
          type: "string",
          description: "What the next agent should accomplish",
        },
        note: {
          type: "string",
          description: "Optional: brief handoff note summarizing what you did and what the next agent should know",
        },
      },
      required: ["to_agent", "task"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const callerAgentId = ctx?.agentId;
      if (!callerAgentId) return {
        success: false, output: "handoff requires agent context", error: "NO_AGENT_CONTEXT",
      };
      const missionId = ctx?.missionId ?? ctx?.runId;
      if (!missionId) return {
        success: false, output: "handoff requires mission context", error: "NO_MISSION",
      };

      // Depth guard via mission_kv
      const counterRow = db.prepare(
        "SELECT value FROM mission_kv WHERE mission_id=? AND key=?"
      ).get(missionId, HANDOFF_COUNTER_KEY) as any;
      const depth = Number(counterRow?.value ?? 0);
      if (depth >= MAX_HANDOFF_CHAIN) {
        return {
          success: false,
          output: `Handoff chain exceeded ${MAX_HANDOFF_CHAIN} — stopping to prevent runaway`,
          error: "MAX_HANDOFF",
        };
      }

      // Look up target
      const target = await localAgentRegistry.getAgentByName(DEFAULT_USER_ID, String(input.to_agent ?? ""));
      if (!target) {
        return {
          success: false,
          output: `Agent "${input.to_agent}" not found. Create it first via /api/agents/custom.`,
          error: "TARGET_NOT_FOUND",
        };
      }
      if (!target.enabled) {
        return { success: false, output: `Agent "${target.name}" is disabled`, error: "TARGET_DISABLED" };
      }

      // Bump handoff counter for this mission
      db.prepare(
        "INSERT OR REPLACE INTO mission_kv (mission_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))"
      ).run(missionId, HANDOFF_COUNTER_KEY, String(depth + 1));

      // Build target system prompt — their own instructions + handoff context
      const { serializeForPrompt } = await import("../../graph/reader.js");
      const handoffNote = (input.note as string | undefined)?.trim();
      const preface = handoffNote
        ? `\n\n──── HANDOFF CONTEXT ────\nYou received this task via handoff. Previous agent's note:\n"${handoffNote}"\n\nShared blackboard is available via anchor.blackboard.* — check it for what the previous agent left you.\n────`
        : `\n\n──── HANDOFF CONTEXT ────\nYou received this task via handoff. Check anchor.blackboard.list() for what the previous agent left you.\n────`;

      const systemPrompt = `${target.instructions}\n\nUser's Human Graph context:\n${serializeForPrompt()}${preface}`;

      const childRunId = `${ctx?.runId ?? nanoid(8)}-handoff-${nanoid(6)}`;

      const { runCustomAgentReAct } = await import("../custom-agent-react.js");
      const start = Date.now();
      try {
        const result = await runCustomAgentReAct({
          agentId: target.id,
          agentName: `${target.name} (handoff)`,
          systemPrompt,
          userMessage: String(input.task ?? ""),
          allowedTools: target.tools,
          runId: childRunId,
          missionId,   // SAME mission — blackboard carries over
        });
        return {
          success: true,
          output: result.text?.trim() || `(${target.name} completed ${result.turns} turns / ${result.toolCalls.length} tools with no text output)`,
          data: {
            handoffDepth: depth + 1,
            targetAgent: target.name,
            turns: result.turns,
            toolCalls: result.toolCalls.length,
            missionId,
            durationMs: Date.now() - start,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          output: `Handoff to ${target.name} failed: ${err.message}`,
          error: "HANDOFF_FAILED",
          data: { missionId, durationMs: Date.now() - start },
        };
      }
    },
  });
}
