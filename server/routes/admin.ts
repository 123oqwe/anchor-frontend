import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { setApiKey, deleteApiKey, getApiKey } from "../infra/compute/keys.js";
import { getRegistryInfo } from "../execution/registry.js";
import { getHandStatus } from "../infra/hand/index.js";
import { getMCPStatus } from "../infra/mcp/index.js";
import { getRAGStatus } from "../infra/rag/index.js";
import { getEventStats, verifyHashChain, appendEvent, getEvents } from "../infra/storage/scanner-events.js";
import { writeContactAggregate, countAggregates } from "../graph/contact-aggregates.js";
import { getPermissionStatus, activateLockdown, deactivateLockdown, isLocked, setTrustLevel } from "../permission/gate.js";
import { type PermissionLevel, type ActionClass } from "../permission/levels.js";
import { PROVIDERS, MODELS } from "../infra/compute/providers.js";
import { getCapabilityRoster } from "../infra/compute/index.js";
import {
  getCostSummary, getPerformanceSummary, getRecentCalls, getCallDetail,
  getRouteOverride, setRouteOverride, clearRouteOverride, getAllOverrides,
} from "../infra/compute/telemetry.js";
import { TASK_ROUTES } from "../infra/compute/router.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

const router = Router();

// ── Get full roster for a capability (active + inactive models/providers) ───
router.get("/capability/:cap", (req, res) => {
  try {
    const roster = getCapabilityRoster(req.params.cap as any);
    res.json(roster);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Save an API key ─────────────────────────────────────────────────────────
router.put("/providers/:id/key", (req, res) => {
  const { id } = req.params;
  const { key } = req.body;
  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "key required" });
  }
  try {
    setApiKey(id, key);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Delete an API key ───────────────────────────────────────────────────────
router.delete("/providers/:id/key", (req, res) => {
  deleteApiKey(req.params.id);
  res.json({ ok: true });
});

// ── Test a provider's key with a tiny call ──────────────────────────────────
router.post("/providers/:id/test", async (req, res) => {
  const { id } = req.params;
  const provider = PROVIDERS.find(p => p.id === id);
  if (!provider) return res.status(404).json({ error: "Provider not found" });

  const key = getApiKey(id);
  if (!key) return res.status(400).json({ error: "No key configured for this provider" });

  // Pick a minimal test model for each provider
  const testModels: Record<string, string> = {
    anthropic: "claude-haiku-4-5-20251001",
    openai: "gpt-4o-mini",
    google: "gemini-2.0-flash",
    deepseek: "deepseek-chat",
    qwen: "qwen-turbo",
    mistral: "mistral-small-latest",
    xai: "grok-3-mini",
    groq: "llama-3.3-70b-versatile",
    moonshot: "kimi-k2.5",
    zhipu: "glm-4-flash",
    together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    perplexity: "sonar",
    openrouter: "meta-llama/llama-3.3-70b-instruct",
    fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  };

  const modelId = testModels[id];
  if (!modelId) return res.status(400).json({ error: "No test model configured for this provider" });

  try {
    let model: any;
    switch (provider.protocol) {
      case "anthropic":
        model = createAnthropic({ apiKey: key })(modelId);
        break;
      case "google":
        model = createGoogleGenerativeAI({ apiKey: key })(modelId);
        break;
      case "openai-compat":
        model = createOpenAI({ apiKey: key, ...(provider.baseURL ? { baseURL: provider.baseURL } : {}) })(modelId);
        break;
    }

    const start = Date.now();
    const result = await generateText({
      model,
      messages: [{ role: "user", content: "Say 'ok' and nothing else." }],
      maxOutputTokens: 16,
    });
    const latency = Date.now() - start;

    res.json({
      ok: true,
      provider: provider.name,
      model: modelId,
      response: result.text.slice(0, 60),
      latencyMs: latency,
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err.message?.slice(0, 200) ?? "Unknown error",
    });
  }
});

// ── Telemetry: costs + performance ──────────────────────────────────────────

router.get("/costs", (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  res.json(getCostSummary(days));
});

router.get("/performance", (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  res.json(getPerformanceSummary(days));
});

router.get("/calls", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  res.json(getRecentCalls(limit));
});

router.get("/calls/:id", (req, res) => {
  const call = getCallDetail(req.params.id);
  if (!call) return res.status(404).json({ error: "Not found" });
  res.json(call);
});

// ── Route overrides ─────────────────────────────────────────────────────────

router.get("/overrides", (_req, res) => {
  res.json(getAllOverrides());
});

router.put("/overrides/:task", (req, res) => {
  const { modelId } = req.body;
  if (!modelId) return res.status(400).json({ error: "modelId required" });
  const task = req.params.task;
  if (!TASK_ROUTES[task]) return res.status(400).json({ error: "Unknown task" });
  if (!MODELS.find(m => m.id === modelId)) return res.status(400).json({ error: "Unknown model" });
  setRouteOverride(task, modelId);
  res.json({ ok: true });
});

router.delete("/overrides/:task", (req, res) => {
  clearRouteOverride(req.params.task);
  res.json({ ok: true });
});

// ── Tool registry ───────────────────────────────────────────────────────────

router.get("/tools", (_req, res) => {
  res.json(getRegistryInfo());
});

// ── Permission status ───────────────────────────────────────────────────────

router.get("/permissions", (_req, res) => {
  res.json({ ...getPermissionStatus(), lockdown: isLocked() });
});

router.post("/permissions/lockdown", (_req, res) => {
  activateLockdown();
  res.json({ ok: true, lockdown: true });
});

router.delete("/permissions/lockdown", (_req, res) => {
  deactivateLockdown();
  res.json({ ok: true, lockdown: false });
});

router.put("/permissions/trust/:actionClass", (req, res) => {
  const { level } = req.body;
  setTrustLevel(req.params.actionClass as ActionClass, level as PermissionLevel);
  res.json({ ok: true });
});

// ── Infrastructure status ────────────────────────────────────────────────────

router.get("/infra", (_req, res) => {
  res.json({
    hand: getHandStatus(),
    mcp: getMCPStatus(),
    rag: getRAGStatus(),
    events: getEventStats(),
  });
});

// ── Event log inspection + integrity audit ─────────────────────────────────
router.get("/events/stats", (_req, res) => {
  res.json(getEventStats());
});

router.get("/events/verify", (_req, res) => {
  res.json(verifyHashChain());
});

// ── Demo seed for contact aggregates ───────────────────────────────────────
// Creates synthetic snapshot pairs (prior + now) against real person nodes so
// the TimeTravel UI shows populated cooling/warming + top-contacts without
// requiring a real deep scan. Idempotent via a tag in metadata; action=wipe
// clears only synthetic rows, leaving real scanner snapshots untouched.
router.post("/demo/contact-aggregates", (req, res) => {
  try {
    const action = String(req.query.action ?? "seed");
    if (action === "wipe") {
      const result = db.prepare(
        `DELETE FROM contact_aggregates WHERE user_id=? AND json_extract(metadata_json, '$._synthetic')=1`
      ).run(DEFAULT_USER_ID);
      return res.json({ wiped: result.changes });
    }

    const persons = db.prepare(
      `SELECT id, label FROM graph_nodes WHERE user_id=? AND type='person' AND valid_to IS NULL LIMIT 12`
    ).all(DEFAULT_USER_ID) as any[];
    if (persons.length === 0) return res.status(400).json({ error: "no person nodes in graph — create some first" });

    // Patterns: distribute persons across classifications so the UI shows
    // variety rather than all-cooling or all-warming. Each person gets ONE
    // prior snapshot (45 days ago) and ONE current snapshot.
    const patterns: { name: string; prior: number; now: number }[] = [
      { name: "cooling-strong", prior: 40, now: 6 },
      { name: "cooling-mild", prior: 20, now: 8 },
      { name: "stable", prior: 15, now: 16 },
      { name: "warming-mild", prior: 5, now: 18 },
      { name: "warming-strong", prior: 3, now: 35 },
      { name: "new-contact", prior: 0, now: 22 },
      { name: "silent", prior: 18, now: 0 },
    ];

    const priorAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const nowAt = new Date().toISOString();
    let created = 0;

    for (let i = 0; i < persons.length; i++) {
      const p = persons[i];
      const pat = patterns[i % patterns.length];
      const handle = `demo-${p.id}@synthetic.local`;

      if (pat.prior > 0) {
        writeContactAggregate({
          contactNodeId: p.id, contactHandle: handle, contactDisplayName: p.label,
          source: "mail", direction: "received",
          countInWindow: pat.prior, windowDays: 30,
          snapshotAt: priorAt,
          lastAt: priorAt,
          metadata: { _synthetic: 1, pattern: pat.name },
        });
        created++;
      }
      if (pat.now > 0) {
        writeContactAggregate({
          contactNodeId: p.id, contactHandle: handle, contactDisplayName: p.label,
          source: "mail", direction: "received",
          countInWindow: pat.now, windowDays: 30,
          snapshotAt: nowAt,
          lastAt: nowAt,
          metadata: { _synthetic: 1, pattern: pat.name },
        });
        created++;
      }
    }

    res.json({
      created,
      totalAggregates: countAggregates(),
      note: "Synthetic data tagged metadata._synthetic=1. Wipe with POST ?action=wipe.",
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.get("/events", (req, res) => {
  const source = (req.query.source as string) || undefined;
  const afterSeq = req.query.afterSeq ? Number(req.query.afterSeq) : undefined;
  const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;
  const events = getEvents({
    source: source as any,
    afterSeq,
    limit,
  });
  res.json({ events, count: events.length });
});

// ── RAG backfill — embed all existing memories that lack embeddings.
// One-shot admin action. Processes up to 500 per call (LIMIT) so long-running
// backfills return progress and can be re-invoked. Each call is idempotent:
// memories with existing embeddings are skipped via LEFT JOIN ... IS NULL.
router.post("/rag/backfill", async (_req, res) => {
  try {
    const before = getRAGStatus();
    const pending = db.prepare(`
      SELECT m.id, m.title, m.content
      FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE m.user_id = ? AND e.memory_id IS NULL AND m.status = 'active'
      ORDER BY m.created_at DESC
      LIMIT 500
    `).all(DEFAULT_USER_ID) as any[];

    if (pending.length === 0) {
      return res.json({ attempted: 0, embedded: 0, failed: 0, ...before, note: "no pending memories" });
    }

    const { autoEmbed } = await import("../infra/rag/index.js");
    const BATCH = 10;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      await Promise.all(slice.map((m: any) => autoEmbed(m.id, `${m.title}: ${m.content}`)));
    }

    const after = getRAGStatus();
    const embedded = after.totalEmbeddings - before.totalEmbeddings;
    res.json({
      attempted: pending.length,
      embedded,
      failed: pending.length - embedded,
      coverage: after.coverage,
      totalEmbeddings: after.totalEmbeddings,
      totalMemories: after.totalMemories,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "backfill failed" });
  }
});

// ── System Health Dashboard ─────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  try {
    // Confirm rate
    const totalConfirms = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=? AND signal_type='plan_confirmed'").get(DEFAULT_USER_ID) as any)?.c ?? 0;
    const totalRejects = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=? AND signal_type='plan_rejected'").get(DEFAULT_USER_ID) as any)?.c ?? 0;
    const totalDecisions = totalConfirms + totalRejects;
    const confirmRate = totalDecisions > 0 ? Math.round((totalConfirms / totalDecisions) * 100) : 0;

    // Avg response time (from llm_calls)
    const avgLatency = (db.prepare("SELECT AVG(latency_ms) as avg FROM llm_calls WHERE task='decision' AND created_at >= datetime('now', '-7 days')").get() as any)?.avg ?? 0;

    // Skill reuse
    const totalSkills = (db.prepare("SELECT COUNT(*) as c FROM skills WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
    const usedSkills = (db.prepare("SELECT COUNT(*) as c FROM skills WHERE user_id=? AND use_count > 0").get(DEFAULT_USER_ID) as any)?.c ?? 0;

    // Silent failures (agent_executions with status 'failed' in last 24h)
    const failures24h = (db.prepare("SELECT COUNT(*) as c FROM agent_executions WHERE user_id=? AND status='failed' AND created_at >= datetime('now', '-24 hours')").get(DEFAULT_USER_ID) as any)?.c ?? 0;

    // Top failure agents
    const topFailures = db.prepare(
      "SELECT agent, COUNT(*) as cnt FROM agent_executions WHERE user_id=? AND status='failed' AND created_at >= datetime('now', '-7 days') GROUP BY agent ORDER BY cnt DESC LIMIT 5"
    ).all(DEFAULT_USER_ID) as any[];

    // Evolution state
    const evolutionDims = db.prepare("SELECT dimension, current_value, evidence_count FROM evolution_state WHERE user_id=?").all(DEFAULT_USER_ID) as any[];

    // Dream log (last run)
    const lastDream = db.prepare("SELECT * FROM dream_log ORDER BY created_at DESC LIMIT 1").get() as any;

    // Permission audit summary
    const auditSummary = db.prepare(
      "SELECT decision, COUNT(*) as cnt FROM permission_audit WHERE created_at >= datetime('now', '-7 days') GROUP BY decision"
    ).all() as any[];

    res.json({
      confirmRate,
      totalDecisions,
      avgResponseMs: Math.round(avgLatency),
      skills: { total: totalSkills, used: usedSkills, reuseRate: totalSkills > 0 ? Math.round((usedSkills / totalSkills) * 100) : 0 },
      failures24h,
      topFailures,
      evolution: evolutionDims,
      lastDream,
      permissionAudit: auditSummary,
    });
  } catch (err: any) {
    // Some tables may not exist yet — return partial data gracefully
    res.json({
      confirmRate: 0, totalDecisions: 0, avgResponseMs: 0,
      skills: { total: 0, used: 0, reuseRate: 0 },
      failures24h: 0, topFailures: [], evolution: [], lastDream: null, permissionAudit: [],
      error: err.message,
    });
  }
});

router.get("/diagnostic", (_req, res) => {
  const latest = db.prepare("SELECT * FROM diagnostic_reports ORDER BY created_at DESC LIMIT 1").get() as any;
  if (!latest) return res.json(null);
  res.json({
    ...latest,
    data: JSON.parse(latest.data_json),
    alerts: JSON.parse(latest.alerts_json),
    fixesApplied: JSON.parse(latest.fixes_applied_json),
  });
});

// Manual trigger
router.post("/diagnostic/run", (_req, res) => {
  try {
    const { runDiagnostic } = require("../cognition/diagnostic.js");
    const report = runDiagnostic();
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── OPT-4: Agent Run Trace ─────────────────────────────────────────────────

// List recent runs (across all agents)
router.get("/runs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const rows = db.prepare(`
    SELECT DISTINCT run_id,
      (SELECT MIN(created_at) FROM agent_executions WHERE run_id=e.run_id) as started_at,
      (SELECT MAX(created_at) FROM agent_executions WHERE run_id=e.run_id) as finished_at,
      (SELECT COUNT(*) FROM agent_executions WHERE run_id=e.run_id) as tool_count,
      (SELECT COUNT(*) FROM llm_calls WHERE run_id=e.run_id) as llm_count,
      (SELECT COALESCE(SUM(cost_usd),0) FROM llm_calls WHERE run_id=e.run_id) as cost,
      (SELECT agent_name FROM llm_calls WHERE run_id=e.run_id LIMIT 1) as agent_name
    FROM agent_executions e
    WHERE run_id IS NOT NULL
    ORDER BY started_at DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// Full trace for a specific run
router.get("/runs/:runId/trace", (req, res) => {
  const runId = req.params.runId;

  const toolCalls = db.prepare(
    "SELECT id, agent, action, status, created_at FROM agent_executions WHERE run_id=? ORDER BY created_at"
  ).all(runId) as any[];

  const llmCalls = db.prepare(
    "SELECT id, task, model_id, provider_id, input_tokens, output_tokens, cost_usd, latency_ms, status, request_preview, response_preview, created_at FROM llm_calls WHERE run_id=? ORDER BY created_at"
  ).all(runId) as any[];

  // L8-Hand bridge: provider attempts (which bridge provider handled each capability call)
  const providerAttempts = db.prepare(
    "SELECT id, capability, provider_id, status, error_kind, reason, latency_ms, created_at FROM provider_attempts WHERE run_id=? ORDER BY created_at"
  ).all(runId) as any[];

  if (toolCalls.length === 0 && llmCalls.length === 0 && providerAttempts.length === 0) {
    return res.status(404).json({ error: "Run not found" });
  }

  // Merge into unified timeline
  const timeline = [
    ...toolCalls.map((t: any) => ({ type: "tool", ...t, ts: t.created_at })),
    ...llmCalls.map((l: any) => ({ type: "llm", ...l, ts: l.created_at })),
    ...providerAttempts.map((p: any) => ({ type: "provider", ...p, ts: p.created_at })),
  ].sort((a: any, b: any) => a.ts.localeCompare(b.ts));

  const totalCost = llmCalls.reduce((s: number, l: any) => s + (l.cost_usd ?? 0), 0);
  const totalTokens = llmCalls.reduce((s: number, l: any) => s + (l.input_tokens ?? 0) + (l.output_tokens ?? 0), 0);
  const startedAt = timeline[0]?.ts;
  const finishedAt = timeline[timeline.length - 1]?.ts;
  const durationMs = startedAt && finishedAt
    ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    : 0;

  res.json({
    runId,
    startedAt,
    finishedAt,
    durationMs,
    agentName: llmCalls[0]?.agent_name ?? "Unknown",
    totalCost,
    totalTokens,
    toolCount: toolCalls.length,
    llmCount: llmCalls.length,
    providerCount: providerAttempts.length,
    timeline,
  });
});

// ── Guardrails audit log ───────────────────────────────────────────────
router.get("/guardrails", async (req, res) => {
  const { listRecentGuardrailEvents } = await import("../execution/guardrails.js");
  const severity = typeof req.query.severity === "string" ? req.query.severity as any : undefined;
  const limit = req.query.limit ? Math.min(500, parseInt(String(req.query.limit), 10)) : 100;
  res.json({ events: listRecentGuardrailEvents({ severity, limit }) });
});

export default router;
