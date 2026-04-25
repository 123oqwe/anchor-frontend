/**
 * Workflow handler registry — bridges workflow jobs to the actual code that
 * does work. Each handler is registered once at boot; workflows reference
 * them by name. Keeps the workflow DAG declarative (data) separate from
 * imperative job code.
 *
 * Why string handlers instead of importing functions directly?
 *   - Workflows may be user-configurable later (stored in DB)
 *   - Dynamic import deferral lets the workflow module avoid pulling the
 *     entire cognition/memory graph at require time
 *   - Handler names are stable contracts we can version
 */
import { registerHandler } from "./workflow.js";
import { logExecution } from "../infra/storage/db.js";

export function registerBuiltinHandlers(): void {
  // ── L3 Cognition ──────────────────────────────────────────────────
  registerHandler("dream.run", async () => {
    const { runDream } = await import("../memory/dream.js");
    const { invalidateSnapshot } = await import("../memory/retrieval.js");
    const { cleanupOldCaptures } = await import("../integrations/local/activity-monitor.js");
    const stats = await runDream();
    invalidateSnapshot();   // memory snapshot cache must reflect post-dream state
    let cleaned = 0;
    try { cleaned = cleanupOldCaptures(); } catch (err) { console.error("[Workflow] Activity cleanup failed:", err); }
    return { ...stats, capturesCleaned: cleaned };
  });

  registerHandler("evolution.run", async () => {
    const { runPersonalEvolution } = await import("../cognition/evolution.js");
    return await runPersonalEvolution();
  });

  registerHandler("twin.reflect_weekly", async () => {
    // Extract the weekly-reflection body that currently lives inline in cron.ts.
    // Returns { reflection } shape so a downstream job could consume it.
    const { db } = await import("../infra/storage/db.js");
    const execs = db.prepare(
      "SELECT agent, action, status FROM agent_executions WHERE user_id=? AND created_at >= datetime('now','-7 days') ORDER BY created_at"
    ).all("default") as any[];
    return { executionCount: execs.length, failureCount: execs.filter((e: any) => e.status === "failed").length };
  });

  registerHandler("gepa.analyze", async () => {
    const { analyzeExecutionTraces } = await import("../cognition/gepa.js");
    return await analyzeExecutionTraces();
  });

  registerHandler("diagnostic.run", async () => {
    const { runDiagnostic } = await import("../cognition/diagnostic.js");
    return await runDiagnostic();
  });

  registerHandler("feedback.detect", async () => {
    const { detectRePrompts, detectAbandonment } = await import("../cognition/feedback.js");
    const rp = detectRePrompts({ windowMinutes: 15, sinceMinutes: 60 * 24 });
    const ab = detectAbandonment({ staleHours: 24, sinceHours: 72 });
    return { rePrompts: rp, abandonments: ab };
  });

  // ── L1 Graph / Timeline ───────────────────────────────────────────
  registerHandler("graph.decay_nodes", async (ctx) => {
    const { markStaleAsDecaying } = await import("../graph/writer.js");
    const days = ctx.params?.days ?? 5;
    return { marked: markStaleAsDecaying(days) };
  });

  registerHandler("graph.close_stale_edges", async () => {
    const { closeStaleEdges } = await import("../graph/writer.js");
    return { closed: closeStaleEdges(90) };
  });

  registerHandler("graph.weekly_growth_card", async () => {
    const { generateWeeklyGrowthCard } = await import("../graph/what-changed.js");
    const { recordEvent } = await import("../graph/timeline.js");
    const card = generateWeeklyGrowthCard();
    const extId = `growth:weekly:${card.windowStart.slice(0, 10)}`;
    recordEvent({
      externalId: extId,
      occurredAt: card.windowEnd,
      source: "task",
      kind: "task-completed" as any,
      summary: card.headline,
      detail: card.bullets.join(" · "),
      metadata: { source: "growth_card", ...card },
    });
    return { headline: card.headline, bullets: card.bullets.length };
  });

  // ── L2 Infra ──────────────────────────────────────────────────────
  registerHandler("backup.encrypted", async (ctx) => {
    const { createBackup } = await import("../infra/storage/backup.js");
    return createBackup({ destination: ctx.params?.destination });
  });

  // ── L4 Integration pipelines ──────────────────────────────────────
  registerHandler("ingestion.run", async (ctx) => {
    const { runIngestion } = await import("../integrations/pipeline.js");
    const { DEFAULT_USER_ID } = await import("../infra/storage/db.js");
    const result = await runIngestion(DEFAULT_USER_ID, ctx.params?.runType ?? "incremental");
    return result ?? { skipped: true };
  });

  // ── Checkpoint recovery ───────────────────────────────────────────
  registerHandler("runs.recover_stale", async (ctx) => {
    const { recoverStaleRuns } = await import("../execution/checkpoint.js");
    return { abandoned: recoverStaleRuns(ctx.params?.staleMinutes ?? 10) };
  });

  // ── Profile auto-refresh ──────────────────────────────────────────
  // Check staleness; if threshold crossed, run inferProfile (heavy LLM
  // call). The check job is cheap so it runs daily in cron — the
  // inference job only fires when genuinely needed.
  registerHandler("profile.check_staleness", async () => {
    const { computeStaleness } = await import("../cognition/profile-staleness.js");
    const s = computeStaleness();
    if (!s.shouldAutoRefresh || s.alreadyRunning) {
      return { refreshed: false, ...s };
    }
    return { refreshed: true, triggerReasons: s.reasons, signals: s.signals };
  });

  registerHandler("profile.infer", async (ctx) => {
    const { computeStaleness } = await import("../cognition/profile-staleness.js");
    // Guard: only proceed if upstream check_staleness marked refresh=true.
    // This lets us run both the check and the inference in one DAG where
    // the infer job conditionally executes based on upstream output.
    const upstream = ctx.upstreamOutputs?.check_staleness;
    if (upstream && upstream.refreshed === false) {
      return { skipped: true, reason: "not_stale" };
    }
    // Fallback check — defensive if caller invokes profile.infer directly
    const s = computeStaleness();
    if (!s.shouldAutoRefresh && !ctx.params?.force) {
      return { skipped: true, reason: "not_stale" };
    }
    const { inferProfile } = await import("../cognition/profile-inference.js");
    const profile = await inferProfile({ persist: true });
    return {
      refreshed: true,
      version: profile.identity.confidence,
      relationshipCount: profile.key_relationships?.length ?? 0,
      interestCount: profile.active_interests?.length ?? 0,
    };
  });

  // ── Mutation proposals (eval-as-gate) ─────────────────────────────
  // evaluate: score every pending proposal against its kind's fixtures;
  // apply_accepted: deploy anything the gate accepted. These chain after
  // the proposer handlers (gepa, evolution, skills) so mutations are
  // always reviewed before hitting live system config.
  registerHandler("proposals.evaluate_pending", async (ctx) => {
    const { listProposals, evaluateProposal } = await import("../cognition/proposals.js");
    const source = ctx.params?.source;
    const pending = listProposals({ status: "pending", source, limit: 50 });
    const results: any[] = [];
    for (const p of pending) {
      try {
        const r = await evaluateProposal(p.id);
        results.push({ id: p.id, status: r.status, score: r.score, reason: r.reason });
      } catch (err: any) {
        results.push({ id: p.id, status: "error", error: err?.message });
      }
    }
    return { evaluated: results.length, results };
  });

  registerHandler("proposals.apply_accepted", async (ctx) => {
    const { applyAccepted } = await import("../cognition/proposals.js");
    const source = ctx.params?.source;
    return await applyAccepted(source ? { source } : {});
  });

  console.log(`[Workflow] registered 12 handlers`);
}
