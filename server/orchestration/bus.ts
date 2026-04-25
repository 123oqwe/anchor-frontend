import { EventEmitter } from "events";

export interface EditableStep {
  id: number;
  content: string;
  time_estimate?: string;
}

export interface StepChange {
  type: "kept" | "modified" | "deleted" | "added";
  step_id?: number;
  before?: string;
  after?: string;
  content?: string;
}

export type AnchorEvent =
  | { type: "USER_CONFIRMED"; payload: { original_steps: EditableStep[]; user_steps: EditableStep[]; changes: StepChange[]; sessionId?: string } }
  | { type: "EXECUTION_DONE"; payload: { steps_result: { step: string; status: string; result: string }[]; plan_summary: string } }
  | { type: "TWIN_UPDATED";  payload: { insight: string } }
  | { type: "GRAPH_UPDATED"; payload: { nodeId: string; status: string; label: string } }
  | { type: "TASK_COMPLETED"; payload: { taskId: string; title: string } }
  | { type: "NOTIFICATION"; payload: { id: string; type: string; title: string; body: string; priority: string; action?: any } }
  | { type: "SCAN_PROGRESS"; payload: { phase: string; status: string; found: number } }
  // OPT-2: Event triggers for Custom Agents
  | { type: "FILE_CHANGED"; payload: { path: string; event: "add" | "change" | "delete" } }
  | { type: "GIT_COMMIT"; payload: { repo: string; sha: string; message: string } }
  | { type: "EMAIL_RECEIVED"; payload: { from: string; subject: string; snippet: string } }
  | { type: "CALENDAR_UPCOMING"; payload: { title: string; startsInMinutes: number } }
  | { type: "NODE_STATUS_CHANGED"; payload: { nodeId: string; label: string; from: string; to: string } }
  | { type: "APP_FOCUSED"; payload: { app: string; previous: string } }
  | { type: "IDLE_DETECTED"; payload: { idleMinutes: number } }
  // OPT-1 Gap B: dev tool write proposal awaiting user approval
  | { type: "PROPOSAL_PENDING"; payload: { id: string; kind: string; path?: string; agentName?: string; deltaLines: number } }
  // Portrait streaming: Oracle Council progressive reveal
  | { type: "PORTRAIT_PROGRESS"; payload: { phase: "profile" | "oracle" | "compass" | "done"; oracle?: string; narrative?: string; questions?: string[]; icon?: string; durationMs?: number; compass?: any } }
  // Sprint B — #4: unified approval inbox decision
  | { type: "APPROVAL_DECIDED"; payload: { id: string; source: string; sourceRefId: string; approved: boolean; reason?: string } }
  // Phase 2 of #2 — per-step progress (UI live-updates)
  | { type: "SESSION_STEP_PROGRESS"; payload: { sessionId: string; stepId: string; stepIndex: number; status: string; tool: string | null; runtime: string } };

class AnchorBus extends EventEmitter {
  publish(data: AnchorEvent) {
    console.log(`[Bus] ▶ ${data.type}`, JSON.stringify(data.payload).slice(0, 100));
    this.emit("event", data);
  }
}

export const bus = new AnchorBus();
bus.setMaxListeners(20);
