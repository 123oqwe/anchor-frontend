/**
 * L3 Cognition — Automatic Skills Engine.
 *
 * Skills are NOT user-created templates. They are decision shortcuts that
 * crystallize from repeated behavior patterns. When the Decision Agent
 * encounters a request matching a skill, it can skip the full 5-stage
 * pipeline and use the skill template directly.
 *
 * Lifecycle:
 *   1. User confirms similar plans 3+ times → crystallizeSkill()
 *   2. Next matching request → detectSkillMatch() → fast plan generation
 *   3. User edits skill-based plan → evolveSkill() adjusts steps
 *   4. User rejects skill-based plan repeatedly → retireSkill()
 *
 * Skills also get created offline by Dream Engine (dream.ts).
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { object } from "../infra/compute/index.js";
import type { DecisionResult } from "./decision.js";
import { getConfig } from "./diagnostic.js";
import { z } from "zod";

export interface SkillMatch {
  skillId: string;
  name: string;
  steps: string[];
  confidence: number;
  contextConditions: Record<string, any>;
  triggerPattern: string;
}

// ── Skill Detection ────────────────────────────────────────────────────────

/**
 * Check if a user message matches any learned skill.
 * Uses trigger_pattern keyword matching + context condition filtering.
 */
export function detectSkillMatch(
  message: string,
  userState: { energy: number; focus: number; stress: number }
): SkillMatch | null {
  const skills = db.prepare(
    "SELECT id, name, steps, trigger_pattern, confidence, context_conditions, success_rate FROM skills WHERE user_id=? AND confidence > 0.3 ORDER BY use_count DESC, confidence DESC LIMIT 20"
  ).all(DEFAULT_USER_ID) as any[];

  if (skills.length === 0) return null;

  const msgLower = message.toLowerCase();

  for (const skill of skills) {
    const trigger = (skill.trigger_pattern ?? "").toLowerCase();
    if (!trigger) continue;

    // Split trigger into keywords and check if message contains them
    const keywords = trigger.split(/[,;|]+/).map((k: string) => k.trim()).filter(Boolean);
    if (keywords.length === 0) continue;

    const matchCount = keywords.filter((kw: string) => msgLower.includes(kw)).length;
    const matchRatio = matchCount / keywords.length;

    // Require at least threshold keyword match
    const matchThreshold = parseFloat(getConfig("skill_match_threshold", "0.6"));
    if (matchRatio < matchThreshold) continue;

    // Check context conditions
    let contextConditions: Record<string, any> = {};
    try { contextConditions = JSON.parse(skill.context_conditions || "{}"); } catch (err) { console.error("[Skills] Failed to parse context_conditions for skill:", skill.id); }

    let contextMatch = true;
    if (contextConditions.energy_above && userState.energy < contextConditions.energy_above) contextMatch = false;
    if (contextConditions.stress_below && userState.stress > contextConditions.stress_below) contextMatch = false;
    if (contextConditions.focus_above && userState.focus < contextConditions.focus_above) contextMatch = false;

    if (!contextMatch) continue;

    let steps: string[];
    try { steps = JSON.parse(skill.steps); } catch { continue; }

    const conf = (skill.confidence ?? 0.5) * matchRatio;
    if (conf < 0.5) continue;

    return {
      skillId: skill.id,
      name: skill.name,
      steps,
      confidence: conf,
      contextConditions,
      triggerPattern: skill.trigger_pattern,
    };
  }

  return null;
}

// ── Skill-based Plan Generation ────────────────────────────────────────────

/**
 * Build a DecisionResult from a matched skill, skipping the full LLM pipeline.
 * Uses a cheap model to adapt the skill steps to the specific request.
 */
export async function buildSkillBasedPlan(
  match: SkillMatch,
  userMessage: string
): Promise<DecisionResult> {
  // Update usage stats
  db.prepare("UPDATE skills SET use_count = use_count + 1, last_used = datetime('now') WHERE id=?")
    .run(match.skillId);

  // Use cheap model to adapt steps to this specific request
  try {
    const parsed = await object({
      task: "twin_edit_learning",
      system: `You are adapting a learned skill to a specific request. The skill "${match.name}" has these template steps:
${match.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Adapt these steps to the user's specific request. Keep the same structure but customize details.`,
      messages: [{ role: "user", content: userMessage }],
      schema: z.object({
        steps: z.array(z.string()),
        summary: z.string(),
      }),
      maxTokens: 300,
    });
    const steps = parsed.steps.length > 0 ? parsed.steps : match.steps;
    const summary = parsed.summary || `Using skill: ${match.name}`;

    return {
      raw: JSON.stringify({
        type: "plan",
        suggestion_summary: summary,
        reasoning: `Matched learned skill "${match.name}" (confidence: ${match.confidence.toFixed(2)}). Adapted to your specific request.`,
        why_this_now: "This matches a pattern you've used successfully before.",
        editable_steps: steps.map((s: string, i: number) => ({ id: i + 1, content: s })),
        risk_level: "low",
        boundary_classification: "draft_candidate",
        referenced_nodes: [],
        conflict_flags: [],
        confidence: match.confidence,
        skill_source: match.skillId,
      }),
      isPlan: true,
      packet: {
        type: "plan",
        suggestionSummary: summary,
        reasoning: `Skill: ${match.name}`,
        whyThisNow: "Matches your established pattern",
        candidates: steps.map((s: string, i: number) => ({
          id: i + 1,
          content: s,
          riskSignals: [],
          referencedNodes: [],
        })),
        riskLevel: "low",
        boundaryClassification: "draft_candidate",
        conflictFlags: [],
        confidenceScore: match.confidence,
        stagesTrace: [{ stage: "skill_match", input: match.name, output: `Matched with ${(match.confidence * 100).toFixed(0)}% confidence` }],
      },
      structured: {
        type: "plan",
        suggestion_summary: summary,
        reasoning: `Skill: ${match.name}`,
        editable_steps: steps.map((s: string, i: number) => ({ id: i + 1, content: s })),
        risk_level: "low",
        referenced_nodes: [],
        why_this_now: "Matches your established pattern",
        conflict_flags: [],
        confidence: match.confidence,
      },
    };
  } catch (err) {
    console.error("[Skills] Skill adaptation failed:", err);
    // Fallback: use raw skill steps without adaptation
    return {
      raw: `Using skill "${match.name}": ${match.steps.join(", ")}`,
      isPlan: true,
      packet: null,
      structured: {
        type: "plan",
        suggestion_summary: `Skill: ${match.name}`,
        reasoning: "Matched learned skill",
        editable_steps: match.steps.map((s, i) => ({ id: i + 1, content: s })),
        risk_level: "low",
        referenced_nodes: [],
      },
    };
  }
}

// ── Skill Crystallization ──────────────────────────────────────────────────

/**
 * Check if a pattern of confirmed plans should become a skill.
 * Called after plan confirmation. If 3+ similar plans confirmed with <20% edits,
 * crystallize into a new skill.
 */
export async function tryCrystallizeSkill(
  confirmedSteps: string[],
  editRatio: number
): Promise<string | null> {
  // Only crystallize if user barely edited the plan
  if (editRatio > 0.2) return null;

  // Find recent confirmed plans with similar step counts
  const recentPlans = db.prepare(
    "SELECT content FROM messages WHERE user_id=? AND role='draft' AND draft_status='pending' AND created_at >= datetime('now', '-14 days') ORDER BY created_at DESC LIMIT 15"
  ).all(DEFAULT_USER_ID) as any[];

  const minPlans = parseInt(getConfig("skill_crystallize_min", "3"));
  if (recentPlans.length < minPlans) return null;

  // Extract step patterns from recent plans
  const planSteps: string[][] = [];
  for (const p of recentPlans) {
    try {
      const parsed = JSON.parse(p.content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      if (Array.isArray(parsed.editable_steps)) {
        planSteps.push(parsed.editable_steps.map((s: any) => s.content));
      }
    } catch { continue; }
  }

  if (planSteps.length < 3) return null;

  // Use LLM to detect if there's a repeatable pattern
  try {
    const parsed = await object({
      task: "twin_edit_learning",
      system: `You analyze confirmed plans to detect reusable patterns.
Given these recently confirmed plans, determine if there's a common pattern worth saving as a "skill" (a reusable template).
A skill must: appear in 3+ plans, have clear trigger conditions, have consistent steps.
If no pattern, set "detected" to false and leave other fields empty.`,
      messages: [{
        role: "user",
        content: `Recent confirmed plans:\n${planSteps.map((steps, i) => `Plan ${i + 1}: ${steps.join(" → ")}`).join("\n")}`,
      }],
      schema: z.object({
        detected: z.boolean(),
        name: z.string().default(""),
        steps: z.array(z.string()).default([]),
        trigger: z.string().default(""),
        confidence: z.number().min(0).max(1).default(0.6),
      }),
      maxTokens: 300,
    });

    if (!parsed.detected || !parsed.name || parsed.steps.length === 0) return null;

    // Check if skill already exists
    const existing = db.prepare("SELECT id FROM skills WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, parsed.name);
    if (existing) return null;

    const skillId = nanoid();
    db.prepare(
      "INSERT INTO skills (id, user_id, name, description, steps, trigger_pattern, confidence, source) VALUES (?,?,?,?,?,?,?,?)"
    ).run(skillId, DEFAULT_USER_ID, parsed.name, `Auto-crystallized from ${planSteps.length} confirmed plans`,
      JSON.stringify(parsed.steps), parsed.trigger, parsed.confidence, "behavior_crystallization");

    console.log(`[Skills] Crystallized new skill: "${parsed.name}" (${parsed.steps.length} steps)`);
    return skillId;
  } catch (err) {
    console.error("[Skills] Crystallization failed:", err);
    return null;
  }
}

// ── Skill Evolution ────────────────────────────────────────────────────────

/**
 * When a skill-based plan is confirmed but user edited steps,
 * adjust the skill template to incorporate the edits.
 */
export async function evolveSkill(skillId: string, userSteps: string[]): Promise<void> {
  const skill = db.prepare("SELECT steps, confidence, use_count FROM skills WHERE id=? AND user_id=?")
    .get(skillId, DEFAULT_USER_ID) as any;
  if (!skill) return;

  let currentSteps: string[];
  try { currentSteps = JSON.parse(skill.steps); } catch { return; }

  // Merge: if user's version is different, blend it with the template
  // Weight toward user's version (they know better)
  if (JSON.stringify(currentSteps) === JSON.stringify(userSteps)) return;

  // Use the user's steps as the new template, slightly boosting confidence
  db.prepare("UPDATE skills SET steps=?, confidence=MIN(1.0, confidence + 0.05), updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(userSteps), skillId);

  console.log(`[Skills] Evolved skill ${skillId}: ${currentSteps.length} → ${userSteps.length} steps`);
}

/**
 * When a skill-based plan is rejected, reduce skill confidence.
 * After 3 consecutive rejections, auto-delete.
 */
export function penalizeSkill(skillId: string): void {
  const skill = db.prepare("SELECT confidence FROM skills WHERE id=? AND user_id=?")
    .get(skillId, DEFAULT_USER_ID) as any;
  if (!skill) return;

  const newConf = skill.confidence - 0.2;
  if (newConf < 0.3) {
    db.prepare("DELETE FROM skills WHERE id=? AND user_id=?").run(skillId, DEFAULT_USER_ID);
    console.log(`[Skills] Retired skill ${skillId} (confidence too low)`);
  } else {
    db.prepare("UPDATE skills SET confidence=?, updated_at=datetime('now') WHERE id=?")
      .run(newConf, skillId);
    console.log(`[Skills] Penalized skill ${skillId}: confidence → ${newConf.toFixed(2)}`);
  }
}
