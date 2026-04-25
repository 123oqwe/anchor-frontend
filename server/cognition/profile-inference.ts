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
import { object } from "../infra/compute/index.js";
import {
  deepScanMacAsync, profileToText,
  type MacProfile,
} from "../integrations/local/deep-scan.js";
import { profileToGraph } from "./profile-to-graph.js";
import { ingestTimelineFromScan } from "../graph/timeline.js";
import { z } from "zod";

const InferredProfileSchema = z.object({
  identity: z.object({
    primary_role: z.string().default("unclear"),
    secondary_roles: z.array(z.string()).default([]),
    cohort_tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.3),
  }).default({ primary_role: "unclear", secondary_roles: [], cohort_tags: [], confidence: 0.3 }),
  cultural_context: z.object({
    primary_region: z.string().default("unclear"),
    languages: z.array(z.string()).default([]),
    fluency: z.enum(["monocultural", "bicultural", "expat", "cross-border"]).default("monocultural"),
    nuance: z.string().default(""),
  }).default({ primary_region: "unclear", languages: [], fluency: "monocultural", nuance: "" }),
  work_style: z.object({
    schedule_type: z.enum(["morning", "mid-day", "evening", "late-night", "always-on", "unclear"]).default("unclear"),
    meeting_density: z.enum(["heavy", "regular", "minimal", "async", "unknown"]).default("unknown"),
    peak_day: z.string().optional(),
    peak_hour: z.number().optional(),
    focus_pattern: z.string().default(""),
  }).default({ schedule_type: "unclear", meeting_density: "unknown", focus_pattern: "" }),
  key_relationships: z.array(z.object({
    identifier: z.string(),
    role_hypothesis: z.string(),
    relationship_strength: z.number().min(0).max(100),
    evidence: z.string(),
  })).default([]),
  active_interests: z.array(z.object({
    area: z.string(),
    phase: z.enum(["active-executing", "learning", "exploring", "fading", "dormant"]),
    evidence: z.string(),
  })).default([]),
  tensions: z.array(z.object({
    description: z.string(),
    evidence: z.string(),
  })).default([]),
  values: z.array(z.object({
    name: z.string(),
    stated_vs_inferred: z.enum(["stated", "inferred"]),
    evidence: z.string(),
    confidence: z.number().min(0).max(1),
  })).default([]),
  unknowns: z.array(z.string()).default([]),
  openings_for_oracles: z.object({
    historian: z.array(z.string()).default([]),
    cartographer: z.array(z.string()).default([]),
    purpose: z.array(z.string()).default([]),
    shadow: z.array(z.string()).default([]),
    tempo: z.array(z.string()).default([]),
  }).default({ historian: [], cartographer: [], purpose: [], shadow: [], tempo: [] }),
});

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

// Single source of truth — InferredProfileSchema (above) defines the runtime
// contract; the type is derived so they can never drift.
export type InferredProfile = z.infer<typeof InferredProfileSchema>;

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

PRESERVE THESE UNIFIED-SCAN SIGNALS — these 7 layers are the most
identity-revealing parts of the scan. Do NOT collapse them into generic
phrases. When you see them, write the RAW NUMBER or IDENTIFIER into an
"evidence" or "nuance" field so downstream Oracles can cite it:

  messagesUnified    → top contact handles, chat-app split (WeChat vs
                       iMessage vs Telegram) → key_relationships +
                       cultural_context.nuance
  notesUnified       → Obsidian vault names, scattered markdown count,
                       recent topics → active_interests.evidence
  tasksUnified       → Things/Reminders active count, task-stasis or
                       task-manager absence → tensions OR work_style
  emailUnified       → top sender/recipient patterns, subscription
                       themes → key_relationships + active_interests
  codeUnified        → author-filtered commit count, peak hour/day
                       (git timestamps), primary repo, top commit
                       themes → work_style.peak_hour + peak_day +
                       active_interests.evidence
  mediaUnified       → Rekordbox track count (DJ), Apple Music vs
                       NetEase split → secondary_roles +
                       cultural_context.nuance
  locationUnified    → cafe WiFi count, calendar location diversity
                       → work_style + cohort_tags

If the scan names a specific artifact (repo name, playlist size,
contact handle, vault name), the InferredProfile MUST carry that
specific name forward — Oracles cannot cite what you don't preserve.

Output format: a JSON object matching this TypeScript type. Only emit JSON —
no preamble, no markdown fences.

type InferredProfile = {
  identity: { primary_role: string; secondary_roles: string[]; cohort_tags: string[]; confidence: number; };
  cultural_context: { primary_region: string; languages: string[]; fluency: "monocultural"|"bicultural"|"expat"|"cross-border"; nuance: string; };
  work_style: { schedule_type: "morning"|"mid-day"|"evening"|"late-night"|"always-on"|"unclear"; meeting_density: "heavy"|"regular"|"minimal"|"async"|"unknown"; peak_day?: string; peak_hour?: number; focus_pattern: string; };
  key_relationships: Array<{ identifier: string; role_hypothesis: string; relationship_strength: number; evidence: string; }>;
  active_interests: Array<{ area: string; phase: "active-executing"|"learning"|"exploring"|"fading"|"dormant"; evidence: string; }>;
  tensions: Array<{ description: string; evidence: string; }>;
  values: Array<{ name: string; stated_vs_inferred: "stated"|"inferred"; evidence: string; confidence: number; }>;
  unknowns: string[];
  openings_for_oracles: { historian: string[]; cartographer: string[]; purpose: string[]; shadow: string[]; tempo: string[]; };
};

VALUES extraction — populate the "values" array with 3-8 entries. Values are
what the user cares about deeply that shapes their choices. Examples:
"craft over speed", "asynchronous work", "Chinese-American bridging",
"local-first / privacy", "tight feedback loops", "solo deep work".
- A value is STATED when the user's own text (notes, PRDs, commit
  messages) explicitly argues for it. Otherwise INFERRED (from tool
  choice, time allocation, absences, tensions).
- Confidence should be lower (0.4-0.6) for purely-inferred values and
  higher (0.7-0.9) for values with direct textual evidence.
- Values must be short noun phrases (1-4 words ideally), not sentences.`;
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
  writeGraph?: boolean; // default true when persist is true
}): Promise<InferredProfile> {
  // deepScanMacAsync (not sync deepScanMac) so all 7 unified layers are
  // populated before the LLM consumes profileToText. The API-triggered
  // Portrait path relied on the sync version previously and silently
  // missed messagesUnified / notesUnified / tasksUnified / etc.
  const profile = opts?.macProfile ?? await deepScanMacAsync();
  const profileText = profileToText(profile);
  const feedback = loadUserFeedback();

  const userMessage =
    "Here is the scan data. Produce the InferredProfile JSON:\n\n" +
    profileText + feedback;

  const parsed = await object({
    task: "decision",  // prefer a stronger model for structured output
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: userMessage }],
    schema: InferredProfileSchema,
    maxTokens: 8000,
    agentName: "Profile Inference",
  }) as InferredProfile;

  if (opts?.persist !== false) {
    persistProfile(parsed, profileText);
  }

  // Decompose profile into graph nodes/edges so the Human Graph stays in
  // sync with the structured identity/relationships/interests/tensions
  // layer. Only skipped when the caller explicitly opts out OR the profile
  // was not persisted (non-persisted runs are dry-run by contract).
  const shouldWriteGraph = opts?.writeGraph !== false && opts?.persist !== false;
  if (shouldWriteGraph) {
    try { profileToGraph(parsed); }
    catch (err: any) { console.error("[Profile→Graph] failed:", err.message); }
    // Ingest per-event timeline data (calendar meetings + git commits) and
    // link them to the freshly-written graph nodes. Must run AFTER
    // profileToGraph so event→node links can resolve.
    try { ingestTimelineFromScan(profile); }
    catch (err: any) { console.error("[Timeline] ingest failed:", err.message); }
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
