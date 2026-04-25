#!/usr/bin/env tsx
/**
 * CLI entry for the eval harness.
 *
 * Usage:
 *   npx tsx server/eval/run.ts                     # all fixtures
 *   npx tsx server/eval/run.ts --only id1,id2      # subset
 *   npx tsx server/eval/run.ts --category profile_inference
 *   npx tsx server/eval/run.ts --threshold 0.9     # stricter pass bar
 *
 * Exit code: 0 if all non-skipped fixtures passed, 1 otherwise.
 * JSON report written to .eval-report.json for CI artifacts.
 */
import fs from "fs";
import { runEval } from "./runner.js";

function parseArgs() {
  const argv = process.argv.slice(2);
  const out: { only?: string[]; category?: string; threshold?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) { out.only = argv[++i].split(","); }
    else if (argv[i] === "--category" && argv[i + 1]) { out.category = argv[++i]; }
    else if (argv[i] === "--threshold" && argv[i + 1]) { out.threshold = parseFloat(argv[++i]); }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  console.log("[eval] running...");
  const result = await runEval({ ...args, passThreshold: args.threshold, verbose: true });

  console.log("\n────────────────────────────────");
  console.log(`  Fixtures:          ${result.totalFixtures}`);
  console.log(`  Passed:            ${result.passed}`);
  console.log(`  Failed:            ${result.failed}`);
  console.log(`  Skipped:           ${result.skipped}`);
  console.log(`  Avg passRatio:     ${(result.avgPassRatio * 100).toFixed(1)}%`);
  console.log(`  Avg κ (agreement): ${Number.isFinite(result.avgKappa) ? result.avgKappa.toFixed(2) : "n/a"}`);
  console.log(`  Duration:          ${result.durationMs}ms`);
  console.log("────────────────────────────────");

  if (result.failed > 0) {
    console.log("\nFailed fixtures:");
    for (const r of result.fixtures) {
      if (r.passed || r.skipped) continue;
      console.log(`  ✗ ${r.fixtureId}: ${r.description}`);
      if (r.error) console.log(`     ERROR: ${r.error}`);
      else {
        console.log(`     passRatio=${(r.passRatio * 100).toFixed(0)}% κ=${Number.isFinite(r.ensembleAgreementKappa) ? r.ensembleAgreementKappa.toFixed(2) : "n/a"}`);
        if (!r.cheapChecks.expectedContains) console.log(`     cheap-check: missing expected substrings`);
        if (!r.cheapChecks.expectedNotContains) console.log(`     cheap-check: has forbidden substrings`);
      }
    }
  }

  try {
    fs.writeFileSync(".eval-report.json", JSON.stringify(result, null, 2));
    console.log("\n→ Report: .eval-report.json");
  } catch (err: any) {
    console.error("[eval] could not write report:", err.message);
  }

  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
