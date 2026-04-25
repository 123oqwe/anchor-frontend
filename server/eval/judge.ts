/**
 * LLM judge with 3-judge ensemble + Cohen's κ agreement tracking.
 *
 * Each judge reviews the model output against a binary rubric. Majority
 * vote per rubric item. κ quantifies inter-judge agreement — when κ is
 * low, the verdict is flagged "needs human spot-check" (but we don't
 * block CI on it, we surface it).
 *
 * Temperature diversity: judges run at T=0.0 / 0.3 / 0.6 to give
 * meaningful ensemble variance without drifting too far from calibrated
 * behavior. Judge model is Haiku by default ($0.80/MTok, ~1s/judgment).
 */
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "../infra/compute/keys.js";
import type { JudgeVerdict } from "./types.js";

const JUDGE_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_TIMEOUT_MS = 20_000;
const JUDGE_TEMPS = [0.0, 0.3, 0.6];

function buildJudgePrompt(output: string, rubric: string[], description: string): string {
  return `You are evaluating whether an AI system's output satisfies a binary rubric.

CONTEXT (what the system was supposed to do):
${description}

SYSTEM OUTPUT TO JUDGE:
<output>
${output.slice(0, 8000)}
</output>

RUBRIC — answer YES or NO for each item. Be strict but fair. If the criterion is partially met, answer NO.

${rubric.map((item, i) => `[r${i}] ${item}`).join("\n")}

Respond ONLY with a JSON object of this shape:
{
  "rationale": "1-2 sentences summarizing the judgment",
  "verdicts": {
    ${rubric.map((_, i) => `"r${i}": true | false`).join(",\n    ")}
  }
}`;
}

export async function judgeOutput(
  output: string,
  rubric: string[],
  description: string,
): Promise<JudgeVerdict[]> {
  const apiKey = getApiKey("anthropic");
  if (!apiKey) {
    // Fail-open on missing key — return a structured "unavailable" verdict
    // for each judge so the runner can flag the fixture as skipped-incomplete.
    return JUDGE_TEMPS.map((_, i) => ({
      judgeIndex: i,
      verdicts: {},
      rationale: "judge_unavailable: no Anthropic API key",
    }));
  }

  const anthropic = new Anthropic({ apiKey });
  const results = await Promise.all(JUDGE_TEMPS.map(async (temperature, i) => {
    try {
      const resp = await Promise.race([
        anthropic.messages.create({
          model: JUDGE_MODEL,
          max_tokens: 600,
          temperature,
          system: "You are a strict, fair, concise evaluator. You answer only in the requested JSON format.",
          messages: [{ role: "user", content: buildJudgePrompt(output, rubric, description) }],
        }),
        timeout(JUDGE_TIMEOUT_MS),
      ]);
      const textBlock = (resp.content as any[]).find(b => b.type === "text");
      const raw: string = textBlock?.text ?? "";
      return parseJudgeResponse(raw, rubric, i);
    } catch (err: any) {
      return {
        judgeIndex: i,
        verdicts: {},
        rationale: `judge_error: ${err?.message?.slice(0, 120)}`,
      };
    }
  }));
  return results;
}

function parseJudgeResponse(raw: string, rubric: string[], idx: number): JudgeVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { judgeIndex: idx, verdicts: {}, rationale: "unparseable" };
  try {
    const parsed = JSON.parse(match[0]);
    const verdicts: Record<string, boolean> = {};
    for (let i = 0; i < rubric.length; i++) {
      const v = parsed.verdicts?.[`r${i}`];
      if (typeof v === "boolean") verdicts[`r${i}`] = v;
    }
    return {
      judgeIndex: idx,
      verdicts,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
    };
  } catch {
    return { judgeIndex: idx, verdicts: {}, rationale: "parse_failed" };
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`judge timeout ${ms}ms`)), ms));
}

// ── Ensemble aggregation + Cohen's κ ────────────────────────────────────

export interface AggregateResult {
  majorityVerdicts: Record<string, boolean>;
  passRatio: number;          // fraction of rubric items passing majority
  kappa: number;              // pairwise average Cohen's κ; NaN if <2 judges
  judgesAvailable: number;
}

/** Aggregate a set of judge verdicts into a single pass/fail + agreement. */
export function aggregateJudges(verdicts: JudgeVerdict[], rubric: string[]): AggregateResult {
  const available = verdicts.filter(v => Object.keys(v.verdicts).length > 0);
  if (available.length === 0) {
    return { majorityVerdicts: {}, passRatio: 0, kappa: NaN, judgesAvailable: 0 };
  }

  const majority: Record<string, boolean> = {};
  for (let i = 0; i < rubric.length; i++) {
    const key = `r${i}`;
    let yes = 0, no = 0;
    for (const v of available) {
      if (v.verdicts[key] === true) yes++;
      else if (v.verdicts[key] === false) no++;
    }
    // Tie → no. Strict-mode: missing verdicts don't count as yes.
    majority[key] = yes > no;
  }
  const passRatio = Object.values(majority).filter(Boolean).length / rubric.length;

  // Pairwise Cohen's κ averaged across all judge pairs
  const kappas: number[] = [];
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const k = cohensKappa(available[i].verdicts, available[j].verdicts, rubric);
      if (!Number.isNaN(k)) kappas.push(k);
    }
  }
  const kappa = kappas.length > 0
    ? kappas.reduce((s, x) => s + x, 0) / kappas.length
    : NaN;

  return { majorityVerdicts: majority, passRatio, kappa, judgesAvailable: available.length };
}

/** Binary Cohen's κ — rater agreement corrected for chance. */
function cohensKappa(a: Record<string, boolean>, b: Record<string, boolean>, rubric: string[]): number {
  const items = rubric.map((_, i) => `r${i}`).filter(k => k in a && k in b);
  if (items.length === 0) return NaN;
  let both_yes = 0, both_no = 0, disagree = 0;
  let a_yes = 0, b_yes = 0;
  for (const k of items) {
    if (a[k] && b[k]) both_yes++;
    else if (!a[k] && !b[k]) both_no++;
    else disagree++;
    if (a[k]) a_yes++;
    if (b[k]) b_yes++;
  }
  const n = items.length;
  const po = (both_yes + both_no) / n;
  const pe = (a_yes / n) * (b_yes / n) + (1 - a_yes / n) * (1 - b_yes / n);
  if (pe === 1) return 1;  // both always yes or always no
  return (po - pe) / (1 - pe);
}
