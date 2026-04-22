/**
 * Profile Inference Agent — one LLM pass consolidates all raw scan data into
 * a structured InferredProfile. Every downstream cognitive agent reads this
 * profile instead of re-parsing raw inputs, saving 5-7x LLM cost across the
 * Oracle Council, Twin Agent, Self-Portrait, and Custom Agents.
 *
 * Input (all from deep-scan.ts MacProfile):
 *   • Localization fingerprint (OS-level cultural signals)
 *   • App Registry region affinity + top signals
 *   • App Pair Signatures (already-curated combos like "ai-tooling-researcher")
 *   • Calendar summary (rhythm, collaborators, ritual patterns)
 *   • iMessage relationship summary (who actually matters)
 *   • Desktop files + Git projects + brew tech stack
 *
 * Output: InferredProfile JSON — a "character sheet" for this user.
 *   This becomes the CANONICAL user model. Versioned in DB so we can track
 *   how the user evolves over time ("relative to last month, your focus
 *   shifted from X to Y").
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { text } from "../infra/compute/index.js";
import {
  deepScanMac, profileToText,
  type MacProfile,
} from "../integrations/local/deep-scan.js";

// ── Schema migration ──────────────────────────────────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inferred_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      data_json TEXT NOT NULL,
      source_hash TEXT,
      input_token_count INTEGER,
      output_token_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_profiles_user_created ON inferred_profiles(user_id, created_at DESC)"); } catch {}

// ── Types ─────────────────────────────────────────────────────────────────

export interface InferredProfile {
  identity: {
    primary_role: string;                      // e.g. "AI systems builder, currently solo"
    secondary_roles: string[];                 // e.g. ["DJ hobbyist", "finance self-learner"]
    cohort_tags: string[];                     // e.g. ["2024-ai-native", "cn-us-bridge"]
    confidence: number;                        // 0-1
  };
  cultural_context: {
    primary_region: string;                    // e.g. "US-based Chinese heritage"
    languages: string[];
    fluency: "monocultural" | "bicultural" | "expat" | "cross-border";
    nuance: string;                            // one-line reframe
  };
  work_style: {
    schedule_type: "morning" | "mid-day" | "evening" | "late-night" | "always-on" | "unclear";
    meeting_density: "heavy" | "regular" | "minimal" | "async" | "unknown";
    peak_day?: string;
    peak_hour?: number;
    focus_pattern: string;                     // one-line narrative
  };
  key_relationships: Array<{
    identifier: string;                        // name or handle
    role_hypothesis: string;                   // e.g. "likely cofounder"
    relationship_strength: number;             // 0-100
    evidence: string;                          // why
  }>;
  active_interests: Array<{
    area: string;
    phase: "active-executing" | "learning" | "exploring" | "fading" | "dormant";
    evidence: string;
  }>;
  tensions: Array<{
    description: string;
    evidence: string;
  }>;
  unknowns: string[];                          // questions for the user to resolve
  openings_for_oracles: {
    historian: string[];                       // what the historian should focus on
    cartographer: string[];
    purpose: string[];
    shadow: string[];
    tempo: string[];
  };
}

// ── Prompt construction ──────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are the Profile Inference Agent for Anchor — a personal AI system.

Your job: read the user's Mac scan data below and produce ONE structured JSON
profile that downstream cognitive agents will consume. This is the canonical
model of who the user is.

CRITICAL RULES:
- Work ONLY from evidence in the scan. Never invent facts.
- If evidence is thin, say so via "confidence" values and "unknowns".
- Prefer specific observations over generic descriptors (e.g. "late-night
  deep worker peaking at 10pm" beats "night owl").
- Each "tensions" item must point to ACTUAL contradictions between
  different scan sources (e.g. "Chinese cultural apps + en-US OS +
  American timezone = heritage Chinese abroad tension").
- "openings_for_oracles" should GUIDE the 5 oracles to their sharpest
  entry points, not repeat obvious things.

Output format: a JSON object matching this TypeScript type. Only emit JSON —
no preamble, no markdown fences.

type InferredProfile = {
  identity: { primary_role: string; secondary_roles: string[]; cohort_tags: string[]; confidence: number; };
  cultural_context: { primary_region: string; languages: string[]; fluency: "monocultural"|"bicultural"|"expat"|"cross-border"; nuance: string; };
  work_style: { schedule_type: "morning"|"mid-day"|"evening"|"late-night"|"always-on"|"unclear"; meeting_density: "heavy"|"regular"|"minimal"|"async"|"unknown"; peak_day?: string; peak_hour?: number; focus_pattern: string; };
  key_relationships: Array<{ identifier: string; role_hypothesis: string; relationship_strength: number; evidence: string; }>;
  active_interests: Array<{ area: string; phase: "active-executing"|"learning"|"exploring"|"fading"|"dormant"; evidence: string; }>;
  tensions: Array<{ description: string; evidence: string; }>;
  unknowns: string[];
  openings_for_oracles: { historian: string[]; cartographer: string[]; purpose: string[]; shadow: string[]; tempo: string[]; };
};`;
}

// ── Main ─────────────────────────────────────────────────────────────────

/** Load recent confirmed/rejected/partial answers so LLM doesn't repeat mistakes. */
function loadUserFeedback(): string {
  try {
    const rows = db.prepare(
      `SELECT source, question, answer, note FROM portrait_answers
       WHERE user_id=? ORDER BY created_at DESC LIMIT 30`
    ).all(DEFAULT_USER_ID) as any[];
    if (rows.length === 0) return "";
    const lines = rows.map((r: any) => {
      const marker = r.answer === "yes" ? "✓ CONFIRMED" : r.answer === "no" ? "✗ REJECTED" : "~ PARTIAL";
      return `[${marker}] (${r.source}) ${r.question}${r.note ? ` — user note: ${r.note}` : ""}`;
    });
    return "\n\nUSER FEEDBACK FROM PRIOR PORTRAIT (authoritative — do NOT contradict confirmed/rejected facts):\n" + lines.join("\n");
  } catch { return ""; }
}

export async function inferProfile(opts?: {
  macProfile?: MacProfile;
  persist?: boolean;   // default true
}): Promise<InferredProfile> {
  const profile = opts?.macProfile ?? deepScanMac();
  const profileText = profileToText(profile);
  const feedback = loadUserFeedback();

  const userMessage =
    "Here is the scan data. Produce the InferredProfile JSON:\n\n" +
    profileText + feedback;

  const raw = await text({
    task: "decision",  // prefer a stronger model for structured output
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4000,
    agentName: "Profile Inference",
  });

  const stripped = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();

  // Extract the FIRST balanced JSON object — more robust than regex
  const jsonText = extractFirstJsonObject(stripped);
  if (!jsonText) {
    throw new Error("Profile Inference LLM returned no JSON. First 300 chars: " + raw.slice(0, 300));
  }

  let parsed: InferredProfile;
  try {
    parsed = JSON.parse(jsonText) as InferredProfile;
  } catch (err: any) {
    // One repair attempt: truncate at last known-good closing brace
    const repaired = repairTruncatedJson(jsonText);
    if (repaired) {
      try { parsed = JSON.parse(repaired) as InferredProfile; }
      catch { throw new Error("Profile Inference JSON parse failed (repair failed too): " + err.message); }
    } else {
      throw new Error("Profile Inference JSON parse failed: " + err.message);
    }
  }

  // Light shape validation — fill reasonable defaults for missing keys
  parsed.identity ??= { primary_role: "unclear", secondary_roles: [], cohort_tags: [], confidence: 0.3 };
  parsed.cultural_context ??= { primary_region: "unclear", languages: [], fluency: "monocultural", nuance: "" };
  parsed.work_style ??= { schedule_type: "unclear", meeting_density: "unknown", focus_pattern: "" };
  parsed.key_relationships ??= [];
  parsed.active_interests ??= [];
  parsed.tensions ??= [];
  parsed.unknowns ??= [];
  parsed.openings_for_oracles ??= { historian: [], cartographer: [], purpose: [], shadow: [], tempo: [] };

  if (opts?.persist !== false) {
    persistProfile(parsed, profileText);
  }

  return parsed;
}

// ── Persistence ──────────────────────────────────────────────────────────

function persistProfile(profile: InferredProfile, sourceText: string): string {
  const id = nanoid();
  const latest = db.prepare(
    "SELECT version FROM inferred_profiles WHERE user_id=? ORDER BY version DESC LIMIT 1"
  ).get(DEFAULT_USER_ID) as any;
  const nextVersion = (latest?.version ?? 0) + 1;
  db.prepare(
    `INSERT INTO inferred_profiles (id, user_id, version, data_json, source_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, DEFAULT_USER_ID, nextVersion, JSON.stringify(profile), hashString(sourceText));
  console.log(`[ProfileInference] Persisted profile v${nextVersion} (id=${id.slice(0, 8)})`);
  return id;
}

export function getLatestProfile(userId = DEFAULT_USER_ID): InferredProfile | null {
  const row = db.prepare(
    "SELECT data_json FROM inferred_profiles WHERE user_id=? ORDER BY version DESC LIMIT 1"
  ).get(userId) as any;
  if (!row) return null;
  try { return JSON.parse(row.data_json) as InferredProfile; } catch { return null; }
}

export function listProfileVersions(userId = DEFAULT_USER_ID): Array<{ id: string; version: number; created_at: string }> {
  return db.prepare(
    "SELECT id, version, created_at FROM inferred_profiles WHERE user_id=? ORDER BY version DESC"
  ).all(userId) as any[];
}

/** Find the first balanced JSON object by scanning braces (ignores strings). */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = false; continue; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unbalanced / truncated
}

/**
 * Attempt to salvage truncated JSON by trimming back to last valid state
 * and closing open arrays/objects. Best-effort, fires only on parse error.
 */
function repairTruncatedJson(s: string): string | null {
  // Walk backward to find last balanced close position — too brittle to do
  // generically; instead try progressively stricter truncations
  for (let cut = s.length; cut > 100; cut -= 100) {
    const lastClose = s.lastIndexOf("}", cut);
    if (lastClose < 0) return null;
    const candidate = s.slice(0, lastClose + 1);
    try { JSON.parse(candidate); return candidate; } catch {}
  }
  return null;
}

function hashString(s: string): string {
  // Simple 32-bit hash — not cryptographic, just for change detection
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

// ── Rendering for diagnostics ────────────────────────────────────────────

export function profileToReadable(profile: InferredProfile): string {
  const lines: string[] = [];
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("  INFERRED USER PROFILE");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  lines.push(`\n◆ IDENTITY (confidence ${(profile.identity.confidence * 100).toFixed(0)}%)`);
  lines.push(`  Primary: ${profile.identity.primary_role}`);
  if (profile.identity.secondary_roles.length > 0) lines.push(`  Secondary: ${profile.identity.secondary_roles.join(" · ")}`);
  if (profile.identity.cohort_tags.length > 0) lines.push(`  Cohort: ${profile.identity.cohort_tags.join(" · ")}`);

  lines.push(`\n◆ CULTURAL CONTEXT (${profile.cultural_context.fluency})`);
  lines.push(`  Region: ${profile.cultural_context.primary_region}`);
  lines.push(`  Languages: ${profile.cultural_context.languages.join(", ")}`);
  if (profile.cultural_context.nuance) lines.push(`  Nuance: ${profile.cultural_context.nuance}`);

  lines.push(`\n◆ WORK STYLE`);
  lines.push(`  Schedule: ${profile.work_style.schedule_type} · Meetings: ${profile.work_style.meeting_density}`);
  if (profile.work_style.peak_day && profile.work_style.peak_hour !== undefined) {
    lines.push(`  Peak: ${profile.work_style.peak_day} ~${profile.work_style.peak_hour}:00`);
  }
  if (profile.work_style.focus_pattern) lines.push(`  ${profile.work_style.focus_pattern}`);

  if (profile.key_relationships.length > 0) {
    lines.push(`\n◆ KEY RELATIONSHIPS`);
    for (const r of profile.key_relationships.slice(0, 8)) {
      lines.push(`  [${String(r.relationship_strength).padStart(3)}] ${r.identifier} — ${r.role_hypothesis}`);
      lines.push(`        ${r.evidence}`);
    }
  }

  if (profile.active_interests.length > 0) {
    lines.push(`\n◆ ACTIVE INTERESTS`);
    for (const i of profile.active_interests) {
      lines.push(`  [${i.phase}] ${i.area}`);
      lines.push(`        ${i.evidence}`);
    }
  }

  if (profile.tensions.length > 0) {
    lines.push(`\n◆ TENSIONS / CONTRADICTIONS`);
    for (const t of profile.tensions) {
      lines.push(`  ! ${t.description}`);
      lines.push(`    evidence: ${t.evidence}`);
    }
  }

  if (profile.unknowns.length > 0) {
    lines.push(`\n◆ UNKNOWNS (questions to resolve)`);
    for (const q of profile.unknowns) lines.push(`  ? ${q}`);
  }

  if (profile.openings_for_oracles) {
    lines.push(`\n◆ ORACLE OPENINGS`);
    for (const [role, openings] of Object.entries(profile.openings_for_oracles)) {
      if (openings.length > 0) {
        lines.push(`  ${role}:`);
        for (const o of openings) lines.push(`    → ${o}`);
      }
    }
  }
  return lines.join("\n");
}
