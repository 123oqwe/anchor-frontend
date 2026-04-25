/**
 * Concrete proposal handlers — one per mutation kind.
 * Registered once at boot via registerBuiltinProposalHandlers().
 */
import { registerProposalHandler } from "./proposals.js";
import type { MutationProposal } from "./proposals.js";
import { loadFixtures } from "../eval/runner.js";

export function registerBuiltinProposalHandlers(): void {
  // ── route_override ──────────────────────────────────────────────
  // GEPA proposes swaps like decision→Haiku. Fixture-selector picks
  // decision_task + guardrail_classify fixtures (the ones that exercise
  // the cheap-tier tasks). withCandidateApplied transiently sets the
  // override, runs eval, then restores.
  registerProposalHandler("route_override", {
    relevantFixtureIds: (p) => {
      // Map task → fixture categories it exercises
      const task = p.target;
      const categoryByTask: Record<string, string[]> = {
        decision:              ["decision_task"],
        morning_digest:        ["decision_task"],
        weekly_reflection:     ["decision_task"],
        graph_extraction:      [],   // no fixtures yet
        twin_edit_learning:    [],
        twin_result_learning:  [],
        guardrail_classify:    ["guardrail_classify"],
      };
      const categories = categoryByTask[task] ?? [];
      if (categories.length === 0) return [];
      const all = loadFixtures();
      return all.filter(f => categories.includes(f.category)).map(f => f.id);
    },
    withCandidateApplied: async (p, fn) => {
      const { setRouteOverride, clearRouteOverride, getRouteOverride } =
        await import("../infra/compute/telemetry.js");
      const previous = getRouteOverride(p.target);
      setRouteOverride(p.target, p.after);
      try { return await fn(); }
      finally {
        if (previous) setRouteOverride(p.target, previous);
        else clearRouteOverride(p.target);
      }
    },
    apply: async (p) => {
      const { setRouteOverride } = await import("../infra/compute/telemetry.js");
      setRouteOverride(p.target, p.after);
      console.log(`[Proposals] applied route_override ${p.target} → ${p.after}`);
    },
    revert: async (p) => {
      const { setRouteOverride, clearRouteOverride } = await import("../infra/compute/telemetry.js");
      if (p.before) setRouteOverride(p.target, p.before);
      else clearRouteOverride(p.target);
    },
  });

  // ── threshold_tune ──────────────────────────────────────────────
  // Diagnostic proposes changes to system_config (e.g. skill_match_threshold).
  // These are scalars — no transient eval possible on most, so we default
  // to "accept with warning" via empty fixture list.
  registerProposalHandler("threshold_tune", {
    relevantFixtureIds: () => [],     // no coverage → auto-accept w/ warning
    apply: async (p) => {
      const { db } = await import("../infra/storage/db.js");
      db.prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`
      ).run(p.target, String(p.after));
    },
  });

  // ── prompt_adaptation ───────────────────────────────────────────
  // Evolution proposes dimension mutations (decision_style, tone, etc.).
  // These affect ALL agents — the oracle_narrative fixtures cover persona.
  // withCandidateApplied: patches the evolution_state row before eval.
  registerProposalHandler("prompt_adaptation", {
    relevantFixtureIds: () => {
      const all = loadFixtures();
      return all
        .filter(f => f.category === "oracle_narrative" || f.category === "decision_task")
        .map(f => f.id);
    },
    withCandidateApplied: async (p, fn) => {
      const { db } = await import("../infra/storage/db.js");
      // Evolution state uses a dimension table: evolution_state(dimension, value)
      // p.target = dimension name, p.before = current value, p.after = proposed
      const prior = db.prepare(
        `SELECT value FROM evolution_state WHERE user_id=? AND dimension=?`
      ).get("default", p.target) as any;
      const priorValue = prior?.value;
      db.prepare(
        `INSERT INTO evolution_state (user_id, dimension, value, updated_at)
         VALUES ('default', ?, ?, datetime('now'))
         ON CONFLICT(user_id, dimension)
         DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).run(p.target, JSON.stringify(p.after));
      try { return await fn(); }
      finally {
        if (priorValue !== undefined) {
          db.prepare(
            `UPDATE evolution_state SET value=?, updated_at=datetime('now')
             WHERE user_id='default' AND dimension=?`
          ).run(priorValue, p.target);
        } else {
          db.prepare(`DELETE FROM evolution_state WHERE user_id='default' AND dimension=?`).run(p.target);
        }
      }
    },
    apply: async (p) => {
      const { db } = await import("../infra/storage/db.js");
      db.prepare(
        `INSERT INTO evolution_state (user_id, dimension, value, updated_at)
         VALUES ('default', ?, ?, datetime('now'))
         ON CONFLICT(user_id, dimension)
         DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).run(p.target, JSON.stringify(p.after));
    },
  });

  console.log("[Proposals] registered 3 handlers (route_override, threshold_tune, prompt_adaptation)");
}
