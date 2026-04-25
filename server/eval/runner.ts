/**
 * Eval runner — load fixtures, dispatch to target, judge output, aggregate.
 *
 * Run from CI via `npx tsx server/eval/run.ts` (exit 0/1 + JSON report).
 * Run from dev via `npx tsx server/eval/run.ts --only <fixture-id>`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { judgeOutput, aggregateJudges } from "./judge.js";
import type { EvalFixture, FixtureResult, RunResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, "fixtures");
const DEFAULT_PASS_THRESHOLD = 0.8;    // fixture passes if ≥80% of rubric items pass

// ── Fixture loading ────────────────────────────────────────────────────

export function loadFixtures(filter?: { only?: string[]; category?: string }): EvalFixture[] {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json"));
  const fixtures: EvalFixture[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(FIXTURE_DIR, f), "utf-8");
      const parsed = JSON.parse(raw);
      const list: EvalFixture[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const fx of list) fixtures.push(fx);
    } catch (err: any) {
      console.error(`[eval] skipping ${f}: ${err.message}`);
    }
  }
  let out = fixtures;
  if (filter?.only && filter.only.length) {
    const set = new Set(filter.only);
    out = out.filter(f => set.has(f.id));
  }
  if (filter?.category) out = out.filter(f => f.category === filter.category);
  return out;
}

// ── Target dispatcher — turns a fixture into "the string the judge reads" ──

async function dispatch(fixture: EvalFixture): Promise<string> {
  switch (fixture.category) {
    case "profile_inference": {
      const { inferProfile } = await import("../cognition/profile-inference.js");
      const profile = await inferProfile({
        macProfile: fixture.input as any,
        persist: false,
        writeGraph: false,
      });
      return JSON.stringify(profile, null, 2);
    }
    case "oracle_narrative": {
      const { runOracleCouncil } = await import("../cognition/oracle-council.js");
      const portrait = await runOracleCouncil({
        profile: fixture.input,
        persist: false, stream: false,
      });
      return JSON.stringify({
        headline: portrait.compass.headline,
        paragraph: portrait.compass.paragraph,
        oracles: portrait.oracles.map(o => ({
          name: o.displayName,
          narrative: o.narrative,
          questions: o.questions,
        })),
      }, null, 2);
    }
    case "guardrail_classify": {
      const { classify } = await import("../execution/guardrails.js");
      const v = await classify(
        fixture.input.text,
        fixture.input.context ?? "tool_result",
        {},
      );
      return JSON.stringify(v, null, 2);
    }
    case "custom_agent":
    case "decision_task": {
      const { text } = await import("../infra/compute/index.js");
      return await text({
        task: fixture.input.task ?? "decision",
        system: fixture.input.system ?? "",
        messages: [{ role: "user", content: fixture.input.message ?? "" }],
        maxTokens: fixture.input.maxTokens ?? 500,
      });
    }
  }
}

// ── Cheap pre-checks (catch errors before spending on judges) ───────────

function runCheapChecks(output: string, fixture: EvalFixture): { expectedContains: boolean; expectedNotContains: boolean } {
  const lower = output.toLowerCase();
  const mustHave = (fixture.expectedContains ?? []).every(s => lower.includes(s.toLowerCase()));
  const mustNotHave = (fixture.expectedNotContains ?? []).every(s => !lower.includes(s.toLowerCase()));
  return { expectedContains: mustHave, expectedNotContains: mustNotHave };
}

// ── Main run loop ──────────────────────────────────────────────────────

export interface RunOpts {
  only?: string[];
  category?: string;
  passThreshold?: number;
  verbose?: boolean;
}

export async function runEval(opts: RunOpts = {}): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const runStart = Date.now();
  const threshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const fixtures = loadFixtures({ only: opts.only, category: opts.category });

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    if (fixture.skipIf && process.env[fixture.skipIf] === "1") {
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        category: fixture.category,
        passed: true, passRatio: 1, ensembleAgreementKappa: 1,
        judgeVerdicts: [], output: "", cheapChecks: { expectedContains: true, expectedNotContains: true },
        durationMs: 0, skipped: true, skipReason: `env ${fixture.skipIf}=1`,
      });
      continue;
    }
    const t0 = Date.now();
    let output = "", error: string | undefined;
    try {
      output = await dispatch(fixture);
    } catch (err: any) {
      error = err?.message ?? String(err);
    }

    if (error) {
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        category: fixture.category,
        passed: false, passRatio: 0, ensembleAgreementKappa: 0,
        judgeVerdicts: [], output: "",
        cheapChecks: { expectedContains: false, expectedNotContains: false },
        durationMs: Date.now() - t0,
        error,
      });
      if (opts.verbose) console.log(`  ✗ ${fixture.id} ERROR: ${error}`);
      continue;
    }

    const cheap = runCheapChecks(output, fixture);
    const verdicts = await judgeOutput(output, fixture.rubric, fixture.description);
    const agg = aggregateJudges(verdicts, fixture.rubric);
    // Fixture passes only if cheap checks pass AND rubric passRatio ≥ threshold
    const passed = cheap.expectedContains && cheap.expectedNotContains && agg.passRatio >= threshold;

    results.push({
      fixtureId: fixture.id,
      description: fixture.description,
      category: fixture.category,
      passed, passRatio: agg.passRatio, ensembleAgreementKappa: agg.kappa,
      judgeVerdicts: verdicts,
      output: output.slice(0, 4000),
      cheapChecks: cheap,
      durationMs: Date.now() - t0,
    });
    if (opts.verbose) {
      const mark = passed ? "✓" : "✗";
      console.log(`  ${mark} ${fixture.id} passRatio=${(agg.passRatio * 100).toFixed(0)}% κ=${agg.kappa.toFixed(2)} ${Date.now() - t0}ms`);
    }
  }

  const passed = results.filter(r => r.passed && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.length - passed - skipped;
  const nonSkipped = results.filter(r => !r.skipped);
  const avgPassRatio = nonSkipped.length > 0
    ? nonSkipped.reduce((s, r) => s + r.passRatio, 0) / nonSkipped.length
    : 0;
  const validKappas = nonSkipped.map(r => r.ensembleAgreementKappa).filter(k => Number.isFinite(k));
  const avgKappa = validKappas.length > 0
    ? validKappas.reduce((s, x) => s + x, 0) / validKappas.length
    : NaN;

  return {
    fixtures: results,
    totalFixtures: results.length,
    passed, failed, skipped,
    avgPassRatio, avgKappa,
    startedAt,
    durationMs: Date.now() - runStart,
  };
}
