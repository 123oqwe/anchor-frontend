/**
 * L6 Permission & Trust — Authority levels, action classes, boundary classifications.
 *
 * From spec: agent-boundaries.ts, safe-update-boundaries.ts
 * From 2026 research: trust progression, scope-based permissions
 */

// ── Trust Levels ────────────────────────────────────────────────────────────

export type PermissionLevel =
  | "L0_read_only"       // System can only read, never write
  | "L1_draft"           // System can suggest but not apply
  | "L2_confirm_execute" // System requires user confirmation before side effect
  | "L3_bounded_auto";   // System can execute within pre-approved scope

export const LEVEL_ORDER: PermissionLevel[] = ["L0_read_only", "L1_draft", "L2_confirm_execute", "L3_bounded_auto"];

// ── Action Classes ──────────────────────────────────────────────────────────

export type ActionClass =
  | "read_graph"         // Reading Human Graph
  | "read_memory"        // Reading memories
  | "write_memory"       // Writing to memories
  | "write_graph"        // Modifying Human Graph nodes
  | "write_task"         // Creating workspace tasks
  | "send_external"      // Sending external communications
  | "modify_calendar"    // Calendar events
  | "financial"          // Money-moving action
  | "admin_config"       // System configuration
  | "delete_data"        // Deleting user data
  | "browser_action"     // Browser automation
  | "code_execution"     // Running code in sandbox
  | "execute_command"    // OPT-1: shell/git/file writes (high risk)
  | "delegate_agent";    // OPT-1: delegating to another agent (MCP call)

export type RiskTier = "low" | "medium" | "high" | "critical";

export interface ActionPolicy {
  actionClass: ActionClass;
  defaultLevel: PermissionLevel;
  requiresAudit: boolean;
  riskTier: RiskTier;
  maxPerHour: number;          // rate limit — 0 = unlimited
  cronAllowed: boolean;        // can cron jobs trigger this?
}

export const DEFAULT_POLICY: Record<ActionClass, ActionPolicy> = {
  read_graph:      { actionClass: "read_graph",      defaultLevel: "L3_bounded_auto",   requiresAudit: false, riskTier: "low",      maxPerHour: 0,   cronAllowed: true },
  read_memory:     { actionClass: "read_memory",     defaultLevel: "L3_bounded_auto",   requiresAudit: false, riskTier: "low",      maxPerHour: 0,   cronAllowed: true },
  write_memory:    { actionClass: "write_memory",    defaultLevel: "L3_bounded_auto",   requiresAudit: true,  riskTier: "low",      maxPerHour: 0,   cronAllowed: true },
  write_graph:     { actionClass: "write_graph",     defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "medium",   maxPerHour: 50,  cronAllowed: true },
  write_task:      { actionClass: "write_task",      defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "low",      maxPerHour: 100, cronAllowed: true },
  send_external:   { actionClass: "send_external",   defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "high",     maxPerHour: 10,  cronAllowed: false },
  modify_calendar: { actionClass: "modify_calendar", defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "medium",   maxPerHour: 20,  cronAllowed: false },
  financial:       { actionClass: "financial",       defaultLevel: "L1_draft",          requiresAudit: true,  riskTier: "critical",  maxPerHour: 3,   cronAllowed: false },
  admin_config:    { actionClass: "admin_config",    defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "high",     maxPerHour: 10,  cronAllowed: false },
  delete_data:     { actionClass: "delete_data",     defaultLevel: "L1_draft",          requiresAudit: true,  riskTier: "critical",  maxPerHour: 5,   cronAllowed: false },
  browser_action:  { actionClass: "browser_action",  defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "high",     maxPerHour: 30,  cronAllowed: false },
  code_execution:  { actionClass: "code_execution",  defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "medium",   maxPerHour: 20,  cronAllowed: true },
  execute_command: { actionClass: "execute_command", defaultLevel: "L2_confirm_execute",requiresAudit: true,  riskTier: "high",     maxPerHour: 30,  cronAllowed: false },
  delegate_agent:  { actionClass: "delegate_agent",  defaultLevel: "L3_bounded_auto",   requiresAudit: true,  riskTier: "medium",   maxPerHour: 50,  cronAllowed: true },
};

// ── Output Boundary Classifications (from spec: agent-boundaries.ts) ────────

export type OutputBoundaryClassification =
  | "advisory_only"        // suggestion, no approval needed
  | "draft_candidate"      // proposal requiring user edit/confirm
  | "approval_required"    // requires explicit permission before mutation
  | "workflow_only"        // routed to workflow system
  | "no_direct_execution"; // cannot be executed directly, ever

export function classifyBoundary(riskTier: RiskTier): OutputBoundaryClassification {
  switch (riskTier) {
    case "low":      return "advisory_only";
    case "medium":   return "draft_candidate";
    case "high":     return "approval_required";
    case "critical": return "approval_required";
    default:         return "draft_candidate";
  }
}

// ── Contract Violations (from spec: agent-boundaries.ts) ────────────────────

export type ViolationSeverity = "critical" | "high" | "medium";

export interface ContractViolation {
  violation: string;
  severity: ViolationSeverity;
  response: string;
}

export const CONTRACT_VIOLATIONS: ContractViolation[] = [
  { violation: "Component emits execution command", severity: "critical", response: "Reject; escalate to admin" },
  { violation: "Derived value written to graph as fact", severity: "critical", response: "Roll back; escalate" },
  { violation: "Missing boundary classification", severity: "high", response: "Reject packet" },
  { violation: "Missing uncertainty fields", severity: "high", response: "Reject packet" },
  { violation: "Conflict suppressed in output", severity: "high", response: "Flag for review" },
  { violation: "Swarm activated without all conditions", severity: "medium", response: "Terminate; fallback" },
  { violation: "Twin prior overrides explicit user input", severity: "medium", response: "Discard twin dimension" },
];

// ── 8 Universal Agent Boundary Rules (from spec) ────────────────────────────

export const UNIVERSAL_RULES: readonly string[] = [
  "Derived values never persisted as first-class graph facts",
  "All outputs include boundary_classification",
  "All outputs include uncertainty (confidence, flags)",
  "No component may execute (only L5 through L6 gate)",
  "No component may approve (only user through L7)",
  "No component may mutate graph directly (only through L1 writer via L5)",
  "Handoffs are structured packets only (L3 packets.ts)",
  "Conflict is first-class — suppression is a contract violation",
];
