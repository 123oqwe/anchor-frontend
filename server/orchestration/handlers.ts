/**
 * L4 Orchestration — Event router.
 * Maps bus events to the appropriate subsystem.
 * Does NOT contain business logic — only routing/dispatch.
 */
import { bus, type AnchorEvent } from "./bus.js";
import { runExecutionReAct } from "../execution/agent.js";
import { twinLearnFromEdits, twinLearnFromResults, trackPlanDecision, evaluateDecisionOutcome } from "../cognition/twin.js";
import { persistInsightAsSemanticMemory, recordGraphChange, grantTaskCompletionXp } from "../cognition/observation.js";

async function onUserConfirmed(payload: any) {
  // Track the confirmation for accept/reject pattern learning
  const stepSummary = payload.user_steps?.map((s: any) => s.content).join("; ") ?? "";
  trackPlanDecision("confirmed", stepSummary, payload.user_steps?.length ?? 0);

  // Fire Twin sidecar async (non-blocking)
  twinLearnFromEdits(payload.changes).catch(err =>
    console.error("[Twin Sidecar] Error:", err.message)
  );
  // Run Execution Agent synchronously
  await runExecutionReAct(payload.user_steps);
}

async function onExecutionDone(payload: any) {
  // Twin learns from execution results
  await twinLearnFromResults(payload);
  // Track decision outcome quality
  evaluateDecisionOutcome(payload.plan_summary ?? "", payload.steps_result ?? []).catch(() => {});
}

export function startEventHandlers() {
  bus.on("event", (e: AnchorEvent) => {
    switch (e.type) {
      case "USER_CONFIRMED":  onUserConfirmed(e.payload);                        break;
      case "EXECUTION_DONE":  onExecutionDone(e.payload);                        break;
      case "TWIN_UPDATED":    persistInsightAsSemanticMemory(e.payload.insight);  break;
      case "GRAPH_UPDATED":   recordGraphChange(e.payload.nodeId, e.payload.status, e.payload.label); break;
      case "TASK_COMPLETED":  grantTaskCompletionXp(e.payload.title);            break;
    }
  });
  console.log("⚡ Orchestration: USER_CONFIRMED → Track + Execution + Twin | EXECUTION_DONE → Twin + Outcome | GRAPH_UPDATED → Observation");
}
