/**
 * Bridge telemetry — every provider attempt logged to provider_attempts.
 * Feeds the admin RunTrace view and future Twin learning (which provider
 * does Harry actually succeed with).
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

export type AttemptStatus = "success" | "failed" | "skipped";

export function logProviderAttempt(input: {
  capability: string;
  providerId: string;
  status: AttemptStatus;
  errorKind?: "terminal" | "retryable";
  reason?: string;
  latencyMs: number;
  runId?: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO provider_attempts (id, user_id, capability, provider_id, status, error_kind, reason, latency_ms, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nanoid(),
      DEFAULT_USER_ID,
      input.capability,
      input.providerId,
      input.status,
      input.errorKind ?? null,
      input.reason?.slice(0, 300) ?? null,
      Math.round(input.latencyMs),
      input.runId ?? null,
    );
  } catch (err: any) {
    console.error("[Bridge Telemetry] log failed:", err.message);
  }
}

export function getAttemptsForRun(runId: string) {
  return db.prepare(
    "SELECT * FROM provider_attempts WHERE run_id=? ORDER BY created_at ASC"
  ).all(runId);
}

export function getProviderHealthHistory(providerId: string, hours = 24) {
  return db.prepare(
    `SELECT status, COUNT(*) as n FROM provider_attempts
     WHERE provider_id=? AND created_at >= datetime('now', '-${hours} hours')
     GROUP BY status`
  ).all(providerId);
}

/** Token-bucket rate limit per (user, provider). */
interface Bucket { tokens: number; lastRefill: number; max: number; }
const buckets = new Map<string, Bucket>();

export async function acquireProviderRateLimit(providerId: string, maxPerMinute: number): Promise<void> {
  const key = `${DEFAULT_USER_ID}:${providerId}`;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: maxPerMinute, lastRefill: Date.now(), max: maxPerMinute };
    buckets.set(key, b);
  }
  const now = Date.now();
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(b.max, b.tokens + (elapsed / 60) * b.max);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }
  const waitMs = Math.ceil(((1 - b.tokens) / b.max) * 60 * 1000);
  await new Promise(r => setTimeout(r, waitMs));
  b.tokens = 0;
}
