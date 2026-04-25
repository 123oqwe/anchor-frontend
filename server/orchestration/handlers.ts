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

  // Phase 2 of #2 — SessionRunner is now the default execution path.
  // Opt-out via ANCHOR_LEGACY_REACT=true (forces legacy ReAct).
  // Safety net: if startSession throws or no sessionId was compiled, we
  // fall through to the legacy path so the user is never stranded mid-flow.
  const forceLegacy = process.env.ANCHOR_LEGACY_REACT === "true";
  if (!forceLegacy && payload.sessionId) {
    try {
      const { startSession } = await import("./session-runner.js");
      startSession(payload.sessionId);
      console.log(`[Orchestrator] session ${payload.sessionId.slice(0, 6)} routed to SessionRunner`);
      return;
    } catch (err: any) {
      console.error(`[Orchestrator] SessionRunner failed to take over (${err?.message}) — falling back to legacy ReAct`);
      // fall through
    }
  }

  // Legacy path (forced via env, or no sessionId, or startSession threw)
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

  // Sprint B — #4: APPROVAL_DECIDED reverse-syncs back to source-specific
  // state. Inbox is the front door; sources keep their own state but learn
  // about user decisions through this event.
  bus.on("event", async (e: AnchorEvent) => {
    if (e.type !== "APPROVAL_DECIDED") return;
    const { source, sourceRefId, approved } = e.payload;
    try {
      const { db } = await import("../infra/storage/db.js");
      if (source === "app") {
        // sourceRefId = "appIdentifier::scope" — split + write app_approvals
        const [appIdentifier, scope] = String(sourceRefId).split("::");
        if (appIdentifier && scope) {
          db.prepare(
            "UPDATE app_approvals SET status=? WHERE user_id=? AND app_identifier=? AND scope=?"
          ).run(approved ? "approved" : "denied", "default", appIdentifier, scope);
        }
      }
      // 'run' source: user reply still flows through /runs/:id/resume — the
      // approval row is informational only. Same for 'gate' (audit log only).
      if (source === "step") {
        // Phase 2 of #2 — sourceRefId IS the step id. Flip approval
        // decision; SessionRunner picks it up next tick.
        const { applyStepApprovalDecision } = await import("./session-runner.js");
        applyStepApprovalDecision(sourceRefId, !!approved);
      }
    } catch (err: any) {
      console.error("[Orchestrator] APPROVAL_DECIDED reconciliation failed:", err.message);
    }
  });

  console.log("⚡ Orchestration: mode-based routing | handoff enforcement | event persistence | error retry | approval inbox sync");
}
