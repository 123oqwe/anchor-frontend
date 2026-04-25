/**
 * L3 Cognition — Small Swarm Planning (Debate-style, 2026 pattern).
 *
 * 3-role DEBATE (upgraded from serial pipeline):
 *   1. Advocate — argues FOR the best approach, builds the case
 *   2. Critic — attacks the Advocate's plan, finds every weakness
 *   3. Judge — evaluates argument quality (not just merging), makes final ruling
 *
 * Key difference from old Structure→Critic→Synthesis:
 *   Old: Synthesis tries to please both → weak compromises
 *   New: Judge weighs argument VALIDITY → strong decisions
 *
 * Disagreements still MUST be visible — suppression is contract violation.
 * Achieves ~73% improvement over simple merge (MADS 2026).
 */
import { text, object } from "../infra/compute/index.js";
import { type PlanningPacket } from "./packets.js";
import { nanoid } from "nanoid";
import { z } from "zod";

const CriticSchema = z.object({
  weaknesses: z.array(z.string()).default([]),
  risks: z.array(z.object({
    risk: z.string(),
    severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    mitigation: z.string().nullable().default(null),
  })).default([]),
  flawed_assumptions: z.array(z.string()).default([]),
  missing_information: z.array(z.string()).default([]),
  alternative_approach: z.string().default(""),
  overall_assessment: z.enum(["strong", "moderate", "weak"]).default("moderate"),
});

const JudgeSchema = z.object({
  ruling: z.enum(["advocate_wins", "critic_wins", "modified_plan"]).default("modified_plan"),
  reasoning: z.string().default(""),
  final_plan: z.object({
    stages: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    recommended: z.boolean().default(true),
  }).default({ stages: [], assumptions: [], risks: [], recommended: true }),
  alternative_plan: z.object({
    stages: z.array(z.string()).default([]),
    recommended: z.boolean().default(false),
    rejection_reasons: z.array(z.string()).default([]),
  }).default({ stages: [], recommended: false, rejection_reasons: [] }),
  unresolved_questions: z.array(z.string()).default([]),
  debate_summary: z.array(z.object({
    topic: z.string().default(""),
    advocate_said: z.string().default(""),
    critic_said: z.string().default(""),
    judge_ruled: z.string().default(""),
    resolved: z.boolean().default(false),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
});

// ── Activation check ────────────────────────────────────────────────────────

export function shouldActivateSwarm(context: {
  decisionConfidence: number;
  stepCount: number;
  constraintCount: number;
  isMultiDomain: boolean;
}): boolean {
  // Only activate for genuinely complex decisions — be conservative
  // Must have LOW confidence AND high complexity (not just one)
  if (context.decisionConfidence > 0.7) return false;         // confident enough
  if (context.stepCount <= 4) return false;                    // not enough steps to warrant debate
  if (context.constraintCount < 3 && !context.isMultiDomain) return false; // not complex enough
  // All conditions met: low confidence + many steps + many constraints or multi-domain
  return true;
}

// ── Debate execution ────────────────────────────────────────────────────────

export async function runSwarm(
  problem: string,
  graphContext: string,
  memoryContext: string,
  twinContext: string,
): Promise<PlanningPacket> {
  console.log("[Swarm] Starting Advocate→Critic→Judge debate...");

  // ── Role 1: Advocate — build the strongest case for one approach ───
  const advocateOutput = await text({
    task: "decision",
    system: `You are the ADVOCATE in a structured debate about a decision.
Your role: argue FOR the BEST approach to this problem. Build the strongest case.
Be specific. Reference facts. Show why this approach is better than alternatives.
Anticipate objections and pre-emptively address them.

Context:
${graphContext.slice(0, 800)}
${twinContext.slice(0, 400)}

Respond with JSON (no markdown):
{
  "proposed_approach": "one sentence summary",
  "argument": "your full argument for why this is the best path",
  "steps": ["step 1", "step 2", ...],
  "evidence": ["fact/data supporting this approach", ...],
  "pre_emptive_rebuttals": ["anticipated objection → why it doesn't hold", ...],
  "confidence": 0.0-1.0
}`,
    messages: [{ role: "user", content: problem }],
    maxTokens: 800,
  });

  console.log("[Swarm] Advocate done.");

  // ── Role 2: Critic — attack every weakness ────────────────────────
  let criticParsed: z.infer<typeof CriticSchema> = CriticSchema.parse({});
  try {
    criticParsed = await object({
      task: "decision",
      system: `You are the CRITIC in a structured debate. The Advocate proposed an approach.
Your role: find EVERY weakness, risk, blind spot, and flawed assumption.
Be rigorous. Don't be polite. Your job is to stress-test the plan.
Point out what could go wrong, what's missing, what's naive.

Advocate's argument:
${advocateOutput.slice(0, 1000)}

Memory context:
${memoryContext.slice(0, 400)}`,
      messages: [{ role: "user", content: problem }],
      schema: CriticSchema,
      maxTokens: 800,
    });
  } catch (err: any) {
    console.error("[Swarm] Critic structured-output failed:", err.message);
  }
  const criticOutput = JSON.stringify(criticParsed);

  console.log("[Swarm] Critic done.");

  // ── Role 3: Judge — weigh argument quality, make ruling ───────────
  let parsed: z.infer<typeof JudgeSchema> = JudgeSchema.parse({});
  let judgeFailed = false;
  try {
    parsed = await object({
      task: "decision",
      system: `You are the JUDGE in a structured debate. You have heard the Advocate and the Critic.
Your role: make a RULING based on argument quality, not compromise.

RULES:
- Evaluate the STRENGTH of each argument, not just merge them
- If the Critic found a fatal flaw, the Advocate's plan must be rejected or modified
- If the Critic's objections are weak, the Advocate's plan stands
- You MUST surface any unresolved disagreements — do NOT suppress them
- Produce a final actionable plan

Advocate's case:
${advocateOutput.slice(0, 800)}

Critic's rebuttal:
${criticOutput.slice(0, 800)}`,
      messages: [{ role: "user", content: problem }],
      schema: JudgeSchema,
      maxTokens: 1000,
    });
  } catch (err: any) {
    console.error("[Swarm] Judge structured-output failed:", err.message);
    judgeFailed = true;
  }

  console.log("[Swarm] Judge done.");

  // ── Assemble PlanningPacket ───────────────────────────────────────
  let packet: PlanningPacket;
  if (judgeFailed) {
    packet = {
      candidatePlans: [],
      riskConflictMap: [],
      unresolvedQuestions: ["Swarm debate failed — manual planning needed"],
      plannerDisagreements: [],
      boundaryClassification: "advisory_only",
    };
  } else {
    const plans: PlanningPacket["candidatePlans"] = [];
    if (parsed.final_plan.stages.length > 0) {
      plans.push({
        planId: nanoid(8),
        stages: parsed.final_plan.stages,
        dependencies: [],
        assumptions: parsed.final_plan.assumptions,
        risks: parsed.final_plan.risks,
        conflicts: [],
        recommended: true,
      });
    }
    if (parsed.alternative_plan.stages.length > 0) {
      plans.push({
        planId: nanoid(8),
        stages: parsed.alternative_plan.stages,
        dependencies: [],
        assumptions: [],
        risks: [],
        conflicts: [],
        recommended: false,
        rejectionReasons: parsed.alternative_plan.rejection_reasons,
      });
    }

    packet = {
      candidatePlans: plans,
      riskConflictMap: criticParsed.risks.map(r => ({
        riskId: nanoid(6),
        severity: r.severity,
        mitigation: r.mitigation ?? undefined,   // PlanningPacket type uses optional, not nullable
      })),
      unresolvedQuestions: parsed.unresolved_questions,
      plannerDisagreements: parsed.debate_summary.map(d => ({
        topic: d.topic,
        positions: [
          { role: "advocate", position: d.advocate_said },
          { role: "critic", position: d.critic_said },
          { role: "judge", position: d.judge_ruled },
        ],
        resolved: d.resolved,
      })),
      boundaryClassification: "draft_candidate",
    };
  }

  const unresolvedCount = packet.plannerDisagreements.filter(d => !d.resolved).length;
  console.log(`[Swarm] Debate complete: ${packet.candidatePlans.length} plans, ${packet.plannerDisagreements.length} debate points (${unresolvedCount} unresolved), ${packet.unresolvedQuestions.length} questions`);
  return packet;
}
