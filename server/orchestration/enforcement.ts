/**
 * L4 Orchestration — Handoff Enforcement + Error Routing.
 *
 * From spec: handoff-semantics.ts
 * Canonical sequence: Trigger → Orchestrator → Twin → Decision → Swarm → downstream
 * Prohibited: Direct agent-to-agent calls, direct execution without approval
 *
 * Also handles:
 * - Error routing (retry failed events)
 * - Dead letter queue (persist failed events for manual review)
 * - Event persistence (all events written to DB)
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { type AnchorEvent } from "./bus.js";

// ── Handoff validation ──────────────────────────────────────────────────────

type Component = "orchestrator" | "decision" | "twin" | "execution" | "swarm" | "memory" | "observation";

const LEGAL_HANDOFFS: [Component, Component][] = [
  ["orchestrator", "decision"],
  ["orchestrator", "twin"],
  ["orchestrator", "swarm"],
  ["orchestrator", "execution"],
  ["orchestrator", "memory"],
  ["orchestrator", "observation"],
  ["decision", "orchestrator"],   // return result
  ["twin", "orchestrator"],       // return result
  ["swarm", "orchestrator"],      // return result
  ["execution", "orchestrator"],  // return result
];

const PROHIBITED_HANDOFFS: [Component, Component, string][] = [
  ["decision", "twin", "Decision Agent cannot directly invoke Twin"],
  ["decision", "execution", "Decision Agent cannot directly execute"],
  ["twin", "execution", "Twin cannot directly execute"],
  ["swarm", "execution", "Swarm cannot directly execute"],
  ["execution", "decision", "Execution cannot re-invoke Decision"],
];

import { checkViolation } from "../permission/gate.js";

export function validateHandoff(from: Component, to: Component): { valid: boolean; reason?: string } {
  // Check prohibited first
  for (const [pFrom, pTo, reason] of PROHIBITED_HANDOFFS) {
    if (from === pFrom && to === pTo) {
      console.error(`[Enforcement] PROHIBITED HANDOFF: ${from} → ${to}: ${reason}`);
      // Report to L6 contract violation system
      checkViolation(`Component emits execution command: ${from} → ${to}`);
      return { valid: false, reason };
    }
  }
  // Check legal
  const isLegal = LEGAL_HANDOFFS.some(([lFrom, lTo]) => lFrom === from && lTo === to);
  if (!isLegal) {
    console.warn(`[Enforcement] UNREGISTERED HANDOFF: ${from} → ${to}`);
    return { valid: false, reason: `Handoff ${from} → ${to} not in legal registry` };
  }
  return { valid: true };
}

// ── Event persistence ───────────────────────────────────────────────────────

export function persistEvent(event: AnchorEvent, status: "processed" | "failed" | "retry"): void {
  db.prepare(
    "INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)"
  ).run(nanoid(), DEFAULT_USER_ID, "EventBus", `${event.type}: ${JSON.stringify(event.payload).slice(0, 150)}`, status);
}

// ── Error routing + retry ───────────────────────────────────────────────────

interface FailedEvent {
  event: AnchorEvent;
  error: string;
  attempts: number;
  firstFailedAt: string;
}

const failedEvents: FailedEvent[] = [];
const MAX_RETRIES = 2;

export function recordFailure(event: AnchorEvent, error: string): boolean {
  const existing = failedEvents.find(f => f.event.type === event.type && JSON.stringify(f.event.payload) === JSON.stringify(event.payload));
  if (existing) {
    existing.attempts++;
    existing.error = error;
    if (existing.attempts > MAX_RETRIES) {
      // Dead letter — persist and stop retrying
      persistEvent(event, "failed");
      console.error(`[Enforcement] DEAD LETTER: ${event.type} failed ${existing.attempts} times, giving up`);
      failedEvents.splice(failedEvents.indexOf(existing), 1);
      return false; // do not retry
    }
    return true; // retry
  }
  failedEvents.push({ event, error, attempts: 1, firstFailedAt: new Date().toISOString() });
  return true; // retry first failure
}

export function getDeadLetterQueue(): FailedEvent[] {
  return [...failedEvents];
}

// ── Proactive suggestion check (for cron) ───────────────────────────────────

export function checkProactiveTriggers(): { shouldSuggest: boolean; reason: string } | null {
  // Check for overdue items that haven't been surfaced
  const overdue = db.prepare(
    "SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed') AND julianday('now') - julianday(updated_at) > 2"
  ).get(DEFAULT_USER_ID) as any;

  if (overdue?.c > 0) {
    return { shouldSuggest: true, reason: `${overdue.c} items overdue for 2+ days` };
  }

  // Check for decaying relationships
  const decaying = db.prepare(
    "SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=? AND type='person' AND status='decaying'"
  ).get(DEFAULT_USER_ID) as any;

  if (decaying?.c > 0) {
    return { shouldSuggest: true, reason: `${decaying.c} relationships decaying` };
  }

  return null;
}
