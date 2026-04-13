import { EventEmitter } from "events";

export type AnchorEvent =
  | { type: "DECISION_MADE";  payload: { messageId: string; content: string; isDraft: boolean } }
  | { type: "DRAFT_APPROVED"; payload: { messageId: string; content: string } }
  | { type: "DRAFT_REJECTED"; payload: { messageId: string } }
  | { type: "TASK_COMPLETED"; payload: { taskId: string; title: string } }
  | { type: "GRAPH_UPDATED";  payload: { nodeId: string; status: string; label: string } }
  | { type: "TWIN_UPDATED";   payload: { insight: string } }
  | { type: "EXECUTION_DONE"; payload: { planSummary: string; changes: number } };

class AnchorBus extends EventEmitter {
  publish(data: AnchorEvent) {
    console.log(`[Bus] ▶ ${data.type}`, JSON.stringify(data.payload).slice(0, 100));
    this.emit("event", data);
  }
}

export const bus = new AnchorBus();
bus.setMaxListeners(20);
