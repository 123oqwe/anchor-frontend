/**
 * L5 Execution — Streaming event protocol for ReAct runs.
 *
 * Versioned, stable shape that the backend emits via SSE and the frontend
 * consumes to render live agent output (text typed out, tool args typed
 * out, tool execution indicators, results appearing as they complete).
 *
 * Why not just forward Anthropic's raw stream events to the browser?
 * Those events leak provider specifics (content_block indices, stop reasons)
 * and don't carry Anchor context (which run, which tool execution, which
 * turn). This higher-level envelope is what product code wants.
 *
 * Event ordering contract:
 *   run_start
 *   ├─ turn_start { turn: 0 }
 *   │  ├─ text_delta* (0..N)
 *   │  ├─ tool_use_start { tool, toolUseId }
 *   │  │  ├─ tool_input_delta* (partial_json)
 *   │  │  └─ tool_use_end
 *   │  ├─ tool_execution_start { toolUseId }
 *   │  └─ tool_execution_end { toolUseId, success, outputPreview }
 *   │  └─ turn_end { turn, tier, toolsExecuted }
 *   ├─ turn_start { turn: 1 }
 *   │  ... (N turns)
 *   └─ run_end { status, finalText, totalTurns }
 *   OR
 *   interrupt { question, context }   — agent called request_user_input
 *   OR
 *   error { message }                 — unrecoverable failure
 */

export type StreamEvent =
  | { type: "run_start"; runId: string; agentId: string; agentName: string }
  | { type: "turn_start"; turn: number; tier: string }
  | { type: "text_delta"; turn: number; text: string }
  | { type: "tool_use_start"; turn: number; toolUseId: string; toolName: string }
  | { type: "tool_input_delta"; turn: number; toolUseId: string; partialJson: string }
  | { type: "tool_use_end"; turn: number; toolUseId: string; toolName: string; input: any }
  | { type: "tool_execution_start"; turn: number; toolUseId: string; toolName: string }
  | { type: "tool_execution_end"; turn: number; toolUseId: string; toolName: string; success: boolean; outputPreview: string; latencyMs: number; blocked?: boolean; blockReason?: string }
  | { type: "compaction"; turn: number; before: number; after: number; elided: number }
  | { type: "turn_end"; turn: number; tier: string; toolsExecuted: number }
  | { type: "interrupt"; question: string; context?: string }
  | { type: "run_end"; status: "completed" | "interrupted" | "cancelled" | "failed"; finalText: string; totalTurns: number; toolCallCount: number; tierMix: string }
  | { type: "error"; message: string };

export type StreamEventCallback = (event: StreamEvent) => void;

/** Encode a StreamEvent as an SSE frame. Adds the event: line so
 *  browsers can filter by type via `addEventListener(eventType, handler)`. */
export function encodeSSE(event: StreamEvent): string {
  // Compact JSON — SSE data: line should not contain unescaped newlines
  const payload = JSON.stringify(event);
  // Hardens against a payload containing literal \n — replace ahead of SSE framing
  const safe = payload.replace(/\n/g, "\\n");
  return `event: ${event.type}\ndata: ${safe}\n\n`;
}

/** Sentinel frame to keep connections alive through intermediaries that
 *  time out idle HTTP. Every ~15s is typical. */
export const SSE_HEARTBEAT = `: heartbeat\n\n`;
