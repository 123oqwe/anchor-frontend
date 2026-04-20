/**
 * App Approval — Codex-style per-app authorization layer.
 *
 * Layered on top of L6 ActionClass permissions:
 *   L6 gate (ActionClass) = "can this class of action run at all?"
 *   App Approval            = "is this specific app on the allowlist for the user?"
 *
 * When a provider declares `targetApp`, the dispatcher calls
 * `checkAppApproval(app)` before executing. If unapproved, the dispatcher
 * emits an APP_APPROVAL_PENDING bus event (UI shows approval dialog) and
 * returns a "needs approval" result — same UX as dev proposals (Gap B).
 *
 * Wildcards: `targetApp: "*"` means "check approval dynamically from input",
 * which is what vision providers like macos-vision do (they don't know which
 * app they'll touch until they see the task).
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { bus } from "../orchestration/bus.js";

export type ApprovalDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "pending"; reason: string };

export function checkAppApproval(appIdentifier: string, scope: "read" | "write" | "full" = "full"): ApprovalDecision {
  if (!appIdentifier || appIdentifier === "*") return { decision: "allow" };  // wildcard = no-op gate

  // Exact match first
  const exact = db.prepare(
    "SELECT status FROM app_approvals WHERE user_id=? AND app_identifier=? AND scope IN (?, 'full')"
  ).get(DEFAULT_USER_ID, appIdentifier, scope) as any;

  if (exact?.status === "approved") return { decision: "allow" };
  if (exact?.status === "denied") return { decision: "deny", reason: `${appIdentifier} explicitly denied` };
  if (exact?.status === "pending") return { decision: "pending", reason: `${appIdentifier} awaiting approval` };

  // Not yet in table — create pending row and emit event
  db.prepare(
    "INSERT OR IGNORE INTO app_approvals (user_id, app_identifier, scope, status) VALUES (?, ?, ?, 'pending')"
  ).run(DEFAULT_USER_ID, appIdentifier, scope);

  bus.publish({
    type: "NOTIFICATION",
    payload: {
      id: `app-approval-${appIdentifier}`,
      type: "app_approval",
      title: "App approval needed",
      body: `An agent wants to act on ${appIdentifier} (scope: ${scope}). Approve in Settings → Integrations → App Approvals.`,
      priority: "high",
      action: { label: "Review", type: "navigate", payload: { path: "/settings" } },
    },
  });

  logExecution("Bridge Dispatcher", `App approval pending: ${appIdentifier} (${scope})`);

  return { decision: "pending", reason: `${appIdentifier} — first-time use requires your approval (notification sent)` };
}

export function approveApp(appIdentifier: string, scope: "read" | "write" | "full" = "full"): void {
  db.prepare(
    `INSERT INTO app_approvals (user_id, app_identifier, scope, status, granted_at)
     VALUES (?, ?, ?, 'approved', datetime('now'))
     ON CONFLICT(user_id, app_identifier, scope)
     DO UPDATE SET status='approved', granted_at=datetime('now')`
  ).run(DEFAULT_USER_ID, appIdentifier, scope);
  logExecution("Bridge Dispatcher", `App approved: ${appIdentifier} (${scope})`);
}

export function denyApp(appIdentifier: string, scope: "read" | "write" | "full" = "full"): void {
  db.prepare(
    `INSERT INTO app_approvals (user_id, app_identifier, scope, status, granted_at)
     VALUES (?, ?, ?, 'denied', datetime('now'))
     ON CONFLICT(user_id, app_identifier, scope)
     DO UPDATE SET status='denied', granted_at=datetime('now')`
  ).run(DEFAULT_USER_ID, appIdentifier, scope);
  logExecution("Bridge Dispatcher", `App denied: ${appIdentifier} (${scope})`);
}

export function listAppApprovals() {
  return db.prepare(
    "SELECT app_identifier, scope, status, granted_at, expires_at, created_at FROM app_approvals WHERE user_id=? ORDER BY created_at DESC"
  ).all(DEFAULT_USER_ID);
}

export function revokeApp(appIdentifier: string, scope?: string): void {
  if (scope) {
    db.prepare("DELETE FROM app_approvals WHERE user_id=? AND app_identifier=? AND scope=?")
      .run(DEFAULT_USER_ID, appIdentifier, scope);
  } else {
    db.prepare("DELETE FROM app_approvals WHERE user_id=? AND app_identifier=?")
      .run(DEFAULT_USER_ID, appIdentifier);
  }
}
