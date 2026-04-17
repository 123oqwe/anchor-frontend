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
import { text } from "../infra/compute/index.js";
import { type PlanningPacket } from "./packets.js";
import { nanoid } from "nanoid";

// ── Activation check ────────────────────────────────────────────────────────

export function shouldActivateSwarm(context: {
  decisionConfidence: number;
  stepCount: number;
  constraintCount: number;
  isMultiDomain: boolean;
}): boolean {
  if (context.stepCount <= 2 && context.decisionConfidence > 0.8) return false;
  if (context.stepCount > 3 && context.decisionConfidence < 0.7) return true;
  if (context.constraintCount >= 3) return true;
  if (context.isMultiDomain) return true;
  return false;
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
  const criticOutput = await text({
    task: "decision",
    system: `You are the CRITIC in a structured debate. The Advocate proposed an approach.
Your role: find EVERY weakness, risk, blind spot, and flawed assumption.
Be rigorous. Don't be polite. Your job is to stress-test the plan.
Point out what could go wrong, what's missing, what's naive.

Advocate's argument:
${advocateOutput.slice(0, 1000)}

Memory context:
${memoryContext.slice(0, 400)}

Respond with JSON (no markdown):
{
  "weaknesses": ["weakness 1", "weakness 2", ...],
  "risks": [{ "risk": "description", "severity": "low|medium|high|critical", "mitigation": "possible fix" }],
  "flawed_assumptions": ["assumption the advocate made that may be wrong", ...],
  "missing_information": ["what we don't know but need to", ...],
  "alternative_approach": "brief description of a better alternative if this plan is fundamentally flawed",
  "overall_assessment": "strong|moderate|weak"
}`,
    messages: [{ role: "user", content: problem }],
    maxTokens: 800,
  });

  console.log("[Swarm] Critic done.");

  // ── Role 3: Judge — weigh argument quality, make ruling ───────────
  const judgeOutput = await text({
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
${criticOutput.slice(0, 800)}

Respond with JSON (no markdown):
{
  "ruling": "advocate_wins|critic_wins|modified_plan",
  "reasoning": "why this ruling based on argument quality",
  "final_plan": {
    "stages": ["step 1", "step 2", ...],
    "assumptions": ["assumption 1", ...],
    "risks": ["remaining risk after debate", ...],
    "recommended": true
  },
  "alternative_plan": {
    "stages": ["alt step 1", ...],
    "recommended": false,
    "rejection_reasons": ["why not"]
  },
  "unresolved_questions": ["things user needs to clarify", ...],
  "debate_summary": [
    { "topic": "key point of contention", "advocate_said": "...", "critic_said": "...", "judge_ruled": "...", "resolved": true|false }
  ],
  "confidence": 0.0-1.0
}`,
    messages: [{ role: "user", content: problem }],
    maxTokens: 1000,
  });

  console.log("[Swarm] Judge done.");

  // ── Parse and assemble PlanningPacket ─────────────────────────────
  let packet: PlanningPacket;
  try {
    const stripped = judgeOutput.replace(/```json\s*/g, "").replace(/```/g, "");
    let jsonStr = stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    // Auto-repair truncated JSON
    if (!jsonStr.trim().endsWith("}")) {
      const openB = (jsonStr.match(/\[/g) || []).length - (jsonStr.match(/\]/g) || []).length;
      const openC = (jsonStr.match(/\{/g) || []).length - (jsonStr.match(/\}/g) || []).length;
      jsonStr += "]".repeat(Math.max(0, openB)) + "}".repeat(Math.max(0, openC));
    }
    let parsed: any;
    try { parsed = JSON.parse(jsonStr); } catch {
      try { parsed = JSON.parse(jsonStr.replace(/,\s*\]/, "]").replace(/,\s*\}/, "}")); } catch { parsed = {}; }
    }

    // Parse critic for risk map
    let criticParsed: any = {};
    try {
      const cs = criticOutput.replace(/```json\s*/g, "").replace(/```/g, "");
      criticParsed = JSON.parse(cs.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {}

    const plans = [];
    if (parsed.final_plan) {
      plans.push({
        planId: nanoid(8),
        stages: parsed.final_plan.stages ?? [],
        dependencies: [],
        assumptions: parsed.final_plan.assumptions ?? [],
        risks: parsed.final_plan.risks ?? [],
        conflicts: [],
        recommended: true,
      });
    }
    if (parsed.alternative_plan?.stages?.length > 0) {
      plans.push({
        planId: nanoid(8),
        stages: parsed.alternative_plan.stages ?? [],
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
      riskConflictMap: (criticParsed.risks ?? []).map((r: any) => ({
        riskId: nanoid(6),
        severity: r.severity ?? "medium",
        mitigation: r.mitigation ?? null,
      })),
      unresolvedQuestions: parsed.unresolved_questions ?? [],
      plannerDisagreements: (parsed.debate_summary ?? []).map((d: any) => ({
        topic: d.topic ?? "",
        positions: [
          { role: "advocate", position: d.advocate_said ?? "" },
          { role: "critic", position: d.critic_said ?? "" },
          { role: "judge", position: d.judge_ruled ?? "" },
        ],
        resolved: d.resolved ?? false,
      })),
      boundaryClassification: "draft_candidate",
    };
  } catch {
    packet = {
      candidatePlans: [],
      riskConflictMap: [],
      unresolvedQuestions: ["Swarm debate failed — manual planning needed"],
      plannerDisagreements: [],
      boundaryClassification: "advisory_only",
    };
  }

  const unresolvedCount = packet.plannerDisagreements.filter(d => !d.resolved).length;
  console.log(`[Swarm] Debate complete: ${packet.candidatePlans.length} plans, ${packet.plannerDisagreements.length} debate points (${unresolvedCount} unresolved), ${packet.unresolvedQuestions.length} questions`);
  return packet;
}
