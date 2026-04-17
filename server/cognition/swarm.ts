/**
 * L3 Cognition — Small Swarm Planning.
 *
 * 3-role planning subroutine (from spec: swarm-planning.ts):
 *   1. Structure Planner — decompose into stages, dependencies, sequencing
 *   2. Constraint Critic — identify constraints, conflicts, risks, missing conditions
 *   3. Synthesis Planner — integrate both into single draft plan
 *
 * Activation conditions (ALL must hold):
 *   - Orchestrator authorized a planning burst
 *   - Decision Agent signals single-step insufficient
 *   - Problem is multi-step, high-ambiguity, or multi-constraint
 *   - Output target is draft, not execution
 *
 * Disagreements between planners MUST be visible — suppression is a contract violation.
 */
import { text } from "../infra/compute/index.js";
import { type PlanningPacket, type ContextPacket } from "./packets.js";
import { nanoid } from "nanoid";

// ── Activation check ────────────────────────────────────────────────────────

export function shouldActivateSwarm(context: {
  decisionConfidence: number;
  stepCount: number;
  constraintCount: number;
  isMultiDomain: boolean;
}): boolean {
  // Single-step sufficient → no swarm
  if (context.stepCount <= 2 && context.decisionConfidence > 0.8) return false;
  // Multi-step + low confidence or high constraints → swarm
  if (context.stepCount > 3 && context.decisionConfidence < 0.7) return true;
  if (context.constraintCount >= 3) return true;
  if (context.isMultiDomain) return true;
  return false;
}

// ── Swarm execution ─────────────────────────────────────────────────────────

export async function runSwarm(
  problem: string,
  graphContext: string,
  memoryContext: string,
  twinContext: string,
): Promise<PlanningPacket> {
  console.log("[Swarm] Starting 3-role planning...");

  // ── Role 1: Structure Planner ─────────────────────────────────────
  const structureOutput = await text({
    task: "decision",
    system: `You are the STRUCTURE PLANNER in a 3-role planning swarm.
Your ONLY job: decompose the problem into stages, dependencies, and sequencing.
Do NOT evaluate risks. Do NOT critique. Just structure.

Graph context: ${graphContext.slice(0, 1000)}

Respond with JSON (no markdown):
{
  "stages": ["stage 1 description", "stage 2 description", ...],
  "dependencies": ["stage 2 depends on stage 1 because...", ...],
  "sequencing": "recommended order and why",
  "assumptions": ["assumption 1", ...]
}`,
    messages: [{ role: "user", content: problem }],
    maxTokens: 800,
  });

  console.log("[Swarm] Structure Planner done.");

  // ── Role 2: Constraint Critic ─────────────────────────────────────
  const criticOutput = await text({
    task: "decision",
    system: `You are the CONSTRAINT CRITIC in a 3-role planning swarm.
The Structure Planner produced this plan. Your ONLY job: find problems.
Identify constraints, conflicts, risks, and missing conditions.
Do NOT fix the plan. Just identify what's wrong or risky.

Structure Planner output: ${structureOutput.slice(0, 1000)}

Twin insights: ${twinContext.slice(0, 500)}

Respond with JSON (no markdown):
{
  "constraints": ["constraint 1", ...],
  "conflicts": ["conflict between X and Y", ...],
  "risks": [{ "risk": "description", "severity": "low|medium|high|critical" }],
  "missing_conditions": ["condition that must be true but isn't verified", ...]
}`,
    messages: [{ role: "user", content: problem }],
    maxTokens: 600,
  });

  console.log("[Swarm] Constraint Critic done.");

  // ── Role 3: Synthesis Planner ─────────────────────────────────────
  const synthesisOutput = await text({
    task: "decision",
    system: `You are the SYNTHESIS PLANNER in a 3-role planning swarm.
You received output from Structure Planner and Constraint Critic.
Your job: integrate BOTH into a single actionable draft plan.

CRITICAL: If the Structure and Critic DISAGREE on something, you MUST surface the disagreement — do NOT suppress it. Unresolved conflicts must be visible.

Structure Planner: ${structureOutput.slice(0, 800)}
Constraint Critic: ${criticOutput.slice(0, 800)}
Memory context: ${memoryContext.slice(0, 500)}

Respond with JSON (no markdown):
{
  "recommended_plan": {
    "stages": ["stage 1: action", "stage 2: action", ...],
    "assumptions": ["assumption 1", ...],
    "risks": ["risk 1", ...],
    "recommended": true
  },
  "alternative_plan": {
    "stages": ["alt stage 1", ...],
    "recommended": false,
    "rejection_reasons": ["why not this approach"]
  },
  "unresolved_questions": ["question the user needs to answer", ...],
  "disagreements": [
    { "topic": "what they disagree about", "structure_position": "what structure said", "critic_position": "what critic said", "resolved": false }
  ]
}`,
    messages: [{ role: "user", content: problem }],
    maxTokens: 1000,
  });

  console.log("[Swarm] Synthesis Planner done.");

  // ── Parse and assemble PlanningPacket ─────────────────────────────
  let packet: PlanningPacket;
  try {
    const stripped = synthesisOutput.replace(/```json\s*/g, "").replace(/```/g, "");
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    const plans = [];
    if (parsed.recommended_plan) {
      plans.push({
        planId: nanoid(8),
        stages: parsed.recommended_plan.stages ?? [],
        dependencies: [],
        assumptions: parsed.recommended_plan.assumptions ?? [],
        risks: parsed.recommended_plan.risks ?? [],
        conflicts: [],
        recommended: true,
      });
    }
    if (parsed.alternative_plan) {
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

    // Parse critic risks
    let criticParsed: any = {};
    try {
      const cs = criticOutput.replace(/```json\s*/g, "").replace(/```/g, "");
      criticParsed = JSON.parse(cs.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {}

    packet = {
      candidatePlans: plans,
      riskConflictMap: (criticParsed.risks ?? []).map((r: any) => ({
        riskId: nanoid(6),
        severity: r.severity ?? "medium",
        mitigation: null,
      })),
      unresolvedQuestions: parsed.unresolved_questions ?? [],
      plannerDisagreements: (parsed.disagreements ?? []).map((d: any) => ({
        topic: d.topic ?? "",
        positions: [
          { role: "structure_planner", position: d.structure_position ?? "" },
          { role: "constraint_critic", position: d.critic_position ?? "" },
        ],
        resolved: d.resolved ?? false,
      })),
      boundaryClassification: "draft_candidate",
    };
  } catch {
    packet = {
      candidatePlans: [],
      riskConflictMap: [],
      unresolvedQuestions: ["Swarm synthesis failed — manual planning needed"],
      plannerDisagreements: [],
      boundaryClassification: "advisory_only",
    };
  }

  console.log(`[Swarm] Complete: ${packet.candidatePlans.length} plans, ${packet.plannerDisagreements.length} disagreements, ${packet.unresolvedQuestions.length} questions`);
  return packet;
}
