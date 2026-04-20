/**
 * L3 Cognition — Personal Evolution Engine.
 *
 * Observes user behavior and adapts Decision Agent parameters automatically.
 * The user does nothing — the system just gets smarter over time.
 *
 * 5-step loop (runs daily at 4am, after Dream Engine):
 *   1. Capture — collect 24h of satisfaction signals + twin insights + skill usage
 *   2. Deviation — compare what Decision Agent suggested vs what user actually did
 *   3. Pattern — identify stable trends (5+ days consistent = stable)
 *   4. TwinUpdate — update evolution_state dimensions
 *   5. PredictionAdjust — generate prompt adaptation parameters
 *
 * Dimensions tracked:
 *   - decision_style: cautious | balanced | aggressive
 *   - plan_complexity: simple | moderate | detailed
 *   - communication_tone: direct | supportive | analytical
 *   - domain_weights: JSON of relative domain importance
 *   - time_preference: JSON of active hours / preferred task timing
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { getConfig } from "./diagnostic.js";

// ── Dimension read/write ───────────────────────────────────────────────────

export function getEvolutionState(): Record<string, string> {
  const rows = db.prepare(
    "SELECT dimension, current_value FROM evolution_state WHERE user_id=?"
  ).all(DEFAULT_USER_ID) as any[];

  const state: Record<string, string> = {};
  for (const r of rows) state[r.dimension] = r.current_value;
  return state;
}

function setDimension(dimension: string, value: string): void {
  const existing = db.prepare(
    "SELECT current_value FROM evolution_state WHERE user_id=? AND dimension=?"
  ).get(DEFAULT_USER_ID, dimension) as any;

  if (existing) {
    if (existing.current_value === value) return; // no change
    db.prepare(
      "UPDATE evolution_state SET previous_value=current_value, current_value=?, evidence_count=evidence_count+1, last_updated=datetime('now') WHERE user_id=? AND dimension=?"
    ).run(value, DEFAULT_USER_ID, dimension);
  } else {
    db.prepare(
      "INSERT INTO evolution_state (id, user_id, dimension, current_value, previous_value, evidence_count) VALUES (?,?,?,?,?,?)"
    ).run(nanoid(), DEFAULT_USER_ID, dimension, value, "", 1);
  }
}

// ── Step 1: Capture ────────────────────────────────────────────────────────

interface CapturedSignals {
  satisfactionSignals: { signal_type: string; value: number }[];
  twinInsights: { category: string; insight: string; confidence: number }[];
  skillUsage: { name: string; use_count: number }[];
  recentMessages: { role: string; content: string }[];
  confirmCount: number;
  rejectCount: number;
  avgEditRatio: number;
}

function capture(): CapturedSignals {
  const signals = db.prepare(
    "SELECT signal_type, value FROM satisfaction_signals WHERE user_id=? AND created_at >= datetime('now', '-24 hours')"
  ).all(DEFAULT_USER_ID) as any[];

  const insights = db.prepare(
    "SELECT category, insight, confidence FROM twin_insights WHERE user_id=? AND created_at >= datetime('now', '-24 hours')"
  ).all(DEFAULT_USER_ID) as any[];

  const skills = db.prepare(
    "SELECT name, use_count FROM skills WHERE user_id=? AND last_used >= datetime('now', '-24 hours')"
  ).all(DEFAULT_USER_ID) as any[];

  const messages = db.prepare(
    "SELECT role, content FROM messages WHERE user_id=? AND mode='personal' AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 20"
  ).all(DEFAULT_USER_ID) as any[];

  const confirms = signals.filter((s: any) => s.signal_type === "plan_confirmed").length;
  const rejects = signals.filter((s: any) => s.signal_type === "plan_rejected").length;
  const modifications = signals.filter((s: any) => s.signal_type === "plan_modified");
  const avgEditRatio = modifications.length > 0
    ? modifications.reduce((sum: number, m: any) => sum + (1 - m.value), 0) / modifications.length
    : 0;

  return {
    satisfactionSignals: signals,
    twinInsights: insights,
    skillUsage: skills,
    recentMessages: messages.reverse(),
    confirmCount: confirms,
    rejectCount: rejects,
    avgEditRatio,
  };
}

// ── Step 2: Deviation ──────────────────────────────────────────────────────

function analyzeDeviation(signals: CapturedSignals): {
  decisionDeviation: string;
  complexityDeviation: string;
  toneDeviation: string;
} {
  const total = signals.confirmCount + signals.rejectCount;

  // Decision style deviation
  let decisionDeviation = "none";
  if (total >= 3) {
    const rejectRate = signals.rejectCount / total;
    if (rejectRate > 0.5) decisionDeviation = "too_aggressive"; // system suggests too much, user rejects
    else if (rejectRate < 0.1 && signals.avgEditRatio < 0.1) decisionDeviation = "well_calibrated";
    else if (signals.avgEditRatio > 0.4) decisionDeviation = "needs_adjustment"; // user changes a lot
  }

  // Complexity deviation
  let complexityDeviation = "none";
  if (signals.avgEditRatio > 0.3) {
    // Check if users tend to simplify (remove steps) or add steps
    const simplifiedCount = signals.satisfactionSignals
      .filter(s => s.signal_type === "plan_modified" && s.value > 0.7).length;
    const expandedCount = signals.satisfactionSignals
      .filter(s => s.signal_type === "plan_modified" && s.value < 0.5).length;
    if (simplifiedCount > expandedCount) complexityDeviation = "too_complex";
    else if (expandedCount > simplifiedCount) complexityDeviation = "too_simple";
  }

  // Tone deviation (from message length patterns)
  const userMsgs = signals.recentMessages.filter(m => m.role === "user");
  const avgMsgLen = userMsgs.length > 0
    ? userMsgs.reduce((sum, m) => sum + m.content.length, 0) / userMsgs.length
    : 0;
  let toneDeviation = "none";
  if (avgMsgLen < 50) toneDeviation = "user_is_terse"; // user sends short msgs → system should be direct
  else if (avgMsgLen > 200) toneDeviation = "user_is_detailed"; // user sends long msgs → system can be analytical

  return { decisionDeviation, complexityDeviation, toneDeviation };
}

// ── Step 3: Pattern Detection ──────────────────────────────────────────────

function detectStablePatterns(): {
  stableDecisionStyle: string | null;
  stableComplexity: string | null;
  stableTone: string | null;
  domainWeights: Record<string, number>;
} {
  // Check last 7 days of evolution state changes
  const recentStates = db.prepare(
    "SELECT dimension, current_value, evidence_count FROM evolution_state WHERE user_id=? AND evidence_count >= 5"
  ).all(DEFAULT_USER_ID) as any[];

  let stableDecisionStyle: string | null = null;
  let stableComplexity: string | null = null;
  let stableTone: string | null = null;

  for (const s of recentStates) {
    if (s.dimension === "decision_style" && s.evidence_count >= 5) stableDecisionStyle = s.current_value;
    if (s.dimension === "plan_complexity" && s.evidence_count >= 5) stableComplexity = s.current_value;
    if (s.dimension === "communication_tone" && s.evidence_count >= 5) stableTone = s.current_value;
  }

  // Domain weights from graph activity
  const domainActivity = db.prepare(
    "SELECT domain, COUNT(*) as cnt FROM graph_nodes WHERE user_id=? AND updated_at >= datetime('now', '-7 days') GROUP BY domain ORDER BY cnt DESC"
  ).all(DEFAULT_USER_ID) as any[];

  const domainWeights: Record<string, number> = {};
  const totalActivity = domainActivity.reduce((sum: number, d: any) => sum + d.cnt, 0) || 1;
  for (const d of domainActivity) {
    domainWeights[d.domain] = Math.round((d.cnt / totalActivity) * 100) / 100;
  }

  return { stableDecisionStyle, stableComplexity, stableTone, domainWeights };
}

// ── Step 4 & 5: Update + Adjust ────────────────────────────────────────────

function updateAndAdjust(
  signals: CapturedSignals,
  deviations: ReturnType<typeof analyzeDeviation>,
  patterns: ReturnType<typeof detectStablePatterns>
): void {
  // Update decision_style
  if (deviations.decisionDeviation === "too_aggressive") {
    setDimension("decision_style", "cautious");
  } else if (deviations.decisionDeviation === "well_calibrated") {
    // Keep current or move toward balanced
    const current = getEvolutionState()["decision_style"];
    if (!current) setDimension("decision_style", "balanced");
  }

  // Update plan_complexity
  if (deviations.complexityDeviation === "too_complex") {
    setDimension("plan_complexity", "simple");
  } else if (deviations.complexityDeviation === "too_simple") {
    setDimension("plan_complexity", "detailed");
  } else if (signals.avgEditRatio < 0.1 && signals.confirmCount >= 3) {
    setDimension("plan_complexity", "moderate"); // sweet spot
  }

  // Update communication_tone
  if (deviations.toneDeviation === "user_is_terse") {
    setDimension("communication_tone", "direct");
  } else if (deviations.toneDeviation === "user_is_detailed") {
    setDimension("communication_tone", "analytical");
  }

  // Update domain_weights
  if (Object.keys(patterns.domainWeights).length > 0) {
    setDimension("domain_weights", JSON.stringify(patterns.domainWeights));
  }

  // Update time_preference from message timestamps
  const hourCounts: Record<number, number> = {};
  const recentExecs = db.prepare(
    "SELECT created_at FROM messages WHERE user_id=? AND role='user' AND created_at >= datetime('now', '-7 days')"
  ).all(DEFAULT_USER_ID) as any[];

  for (const e of recentExecs) {
    try {
      const hour = new Date(e.created_at).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    } catch (e) { console.error("[Evolution] Failed to parse date:", e); }
  }

  if (Object.keys(hourCounts).length >= 3) {
    const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    setDimension("time_preference", JSON.stringify({
      peak_hour: parseInt(peakHour ?? "10"),
      active_hours: Object.keys(hourCounts).map(Number).sort((a, b) => a - b),
    }));
  }

  // Update writing_style
  const writingStyle = analyzeWritingStyle();
  if (writingStyle) {
    setDimension("writing_style", writingStyle);
  }
}

// ── Prompt Adaptation — read by Decision Agent ─────────────────────────────

/**
 * Generate prompt modifications based on current evolution state.
 * Called by Decision Agent's buildSystemPrompt().
 */
export function getPromptAdaptations(): string {
  const state = getEvolutionState();
  const adaptations: string[] = [];

  // Decision style
  const style = state["decision_style"];
  if (style === "cautious") {
    adaptations.push("ADAPTATION: This user prefers cautious recommendations. Default risk_level to 'high' for anything involving external communication, money, or irreversible actions. Add explicit disclaimers.");
  } else if (style === "aggressive") {
    adaptations.push("ADAPTATION: This user prefers decisive action. Be direct, minimize hedging. Only flag genuinely high-risk items.");
  }

  // Plan complexity
  const complexity = state["plan_complexity"];
  if (complexity === "simple") {
    adaptations.push("ADAPTATION: Keep plans to 3 steps or fewer. This user prefers concise, actionable plans over detailed breakdowns.");
  } else if (complexity === "detailed") {
    adaptations.push("ADAPTATION: Provide detailed plans with 5-7 steps. Include time estimates and sub-steps where helpful.");
  }

  // Communication tone
  const tone = state["communication_tone"];
  if (tone === "direct") {
    adaptations.push("ADAPTATION: Be extremely concise. No hedging, no filler. Short sentences. Get to the point.");
  } else if (tone === "analytical") {
    adaptations.push("ADAPTATION: Include reasoning and analysis. This user values understanding the 'why' behind recommendations.");
  } else if (tone === "supportive") {
    adaptations.push("ADAPTATION: Be encouraging and empathetic. Acknowledge challenges before suggesting solutions.");
  }

  // Domain weights
  const weights = state["domain_weights"];
  if (weights) {
    try {
      const parsed = JSON.parse(weights);
      const sorted = Object.entries(parsed).sort((a, b) => (b[1] as number) - (a[1] as number));
      if (sorted.length > 0) {
        const topDomains = sorted.slice(0, 3).map(([d]) => d).join(", ");
        adaptations.push(`ADAPTATION: Prioritize ${topDomains} — these are the user's most active domains.`);
      }
    } catch (e) { console.error("[Evolution] Failed to parse domain_weights:", e); }
  }

  // Writing style
  const writingStyle = state["writing_style"];
  if (writingStyle) {
    adaptations.push(`ADAPTATION: When drafting content for this user, match their style: ${writingStyle}. Mirror their voice, not a generic AI tone.`);
  }

  if (adaptations.length === 0) return "";
  return "\n\n" + adaptations.join("\n");
}

// ── Writing Style Analysis ────────────────────────────────────────────────

function analyzeWritingStyle(): string | null {
  const msgs = db.prepare(
    "SELECT content FROM messages WHERE user_id=? AND role='user' AND mode='personal' AND created_at >= datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 20"
  ).all(DEFAULT_USER_ID) as any[];

  if (msgs.length < 5) return null;

  const contents = msgs.map((m: any) => m.content);
  const avgLength = contents.reduce((s: number, c: string) => s + c.length, 0) / contents.length;
  const avgWords = contents.reduce((s: number, c: string) => s + c.split(/\s+/).length, 0) / contents.length;
  const usesEmoji = contents.some((c: string) => c !== c.replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]/g, ""));
  const usesChinese = contents.some((c: string) => /[\u4e00-\u9fff]/.test(c));
  const usesExclamation = contents.filter((c: string) => c.includes("!")).length / contents.length;
  const formal = contents.filter((c: string) => /please|kindly|would you|could you/i.test(c)).length / contents.length;

  const traits: string[] = [];

  // Length
  if (avgWords < 10) traits.push("very terse (avg " + Math.round(avgWords) + " words)");
  else if (avgWords < 30) traits.push("concise");
  else if (avgWords > 60) traits.push("detailed and thorough");
  else traits.push("moderate length");

  // Language
  if (usesChinese) traits.push("mixes Chinese and English");

  // Tone
  if (usesExclamation > 0.3) traits.push("enthusiastic (uses !)");
  else traits.push("calm tone");

  if (formal > 0.3) traits.push("formal");
  else traits.push("casual/direct");

  if (usesEmoji) traits.push("uses emoji occasionally");

  return traits.join(", ");
}

// ── Master Evolution Loop ──────────────────────────────────────────────────

export async function runPersonalEvolution(): Promise<{
  signalsProcessed: number;
  dimensionsUpdated: string[];
}> {
  console.log("[Evolution] Personal evolution loop starting...");

  // Step 1: Capture
  const signals = capture();
  const signalCount = signals.satisfactionSignals.length + signals.twinInsights.length;

  const minSignals = parseInt(getConfig("evolution_min_signals", "2"));
  if (signalCount < minSignals) {
    console.log("[Evolution] Not enough signals to evolve. Skipping.");
    return { signalsProcessed: 0, dimensionsUpdated: [] };
  }

  // Step 2: Deviation analysis
  const deviations = analyzeDeviation(signals);

  // Step 3: Pattern detection
  const patterns = detectStablePatterns();

  // Step 4 & 5: Update + adjust
  const stateBefore = getEvolutionState();
  updateAndAdjust(signals, deviations, patterns);
  const stateAfter = getEvolutionState();

  // Find what changed
  const updated: string[] = [];
  for (const [dim, val] of Object.entries(stateAfter)) {
    if (stateBefore[dim] !== val) updated.push(dim);
  }

  if (updated.length > 0) {
    logExecution("Evolution Engine", `Adapted ${updated.length} dimensions: ${updated.join(", ")}`);
    console.log(`[Evolution] Updated: ${updated.join(", ")}`);
  } else {
    console.log("[Evolution] No changes needed.");
  }

  return { signalsProcessed: signalCount, dimensionsUpdated: updated };
}
