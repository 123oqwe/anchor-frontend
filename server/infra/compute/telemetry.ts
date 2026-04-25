/**
 * Cortex Telemetry — logs every LLM call with cost, latency, tokens, payloads.
 */
import { db } from "../storage/db.js";
import { nanoid } from "nanoid";
import { estimateCost } from "./providers.js";

export interface CallLogInput {
  task: string;
  capability?: string;
  modelId: string;
  providerId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;   // Anthropic prompt cache — tokens written to cache (1.25× input price)
  cacheReadTokens?: number;       // Anthropic prompt cache — tokens read from cache (0.1× input price)
  latencyMs: number;
  status: "success" | "failed" | "fallback";
  error?: string;
  requestPreview?: string;
  responsePreview?: string;
  runId?: string;      // OPT-4: trace correlation
  agentName?: string;  // OPT-4: which agent called this LLM
}

export function logCall(input: CallLogInput): void {
  // Cost accounting with cache multipliers (Anthropic): cache_write=1.25×,
  // cache_read=0.1×. We store raw tokens + a composite cost_usd so the DB
  // reflects real spend, not just base pricing.
  let cost: number | null = null;
  if (input.inputTokens !== undefined && input.outputTokens !== undefined) {
    const baseCost = estimateCost(input.modelId, input.inputTokens, input.outputTokens);
    const cacheCreate = input.cacheCreationTokens
      ? estimateCost(input.modelId, input.cacheCreationTokens, 0) * 1.25
      : 0;
    const cacheRead = input.cacheReadTokens
      ? estimateCost(input.modelId, input.cacheReadTokens, 0) * 0.1
      : 0;
    cost = baseCost + cacheCreate + cacheRead;
  }

  db.prepare(
    `INSERT INTO llm_calls
     (id, task, capability, model_id, provider_id, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens,
      cost_usd, latency_ms, status, error, request_preview, response_preview, run_id, agent_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nanoid(),
    input.task,
    input.capability ?? null,
    input.modelId,
    input.providerId,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    input.cacheCreationTokens ?? null,
    input.cacheReadTokens ?? null,
    cost,
    input.latencyMs,
    input.status,
    input.error ?? null,
    input.requestPreview ?? null,
    input.responsePreview ?? null,
    input.runId ?? null,
    input.agentName ?? null,
  );
}

// ── Aggregation queries for admin ───────────────────────────────────────────

export function getCostSummary(days = 7) {
  const since = `datetime('now', '-${days} days')`;
  return {
    total: db.prepare(`SELECT COALESCE(SUM(cost_usd),0) as v FROM llm_calls WHERE created_at >= ${since}`).get() as any,
    callCount: db.prepare(`SELECT COUNT(*) as v FROM llm_calls WHERE created_at >= ${since}`).get() as any,
    failureRate: db.prepare(`SELECT
      CAST(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) as v
      FROM llm_calls WHERE created_at >= ${since}`).get() as any,
    byProvider: db.prepare(`SELECT provider_id,
      COUNT(*) as calls,
      COALESCE(SUM(cost_usd),0) as cost,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      AVG(latency_ms) as avg_latency
      FROM llm_calls WHERE created_at >= ${since}
      GROUP BY provider_id ORDER BY cost DESC`).all(),
    byTask: db.prepare(`SELECT task,
      COUNT(*) as calls,
      COALESCE(SUM(cost_usd),0) as cost,
      AVG(latency_ms) as avg_latency
      FROM llm_calls WHERE created_at >= ${since}
      GROUP BY task ORDER BY cost DESC`).all(),
    byModel: db.prepare(`SELECT model_id, provider_id,
      COUNT(*) as calls,
      COALESCE(SUM(cost_usd),0) as cost,
      AVG(latency_ms) as avg_latency,
      CAST(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) as success_rate
      FROM llm_calls WHERE created_at >= ${since}
      GROUP BY model_id ORDER BY cost DESC`).all(),
    byDay: db.prepare(`SELECT date(created_at) as day,
      COUNT(*) as calls,
      COALESCE(SUM(cost_usd),0) as cost
      FROM llm_calls WHERE created_at >= ${since}
      GROUP BY day ORDER BY day`).all(),
  };
}

export function getPerformanceSummary(days = 7) {
  const since = `datetime('now', '-${days} days')`;
  return db.prepare(`SELECT
    model_id, provider_id, task,
    COUNT(*) as calls,
    AVG(latency_ms) as avg_ms,
    MIN(latency_ms) as min_ms,
    MAX(latency_ms) as max_ms,
    CAST(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) as success_rate,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failures
    FROM llm_calls WHERE created_at >= ${since}
    GROUP BY model_id, task
    ORDER BY calls DESC`).all();
}

export function getRecentCalls(limit = 100) {
  return db.prepare(`SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function getCallDetail(id: string) {
  return db.prepare(`SELECT * FROM llm_calls WHERE id = ?`).get(id);
}

// ── Route Override ──────────────────────────────────────────────────────────

export function getRouteOverride(task: string): string | null {
  const row = db.prepare("SELECT model_id FROM route_overrides WHERE task = ?").get(task) as any;
  return row?.model_id ?? null;
}

export function setRouteOverride(task: string, modelId: string): void {
  db.prepare(
    `INSERT INTO route_overrides (task, model_id, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(task) DO UPDATE SET model_id=excluded.model_id, updated_at=excluded.updated_at`
  ).run(task, modelId);
}

export function clearRouteOverride(task: string): void {
  db.prepare("DELETE FROM route_overrides WHERE task = ?").run(task);
}

export function getAllOverrides(): Record<string, string> {
  const rows = db.prepare("SELECT task, model_id FROM route_overrides").all() as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.task] = r.model_id;
  return out;
}

// ── Rate Limiter (token bucket per provider) ────────────────────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
  maxPerMinute: number;
}

// Conservative defaults — providers have their own limits, this prevents runaway
const DEFAULT_LIMITS: Record<string, number> = {
  anthropic: 50,     // requests per minute
  openai: 60,
  google: 60,
  deepseek: 60,
  qwen: 60,
  default: 60,
};

const buckets = new Map<string, Bucket>();

export async function acquireRateLimit(providerId: string): Promise<void> {
  const max = DEFAULT_LIMITS[providerId] ?? DEFAULT_LIMITS.default;
  let bucket = buckets.get(providerId);
  if (!bucket) {
    bucket = { tokens: max, lastRefill: Date.now(), maxPerMinute: max };
    buckets.set(providerId, bucket);
  }

  // Refill
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  const refillAmount = (elapsed / 60) * bucket.maxPerMinute;
  bucket.tokens = Math.min(bucket.maxPerMinute, bucket.tokens + refillAmount);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  // Wait until 1 token available
  const waitMs = Math.ceil(((1 - bucket.tokens) / bucket.maxPerMinute) * 60 * 1000);
  console.log(`[RateLimit] ${providerId} bucket empty, waiting ${waitMs}ms`);
  await new Promise(r => setTimeout(r, waitMs));
  bucket.tokens = 0;
}
