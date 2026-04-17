/**
 * L4 Orchestration — Event router with mode selection + enforcement.
 *
 * Now includes:
 * - Trigger classification → mode selection → dispatch
 * - Handoff validation (prevent illegal agent-to-agent calls)
 * - Event persistence (every event logged to DB)
 * - Error routing with retry (max 2 retries before dead letter)
 * - Operation class tracking
 */
import { bus, type AnchorEvent } from "./bus.js";
import { selectMode, classifyTrigger, classifyOperation, logModeSelection, type TriggerType } from "./modes.js";
import { validateHandoff, persistEvent, recordFailure } from "./enforcement.js";
import { runExecutionReAct } from "../execution/agent.js";
import { twinLearnFromEdits, twinLearnFromResults, trackPlanDecision, evaluateDecisionOutcome, detectDrift } from "../cognition/twin.js";
import { persistInsightAsSemanticMemory, recordGraphChange, grantTaskCompletionXp } from "../cognition/observation.js";

// ── Event → Trigger → Mode → Dispatch ───────────────────────────────────────

async function dispatch(event: AnchorEvent): Promise<void> {
  let triggerType: TriggerType;
  switch (event.type) {
    case "USER_CONFIRMED":  triggerType = "USER_CONFIRM"; break;
    case "EXECUTION_DONE":  triggerType = "EXECUTION_COMPLETE"; break;
    case "TWIN_UPDATED":    triggerType = "REFLECTION"; break;
    case "GRAPH_UPDATED":   triggerType = "STATE_CHANGE"; break;
    case "TASK_COMPLETED":  triggerType = "STATE_CHANGE"; break;
    default:                triggerType = "USER_INPUT"; break;
  }

  const mode = selectMode(triggerType);
  const opClass = classifyOperation(mode);
  logModeSelection(triggerType, mode, opClass);

  // Persist event
  persistEvent(event, "processed");

  // Route to handler — await async handlers to catch errors properly
  switch (event.type) {
    case "USER_CONFIRMED":  await handleConfirmed(event.payload);  break;
    case "EXECUTION_DONE":  await handleExecutionDone(event.payload); break;
    case "TWIN_UPDATED":    handleTwinUpdated(event.payload);   break;
    case "GRAPH_UPDATED":   handleGraphUpdated(event.payload);  break;
    case "TASK_COMPLETED":  handleTaskCompleted(event.payload); break;
  }
}

// ── Individual handlers with enforcement ────────────────────────────────────

async function handleConfirmed(payload: any) {
  // Validate handoff: orchestrator → execution (legal)
  const check = validateHandoff("orchestrator", "execution");
  if (!check.valid) return;

  // Track for Twin pattern learning
  const stepSummary = payload.user_steps?.map((s: any) => s.content).join("; ") ?? "";
  trackPlanDecision("confirmed", stepSummary, payload.user_steps?.length ?? 0);

  // Fire Twin sidecar async (orchestrator → twin: legal)
  validateHandoff("orchestrator", "twin");
  twinLearnFromEdits(payload.changes).catch(err =>
    console.error("[Twin Sidecar] Error:", err.message)
  );

  // Run Execution Agent
  await runExecutionReAct(payload.user_steps);
}

async function handleExecutionDone(payload: any) {
  // Validate: orchestrator → twin (legal)
  validateHandoff("orchestrator", "twin");
  await twinLearnFromResults(payload);
  evaluateDecisionOutcome(payload.plan_summary ?? "", payload.steps_result ?? []).catch(() => {});
}

function handleTwinUpdated(payload: any) {
  // Validate: orchestrator → memory (legal)
  validateHandoff("orchestrator", "memory");
  persistInsightAsSemanticMemory(payload.insight);
}

function handleGraphUpdated(payload: any) {
  // Validate: orchestrator → observation (legal)
  validateHandoff("orchestrator", "observation");
  recordGraphChange(payload.nodeId, payload.status, payload.label);
}

function handleTaskCompleted(payload: any) {
  grantTaskCompletionXp(payload.title);
}

// ── Wire with error routing ─────────────────────────────────────────────────

export function startEventHandlers() {
  bus.on("event", async (e: AnchorEvent) => {
    try {
      await dispatch(e);
    } catch (err: any) {
      console.error(`[Orchestrator] Event ${e.type} failed:`, err.message);
      const shouldRetry = recordFailure(e, err.message);
      if (shouldRetry) {
        console.log(`[Orchestrator] Retrying ${e.type}...`);
        setTimeout(async () => {
          try { await dispatch(e); } catch (retryErr: any) {
            recordFailure(e, retryErr.message);
          }
        }, 1000);
      }
    }
  });

  console.log("⚡ Orchestration: mode-based routing | handoff enforcement | event persistence | error retry");
}
