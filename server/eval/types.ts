/**
 * Eval harness types — fixture format + result shapes.
 *
 * A fixture is one atomic test case: a target function + input + a rubric
 * of binary yes/no criteria the output must satisfy. The judge verifies
 * each criterion independently; the fixture passes when the ENSEMBLE of
 * judges agrees on enough criteria (default: 80% of rubric items).
 *
 * Binary-only rubric is a deliberate choice (research consensus 2025):
 * continuous scores from LLM judges are noisy and hard to calibrate.
 * Binary questions force the judge to commit, and ensemble agreement
 * (Cohen's κ) gives us a reliable confidence number.
 */

export type EvalCategory =
  | "profile_inference"     // MacProfile → InferredProfile semantic correctness
  | "oracle_narrative"      // InferredProfile → Oracle narrative quality
  | "custom_agent"          // user_message → agent output quality
  | "guardrail_classify"    // text → classifier verdict accuracy
  | "decision_task";        // generic LLM reasoning

export interface EvalFixture {
  id: string;
  description: string;
  category: EvalCategory;
  input: any;               // target-specific shape, validated at dispatch time
  rubric: string[];         // binary criteria — each gets yes/no from judge
  expectedContains?: string[];   // cheap pre-check: all these substrings must appear
  expectedNotContains?: string[];// cheap pre-check: none of these may appear
  skipIf?: string;          // env var name — if set (="1"), skip fixture
  timeoutMs?: number;
}

export interface JudgeVerdict {
  judgeIndex: number;       // 0..N for ensemble
  verdicts: Record<string, boolean>;  // rubric-id → yes/no
  rationale?: string;       // short judge explanation
}

export interface FixtureResult {
  fixtureId: string;
  description: string;
  category: EvalCategory;
  passed: boolean;
  passRatio: number;        // fraction of rubric items with ≥ majority "yes"
  ensembleAgreementKappa: number;  // Cohen's κ across judges (-1..+1)
  judgeVerdicts: JudgeVerdict[];
  output: string;           // the model output being judged (truncated)
  cheapChecks: { expectedContains: boolean; expectedNotContains: boolean };
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

export interface RunResult {
  fixtures: FixtureResult[];
  totalFixtures: number;
  passed: number;
  failed: number;
  skipped: number;
  avgPassRatio: number;
  avgKappa: number;
  startedAt: string;
  durationMs: number;
}
