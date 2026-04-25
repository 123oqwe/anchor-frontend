/**
 * L6 Permission & Trust — Pre-execution gate.
 *
 * Every side-effecting action passes through checkPermission().
 * Includes:
 * - Policy-based allow/deny/confirm
 * - Rate limiting per action class
 * - Trust progression (auto-upgrade after clean track record)
 * - Cron source restriction
 * - Derived-write prohibition
 * - Contract violation detection
 * - Immutable audit trail
 */
import { DEFAULT_POLICY, LEVEL_ORDER, type ActionClass, type PermissionLevel, type RiskTier, CONTRACT_VIOLATIONS } from "./levels.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { enqueueApproval, type ApprovalRiskLevel } from "./approval-queue.js";

// ── Gate types ──────────────────────────────────────────────────────────────

export type GateOutcome =
  | { decision: "allow"; auditId: string; boundary: "advisory_only" | "draft_candidate" }
  | { decision: "require_confirmation"; reason: string; actionClass: ActionClass; boundary: "approval_required" }
  | { decision: "deny"; reason: string; boundary: "no_direct_execution" };

export interface GateRequest {
  actionClass: ActionClass;
  description: string;
  source: "user_triggered" | "cron" | "agent_chain";
  metadata?: Record<string, any>;
}

// ── Rate limiter state ──────────────────────────────────────────────────────

const rateCounts = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(actionClass: ActionClass, maxPerHour: number): boolean {
  if (maxPerHour <= 0) return true; // unlimited

  const key = actionClass;
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const bucket = rateCounts.get(key);

  if (!bucket || now - bucket.windowStart > hourMs) {
    rateCounts.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= maxPerHour) {
    return false; // rate limited
  }

  bucket.count++;
  return true;
}

// ── Trust progression state ─────────────────────────────────────────────────

// Trust state: in-memory cache backed by DB persistence
const trustCache = new Map<ActionClass, { successes: number; failures: number; currentLevel: PermissionLevel }>();

function loadTrustFromDB(): void {
  const rows = db.prepare("SELECT action_class, current_level, successes, failures FROM trust_state").all() as any[];
  for (const r of rows) {
    trustCache.set(r.action_class as ActionClass, {
      successes: r.successes,
      failures: r.failures,
      currentLevel: r.current_level as PermissionLevel,
    });
  }
}

function saveTrustToDB(actionClass: ActionClass): void {
  const score = trustCache.get(actionClass);
  if (!score) return;
  db.prepare(
    "INSERT INTO trust_state (action_class, current_level, successes, failures, updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(action_class) DO UPDATE SET current_level=excluded.current_level, successes=excluded.successes, failures=excluded.failures, updated_at=excluded.updated_at"
  ).run(actionClass, score.currentLevel, score.successes, score.failures);
}

// Load on module init
try { loadTrustFromDB(); } catch (err) { console.error("[Trust] Failed to load trust state:", err); }

function getTrustLevel(actionClass: ActionClass): PermissionLevel {
  const policy = DEFAULT_POLICY[actionClass];
  if (!policy) return "L2_confirm_execute";

  const score = trustCache.get(actionClass);
  if (!score) return policy.defaultLevel;

  return score.currentLevel;
}

/** After successful execution, record success for trust progression. */
export function recordSuccess(actionClass: ActionClass): void {
  const policy = DEFAULT_POLICY[actionClass];
  if (!policy) return;

  let score = trustCache.get(actionClass);
  if (!score) {
    score = { successes: 0, failures: 0, currentLevel: policy.defaultLevel };
    trustCache.set(actionClass, score);
  }

  score.successes++;
  saveTrustToDB(actionClass);

  // Trust progression: after 10 clean successes, upgrade one level
  if (score.successes >= 10 && score.failures === 0) {
    const currentIdx = LEVEL_ORDER.indexOf(score.currentLevel);
    if (currentIdx < LEVEL_ORDER.length - 1) {
      const newLevel = LEVEL_ORDER[currentIdx + 1];
      // Never auto-upgrade past L2 for high/critical risk
      if (policy.riskTier === "high" || policy.riskTier === "critical") {
        if (LEVEL_ORDER.indexOf(newLevel) > LEVEL_ORDER.indexOf("L2_confirm_execute")) return;
      }
      score.currentLevel = newLevel;
      score.successes = 0;
      // Start cooldown: audit next 5 calls after upgrade
      upgradeCooldowns.set(actionClass, { upgradeTime: Date.now(), observationCount: 0 });
      console.log(`[Trust] ${actionClass} upgraded to ${newLevel} (10 consecutive successes, 5-call cooldown)`);
      auditLog("TrustProgression", `${actionClass} upgraded to ${newLevel} (cooldown active)`);
    }
  }
}

/** After failed execution, record failure and potentially downgrade. */
export function recordFailure(actionClass: ActionClass): void {
  let score = trustCache.get(actionClass);
  if (!score) {
    const policy = DEFAULT_POLICY[actionClass];
    if (!policy) return;
    score = { successes: 0, failures: 0, currentLevel: policy.defaultLevel };
    trustCache.set(actionClass, score);
  }

  score.failures++;
  score.successes = 0;
  saveTrustToDB(actionClass);

  // Downgrade after 3 failures
  if (score.failures >= 3) {
    const currentIdx = LEVEL_ORDER.indexOf(score.currentLevel);
    if (currentIdx > 0) {
      score.currentLevel = LEVEL_ORDER[currentIdx - 1];
      score.failures = 0;
      console.log(`[Trust] ${actionClass} downgraded to ${score.currentLevel} (3 failures)`);
      auditLog("TrustProgression", `${actionClass} downgraded to ${score.currentLevel}`);
    }
  }
}

// ── Derived-write prohibition ───────────────────────────────────────────────

function checkDerivedWriteProhibition(req: GateRequest): string | null {
  // If writing to graph and source is agent_chain (not user), check if it's derived data
  if (req.actionClass === "write_graph" && req.source === "agent_chain") {
    const desc = req.description.toLowerCase();
    // Twin/Decision output writing directly to graph without user intermediary
    if (desc.includes("twin") || desc.includes("decision") || desc.includes("inferred")) {
      return "Derived value cannot be written to graph as first-class fact. Route through user confirmation.";
    }
  }
  return null;
}

// ── Contract violation check ────────────────────────────────────────────────

export function checkViolation(violation: string): { severity: string; response: string } | null {
  const match = CONTRACT_VIOLATIONS.find(v => violation.includes(v.violation));
  if (match) {
    auditLog("ContractViolation", `[${match.severity}] ${violation}: ${match.response}`);
    return { severity: match.severity, response: match.response };
  }
  return null;
}

// ── Main gate ───────────────────────────────────────────────────────────────

export function checkPermission(req: GateRequest): GateOutcome {
  // 0. Emergency lockdown check
  if (systemLockdown) {
    persistPermissionAudit("system", "deny", "no_direct_execution", req.source, "System lockdown active");
    return { decision: "deny", reason: "System is in emergency lockdown — all actions denied", boundary: "no_direct_execution" };
  }

  const policy = DEFAULT_POLICY[req.actionClass];
  if (!policy) {
    persistPermissionAudit(req.actionClass, "deny", "no_direct_execution", req.source, req.description);
    return { decision: "deny", reason: `Unknown action class: ${req.actionClass}`, boundary: "no_direct_execution" };
  }

  // 1. Derived-write prohibition
  const derivedBlock = checkDerivedWriteProhibition(req);
  if (derivedBlock) {
    persistPermissionAudit(req.actionClass, "deny", "no_direct_execution", req.source, derivedBlock);
    return { decision: "deny", reason: derivedBlock, boundary: "no_direct_execution" };
  }

  // 2. Cron source restriction
  if (req.source === "cron" && !policy.cronAllowed) {
    persistPermissionAudit(req.actionClass, "deny", "no_direct_execution", req.source, req.description);
    return { decision: "deny", reason: `${req.actionClass} not allowed from cron jobs`, boundary: "no_direct_execution" };
  }

  // 3. Rate limit check
  if (!checkRateLimit(req.actionClass, policy.maxPerHour)) {
    persistPermissionAudit(req.actionClass, "deny", "no_direct_execution", req.source, "Rate limit exceeded");
    return { decision: "deny", reason: `Rate limit exceeded: ${req.actionClass} (max ${policy.maxPerHour}/hour)`, boundary: "no_direct_execution" };
  }

  // 4. Get effective trust level (may be upgraded/downgraded from default)
  const effectiveLevel = getTrustLevel(req.actionClass);

  // 5. Apply permission logic
  if (req.source === "user_triggered" && effectiveLevel === "L2_confirm_execute") {
    return auditedAllow(req);
  }

  if (effectiveLevel === "L3_bounded_auto") {
    // Cooldown: force audit for first 5 calls after trust upgrade
    if (isInCooldown(req.actionClass)) {
      auditLog("TrustCooldown", `[${req.actionClass}] Cooldown audit: ${req.description.slice(0, 60)}`);
    }
    return auditedAllow(req);
  }

  if (effectiveLevel === "L1_draft") {
    persistPermissionAudit(req.actionClass, "require_confirmation", "approval_required", req.source, req.description);
    return { decision: "require_confirmation", reason: "Action is draft-only at current trust level", actionClass: req.actionClass, boundary: "approval_required" };
  }

  if (effectiveLevel === "L0_read_only") {
    persistPermissionAudit(req.actionClass, "deny", "no_direct_execution", req.source, "Read-only mode");
    return { decision: "deny", reason: "Action not permitted — system is in read-only mode", boundary: "no_direct_execution" };
  }

  // L2 from non-user source
  if (effectiveLevel === "L2_confirm_execute" && req.source !== "user_triggered") {
    persistPermissionAudit(req.actionClass, "require_confirmation", "approval_required", req.source, req.description);
    return { decision: "require_confirmation", reason: "Non-user action requires explicit approval", actionClass: req.actionClass, boundary: "approval_required" };
  }

  persistPermissionAudit(req.actionClass, "require_confirmation", "approval_required", req.source, req.description);
  return { decision: "require_confirmation", reason: "Requires user approval", actionClass: req.actionClass, boundary: "approval_required" };
}

// ── Audit ────────────────────────────────────────────────────────────────────

function auditedAllow(req: GateRequest): GateOutcome {
  const auditId = nanoid();
  const policy = DEFAULT_POLICY[req.actionClass];
  const boundary = policy?.riskTier === "low" ? "advisory_only" as const : "draft_candidate" as const;
  if (policy?.requiresAudit) {
    auditLog("PermissionGate", `[${req.actionClass}|${req.source}] ${req.description.slice(0, 80)}`);
  }
  // Append-only permission audit (L6 compliance)
  persistPermissionAudit(req.actionClass, "allow", boundary, req.source, req.description);
  return { decision: "allow", auditId, boundary };
}

function persistPermissionAudit(actionClass: string, decision: string, boundary: string, source: string, description: string): void {
  let auditId: string | null = null;
  try {
    auditId = nanoid();
    db.prepare(
      "INSERT INTO permission_audit (id, action_class, decision, boundary, source, description) VALUES (?,?,?,?,?,?)"
    ).run(auditId, actionClass, decision, boundary, source, description.slice(0, 200));
  } catch (err) { console.error("[Audit] Failed to persist permission audit:", err); }

  // Sprint B — #4: also surface in unified approval inbox when this gate
  // decision is "require_confirmation". Allow/deny don't need user input.
  //
  // NOTE: gate's contract is sync — caller already received require_confirmation
  // and made its own decision before this row is even visible. The inbox row
  // is therefore INFORMATIONAL (audit trail), not actionable. We tag it so
  // /api/approvals/:id/decide refuses to act on it and the UI can render it
  // greyed-out as historical. Fixing this for real means making gate.ts
  // async (large surface change) — deferred.
  if (decision === "require_confirmation" && auditId) {
    try {
      const policy = DEFAULT_POLICY[actionClass as ActionClass];
      const risk: ApprovalRiskLevel = (policy?.riskTier as ApprovalRiskLevel) ?? "medium";
      enqueueApproval({
        source: "gate",
        sourceRefId: auditId,
        title: `[audit] ${actionClass}: ${description.slice(0, 60)}`,
        summary: `${source} requested ${actionClass}; trust level required confirmation (audit-only — caller decided synchronously)`,
        detail: {
          actionClass, source,
          description: description.slice(0, 500),
          informational: true,   // inbox decide endpoint refuses informational rows
        },
        riskLevel: risk,
      });
    } catch (err) { console.error("[Approval queue] gate enqueue failed:", err); }
  }
}

function auditLog(agent: string, action: string): void {
  db.prepare(
    "INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)"
  ).run(nanoid(), DEFAULT_USER_ID, agent, action, "success");
}

// ── Emergency lockdown ──────────────────────────────────────────────────────

let systemLockdown = false;

export function activateLockdown(): void {
  systemLockdown = true;
  auditLog("LOCKDOWN", "Emergency lockdown activated — all actions denied");
  console.log("[LOCKDOWN] Emergency lockdown activated");
}

export function deactivateLockdown(): void {
  systemLockdown = false;
  auditLog("LOCKDOWN", "Emergency lockdown deactivated");
  console.log("[LOCKDOWN] Lockdown deactivated");
}

export function isLocked(): boolean {
  return systemLockdown;
}

// ── Manual trust override ───────────────────────────────────────────────────

export function setTrustLevel(actionClass: ActionClass, level: PermissionLevel): void {
  const policy = DEFAULT_POLICY[actionClass];
  if (!policy) return;
  let score = trustCache.get(actionClass);
  if (!score) {
    score = { successes: 0, failures: 0, currentLevel: policy.defaultLevel };
    trustCache.set(actionClass, score);
  }
  score.currentLevel = level;
  score.successes = 0;
  score.failures = 0;
  auditLog("TrustOverride", `${actionClass} manually set to ${level}`);
}

// ── Trust cooldown after upgrade ────────────────────────────────────────────

const upgradeCooldowns = new Map<ActionClass, { upgradeTime: number; observationCount: number }>();
const COOLDOWN_OBSERVATIONS = 5; // audit first 5 calls after upgrade

function isInCooldown(actionClass: ActionClass): boolean {
  const cd = upgradeCooldowns.get(actionClass);
  if (!cd) return false;
  if (cd.observationCount >= COOLDOWN_OBSERVATIONS) {
    upgradeCooldowns.delete(actionClass);
    return false;
  }
  cd.observationCount++;
  return true;
}

// ── Status for admin ────────────────────────────────────────────────────────

export function getPermissionStatus() {
  const policies = Object.values(DEFAULT_POLICY).map(p => ({
    actionClass: p.actionClass,
    defaultLevel: p.defaultLevel,
    effectiveLevel: getTrustLevel(p.actionClass),
    riskTier: p.riskTier,
    maxPerHour: p.maxPerHour,
    cronAllowed: p.cronAllowed,
    trustScore: trustCache.get(p.actionClass) ?? null,
  }));
  return { policies, universalRulesCount: 8, contractViolationTypes: CONTRACT_VIOLATIONS.length };
}
