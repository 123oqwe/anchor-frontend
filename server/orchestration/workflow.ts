/**
 * L4 Orchestration — Workflow State Machine.
 *
 * Tracks the lifecycle of a user request through the system.
 * States: observed → interpreted → drafted → awaiting_approval →
 *         approved → executing → verified → logged → fed_back
 *
 * Each transition is validated and logged.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

export type WorkflowState =
  | "observed"           // L4: trigger received
  | "interpreted"        // L3: Decision Agent analyzed
  | "drafted"            // L3: plan/draft produced
  | "awaiting_approval"  // L6: waiting for user confirm
  | "approved"           // L6: user confirmed
  | "executing"          // L5: execution in progress
  | "executed"           // L5: execution complete
  | "verified"           // L5: result verified
  | "logged"             // L8: audit written
  | "fed_back"           // L4: feedback loop closed
  | "rejected"           // L6: user rejected
  | "failed";            // L5: execution failed

const LEGAL_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  observed:          ["interpreted", "failed"],
  interpreted:       ["drafted", "fed_back", "failed"],  // fed_back for advice-only (no plan)
  drafted:           ["awaiting_approval"],
  awaiting_approval: ["approved", "rejected"],
  approved:          ["executing"],
  executing:         ["executed", "failed"],
  executed:          ["verified"],
  verified:          ["logged"],
  logged:            ["fed_back"],
  fed_back:          [],  // terminal
  rejected:          ["fed_back"],  // rejection feeds back to learn
  failed:            ["fed_back"],
};

// Ensure workflow table exists
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      current_state TEXT NOT NULL DEFAULT 'observed',
      trigger_type TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS workflow_transitions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id)
    );
  `);
} catch {}

/** Create a new workflow instance. */
export function createWorkflow(triggerType: string, summary: string): string {
  const id = nanoid();
  db.prepare("INSERT INTO workflows (id, user_id, current_state, trigger_type, summary) VALUES (?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, "observed", triggerType, summary);
  return id;
}

/** Transition a workflow to the next state. Returns false if illegal transition. */
export function transition(workflowId: string, toState: WorkflowState): boolean {
  const wf = db.prepare("SELECT current_state FROM workflows WHERE id=?").get(workflowId) as any;
  if (!wf) return false;

  const currentState = wf.current_state as WorkflowState;
  const allowed = LEGAL_TRANSITIONS[currentState] ?? [];

  if (!allowed.includes(toState)) {
    console.error(`[Workflow] Illegal transition: ${currentState} → ${toState} (allowed: ${allowed.join(",")})`);
    return false;
  }

  db.prepare("UPDATE workflows SET current_state=?, updated_at=datetime('now') WHERE id=?")
    .run(toState, workflowId);
  db.prepare("INSERT INTO workflow_transitions (id, workflow_id, from_state, to_state) VALUES (?,?,?,?)")
    .run(nanoid(), workflowId, currentState, toState);

  return true;
}

/** Get current workflow state. */
export function getWorkflowState(workflowId: string): WorkflowState | null {
  const wf = db.prepare("SELECT current_state FROM workflows WHERE id=?").get(workflowId) as any;
  return wf?.current_state ?? null;
}

/** Get transition history for a workflow. */
export function getTransitionHistory(workflowId: string): { from: string; to: string; at: string }[] {
  return db.prepare(
    "SELECT from_state as 'from', to_state as 'to', created_at as at FROM workflow_transitions WHERE workflow_id=? ORDER BY created_at"
  ).all(workflowId) as any[];
}

/** Get recent workflows. */
export function getRecentWorkflows(limit = 20): any[] {
  return db.prepare(
    "SELECT * FROM workflows WHERE user_id=? ORDER BY created_at DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, limit);
}
