/**
 * Oracle Council — the "oh it gets me" moment of Anchor's Onboarding.
 *
 * Five specialized Oracle agents each look at the user's InferredProfile
 * through a distinct lens and produce a 150-250 word first-person
 * narrative addressed directly to the user, ending with 2-3 probing
 * questions. A sixth Compass agent synthesizes all five into a single
 * portrait.
 *
 *   Historian     — trajectory, arc, what chapter you're in
 *   Cartographer  — relationships, network topology, roles
 *   Purpose       — goal vs. behavior alignment, what you're really doing
 *   Shadow        — avoidance, blind spots, hidden failure modes
 *   Tempo         — rhythm, schedule truth, peak hours, patterns
 *
 * Design choices:
 *   - Oracles read InferredProfile (already structured) — fast + consistent
 *   - Each Oracle prompt includes its `openings_for_oracles` list from the
 *     profile (pre-curated entry points by Step 7) + profile sections
 *     most relevant to that Oracle's lens
 *   - Parallel via Promise.all. ~5-6 LLM calls for full council
 *   - Compass reads all 5 narratives + delivers headline + short synthesis
 *   - Output persisted to `portraits` table, versioned
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { object } from "../infra/compute/index.js";
import { bus } from "../orchestration/bus.js";
import { getLatestProfile, inferProfile, type InferredProfile } from "./profile-inference.js";
import { computeRhythmFingerprint, rhythmToText } from "../graph/timeline.js";
import { z } from "zod";

const OracleNarrativeSchema = z.object({
  narrative: z.string(),
  questions: z.array(z.string()).default([]),
});

const CompassSchema = z.object({
  headline: z.string(),
  paragraph: z.string(),
  three_questions: z.array(z.string()).default([]),
});

// ── Schema ────────────────────────────────────────────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portraits (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      profile_version INTEGER,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_portraits_user_created ON portraits(user_id, created_at DESC)"); } catch {}

// ── Types ─────────────────────────────────────────────────────────────────

export type OracleId = "historian" | "cartographer" | "purpose" | "shadow" | "tempo";

export interface OracleNarrative {
  oracle: OracleId;
  displayName: string;
  icon: string;
  narrative: string;
  questions: string[];
  runDurationMs: number;
}

export interface Compass {
  headline: string;
  paragraph: string;
  three_questions: string[];
}

export interface PortraitV1 {
  profileVersion?: number;
  oracles: OracleNarrative[];
  compass: Compass;
  generatedAt: string;
}

// ── Oracle definitions ───────────────────────────────────────────────────

interface OracleDef {
  id: OracleId;
  displayName: string;
  icon: string;
  lens: string;                           // core framing in system prompt
  profileSlice: (p: InferredProfile) => string;  // which profile sections to emphasize
}

const ORACLES: OracleDef[] = [
  {
    id: "historian",
    displayName: "Historian",
    icon: "📜",
    lens:
      "You are the Historian Oracle. You read the user's tool presence, file archive, and language/timezone fingerprint as ARTIFACTS of a longer biographical arc. Your question is never 'what is the user doing now' — it is 'what chapter of their life is this, and what chapter is ending or starting?'. You notice which tools are 2024-2025 new (a new chapter) vs pre-2020 loyal (continuity), what Desktop files hint at a present transition (e.g. finance curriculum = skill pivot), what language/cultural signals trace a longer migration story. SPECIFICALLY cite evidence from: active_interests.evidence (look for repo names, vault names, curriculum filenames — these are TIMESTAMPED chapter markers); cohort_tags (e.g. '2024-ai-native' signals entry year); cultural_context.nuance (migration/bicultural arc). If the profile slice names a specific artifact (repo, vault, library size), use that exact name in your narrative. You write warmly but precisely. You do not flatter. You notice what's ending as much as what's beginning.",
    profileSlice: (p) => {
      const parts: string[] = [];
      parts.push(`Identity: ${p.identity.primary_role}; secondary: ${p.identity.secondary_roles.join(", ")}; cohort: ${p.identity.cohort_tags.join(", ")}`);
      parts.push(`Cultural: ${p.cultural_context.primary_region} (${p.cultural_context.fluency}); languages: ${p.cultural_context.languages.join(", ")}. Nuance: ${p.cultural_context.nuance}`);
      parts.push(`Active interests (with phases): ${p.active_interests.map(i => `[${i.phase}] ${i.area} — ${i.evidence}`).join(" | ")}`);
      parts.push(`Openings: ${(p.openings_for_oracles.historian ?? []).join(" | ")}`);
      return parts.join("\n");
    },
  },
  {
    id: "cartographer",
    displayName: "Cartographer",
    icon: "🗺️",
    lens:
      "You are the Cartographer Oracle. You map the user's relationship topology: who is close, who is drifting, who is transactional, who is missing. You read key_relationships (built from messagesUnified top contacts + emailUnified top senders), communication-app presence, calendar collaborator density. CITE SPECIFIC IDENTIFIERS from key_relationships[].identifier — a name, handle, or email fragment — do not paraphrase them away. You look for ASYMMETRIES: who initiates vs responds, who is present in messages but absent from calendar, which chat-app (WeChat vs iMessage vs Telegram, per cultural_context.nuance) holds which circle — a WeChat-heavy + iMessage contact split is a cross-border relationship topology, NAME it. You notice the SIZE of the close-in circle vs wider network. You flag when someone's hypothesis-only role might be very wrong and invite the user to correct.",
    profileSlice: (p) => {
      const parts: string[] = [];
      parts.push(`Cultural context: ${p.cultural_context.primary_region}, ${p.cultural_context.fluency}; ${p.cultural_context.nuance}`);
      parts.push(`Key relationships: ${p.key_relationships.map(r => `${r.identifier} [strength ${r.relationship_strength}] — ${r.role_hypothesis}. ${r.evidence}`).join(" | ")}`);
      parts.push(`Openings: ${(p.openings_for_oracles.cartographer ?? []).join(" | ")}`);
      return parts.join("\n");
    },
  },
  {
    id: "purpose",
    displayName: "Purpose",
    icon: "🎯",
    lens:
      "You are the Purpose Oracle. You compare what the user SAYS they're doing (their primary_role) against what their ARTIFACTS show (git projects, desktop files, tool choices, running processes, time allocation). You find the difference between STATED purpose and BEHAVED purpose. SPECIFICALLY: look at active_interests[].evidence for concrete artifact names (primary repo from codeUnified, a curriculum filename, a vault name) — these are the BEHAVED purpose. If active_interests lists multiple competing areas (e.g. 'AI systems' + 'DJing' + 'finance curriculum'), name the competing pulls directly and ask which is the true north. Reframe what they're actually building using a word or concept they themselves may not have used. You are blunt but respectful. You never preach about priorities — you illuminate the gap and let them answer it.",
    profileSlice: (p) => {
      const parts: string[] = [];
      parts.push(`Primary role: ${p.identity.primary_role}`);
      parts.push(`Active interests: ${p.active_interests.map(i => `[${i.phase}] ${i.area} (${i.evidence})`).join(" | ")}`);
      parts.push(`Tensions: ${p.tensions.map(t => t.description).join(" | ")}`);
      parts.push(`Unknowns: ${p.unknowns.join(" | ")}`);
      parts.push(`Openings: ${(p.openings_for_oracles.purpose ?? []).join(" | ")}`);
      return parts.join("\n");
    },
  },
  {
    id: "shadow",
    displayName: "Shadow",
    icon: "🌗",
    lens:
      "You are the Shadow Oracle. You surface what the user is AVOIDING or NOT SEEING. You read ABSENCE patterns — these often appear in tensions[] or unknowns[]: no task manager adopted (tasksUnified.signals), scattered markdown without a consolidation habit (notesUnified.scatteredMarkdown), zero calendar locations (locationUnified), dormant phase on active_interests (a project named in evidence but not touched recently). Privacy/security tooling beyond casual interest is also a shadow. You name anxieties or imposter-syndromes if evidence is strong. If active_interests includes 'DJing' or 'finance' alongside a demanding primary_role, the shadow may be: the hobby is the escape from the thing that matters most. You are gentle but honest — you do not shame, but you also do not protect. If the evidence is thin, you say 'I might be wrong here' and ask a question instead.",
    profileSlice: (p) => {
      const parts: string[] = [];
      parts.push(`Identity: ${p.identity.primary_role}; secondary: ${p.identity.secondary_roles.join(", ")}`);
      parts.push(`Tensions (these are contradictions from scan evidence): ${p.tensions.map(t => `- ${t.description} (${t.evidence})`).join(" || ")}`);
      parts.push(`Unknowns: ${p.unknowns.join(" | ")}`);
      parts.push(`Openings: ${(p.openings_for_oracles.shadow ?? []).join(" | ")}`);
      return parts.join("\n");
    },
  },
  {
    id: "tempo",
    displayName: "Tempo",
    icon: "⏱️",
    lens:
      "You are the Tempo Oracle. You read the user's work rhythm — when they are sharp, when they are scattered, what breaks their flow, whether their stated schedule matches their actual peaks. You now have access to TWO tempo sources: the profile's pre-aggregated work_style AND a live 'Rhythm (last 180d)' fingerprint computed from raw per-event timestamps (commits + meetings). CITE THE LIVE RHYTHM — the peak hour, peak day of week, top-3 days, active-day ratio, and longest commit streak are from actual timestamped events, not generic descriptors. If the live rhythm CONFIRMS the profile's claim (e.g. profile says late-night, timeline confirms 23:00 peak), say so. If it CONTRADICTS (profile says morning-person, commits cluster at 22:00), flag the contradiction. If active_interests includes DJing/music (Rekordbox, NetEase), that is a PARALLEL rhythm — name both. You flag ritual vs. chaotic rhythms, sustainability vs. overload. You do not prescribe wellness — you describe the rhythm and ask whether it serves the person.",
    profileSlice: (p) => {
      const parts: string[] = [];
      parts.push(`Work style (profile, pre-aggregated): schedule=${p.work_style.schedule_type}, meetings=${p.work_style.meeting_density}, peak=${p.work_style.peak_day ?? "?"} ${p.work_style.peak_hour ?? "?"}:00`);
      parts.push(`Focus pattern narrative: ${p.work_style.focus_pattern}`);
      // Live rhythm from timeline — actual event timestamps, not summary.
      // Falls back gracefully when timeline has no data yet (first run).
      try {
        const rhythm = computeRhythmFingerprint({ windowDays: 180 });
        parts.push(rhythmToText(rhythm));
      } catch (err) { /* timeline query failed — profile stats still present */ }
      parts.push(`Active interests (running in parallel): ${p.active_interests.map(i => i.area).join(" | ")}`);
      parts.push(`Openings: ${(p.openings_for_oracles.tempo ?? []).join(" | ")}`);
      return parts.join("\n");
    },
  },
];

// ── System prompt builder (shared structure across oracles) ──────────────

function buildOraclePrompt(def: OracleDef): string {
  return `${def.lens}

OUTPUT FORMAT — strict:
You will output ONLY a JSON object with this shape (no preamble, no markdown):
{
  "narrative": "150-250 word first-person-to-user narrative in second person ('you'). Specific, evidence-based, not generic. Must reference specific details from the profile slice. Do not flatter; do not preach. Warm but precise tone.",
  "questions": ["1-3 probing questions — open-ended, not yes/no. Each question should invite the user to CORRECT or CONFIRM a hypothesis you raised in the narrative."]
}

CONSTRAINTS:
- Reference concrete evidence from the profile (names, counts, filenames, patterns) — do not write generically
- MUST cite at least ONE specific identifier from the profile slice (a repo name, contact handle, vault name, library size, peak hour, cohort tag) — a narrative with zero concrete citations is a failed output
- If confidence is low, say so explicitly; DO NOT fabricate certainty
- Use the "Openings" line from the profile slice as your sharpest entry point
- Do NOT repeat what other oracles will say — stay in YOUR lens`;
}

async function runOracle(def: OracleDef, profile: InferredProfile): Promise<OracleNarrative> {
  const start = Date.now();
  const system = buildOraclePrompt(def);
  const user = `Here is the profile slice most relevant to your lens:\n\n${def.profileSlice(profile)}\n\nProduce your JSON output now.`;

  let narrative = "";
  let questions: string[] = [];
  try {
    const parsed = await object({
      task: "decision",
      system,
      messages: [{ role: "user", content: user }],
      schema: OracleNarrativeSchema,
      maxTokens: 1200,
      agentName: `Oracle:${def.displayName}`,
    });
    narrative = parsed.narrative.trim();
    questions = parsed.questions;
  } catch (err: any) {
    console.error(`[Oracle:${def.displayName}] structured-output failed:`, err.message);
  }
  if (!narrative) narrative = "(Oracle returned no narrative)";

  return {
    oracle: def.id,
    displayName: def.displayName,
    icon: def.icon,
    narrative,
    questions: questions.slice(0, 3),
    runDurationMs: Date.now() - start,
  };
}

// ── Compass synthesizer ──────────────────────────────────────────────────

async function runCompass(profile: InferredProfile, oracles: OracleNarrative[]): Promise<Compass> {
  const system = `You are the Compass — the synthesizer that reads all five Oracle narratives and produces a single coherent portrait for the user.

OUTPUT FORMAT — strict JSON only:
{
  "headline": "ONE sentence capturing who this person is right now — specific, not generic. Must land with precision. Under 30 words.",
  "paragraph": "3-5 sentences weaving together the Oracles' strongest points. Must feel like a mirror — the user should read it and think 'yes, that's me, but I hadn't said it like that.' Do not list Oracles; integrate.",
  "three_questions": ["THE 3 most important open questions across all Oracles that, if answered, would unlock the next phase for this person. Order by leverage — first question should be the most high-stakes."]
}

CONSTRAINTS:
- Be specific, not motivational. No "you have so much potential" filler.
- Pick ONE identity frame for the headline — not a list of roles.
- The paragraph must surface a TENSION or reframe at least once.
- Questions must be PRECISE — not "what do you want?" but "is X or Y the real driver?"`;

  const user = [
    "Profile (compact):",
    `  identity: ${profile.identity.primary_role}`,
    `  tensions: ${profile.tensions.map(t => t.description).join(" || ")}`,
    `  unknowns: ${profile.unknowns.join(" | ")}`,
    "",
    "Oracle narratives:",
    ...oracles.map(o => `---\n[${o.displayName}] ${o.narrative}\nquestions: ${o.questions.join(" // ")}`),
    "",
    "Produce your compass JSON now.",
  ].join("\n");

  try {
    const parsed = await object({
      task: "decision",
      system,
      messages: [{ role: "user", content: user }],
      schema: CompassSchema,
      maxTokens: 1000,
      agentName: "Oracle:Compass",
    });
    return {
      headline: parsed.headline.trim() || "Portrait ready (headline parse failed).",
      paragraph: parsed.paragraph.trim(),
      three_questions: parsed.three_questions.slice(0, 3),
    };
  } catch (err: any) {
    console.error("[Oracle:Compass] structured-output failed:", err.message);
    return {
      headline: "Portrait generated (Compass output could not be parsed strictly).",
      paragraph: "",
      three_questions: [],
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function runOracleCouncil(opts?: {
  profile?: InferredProfile;
  persist?: boolean;
  stream?: boolean;           // emit PORTRAIT_PROGRESS events as oracles resolve
}): Promise<PortraitV1> {
  const stream = opts?.stream !== false;
  let profile = opts?.profile;
  if (!profile) {
    if (stream) bus.publish({ type: "PORTRAIT_PROGRESS", payload: { phase: "profile" } });
    profile = getLatestProfile() ?? await inferProfile({ persist: true });
  }

  console.log("[OracleCouncil] dispatching 5 Oracles in parallel...");
  const oracleStart = Date.now();

  // Fire events per Oracle as they resolve — each runOracle is a separate Promise.
  const oracles: OracleNarrative[] = [];
  await Promise.all(ORACLES.map(async (def) => {
    const result = await runOracle(def, profile!);
    oracles.push(result);
    if (stream) {
      bus.publish({ type: "PORTRAIT_PROGRESS", payload: {
        phase: "oracle",
        oracle: result.oracle,
        narrative: result.narrative,
        questions: result.questions,
        icon: result.icon,
        durationMs: result.runDurationMs,
      }});
    }
  }));
  // Restore canonical order (Promise resolution order is non-deterministic)
  oracles.sort((a, b) => ORACLES.findIndex(o => o.id === a.oracle) - ORACLES.findIndex(o => o.id === b.oracle));
  console.log(`[OracleCouncil] 5 Oracles done in ${Date.now() - oracleStart}ms. Running Compass...`);

  if (stream) bus.publish({ type: "PORTRAIT_PROGRESS", payload: { phase: "compass" } });
  const compassStart = Date.now();
  const compass = await runCompass(profile, oracles);
  console.log(`[OracleCouncil] Compass done in ${Date.now() - compassStart}ms.`);

  const portrait: PortraitV1 = {
    oracles,
    compass,
    generatedAt: new Date().toISOString(),
  };

  if (opts?.persist !== false) persistPortrait(portrait);
  if (stream) bus.publish({ type: "PORTRAIT_PROGRESS", payload: { phase: "done", compass } });
  return portrait;
}

function persistPortrait(portrait: PortraitV1): string {
  const id = nanoid();
  const latest = db.prepare(
    "SELECT version FROM portraits WHERE user_id=? ORDER BY version DESC LIMIT 1"
  ).get(DEFAULT_USER_ID) as any;
  const nextVersion = (latest?.version ?? 0) + 1;
  db.prepare(
    "INSERT INTO portraits (id, user_id, version, data_json) VALUES (?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, nextVersion, JSON.stringify(portrait));
  console.log(`[OracleCouncil] Persisted portrait v${nextVersion} (id=${id.slice(0, 8)})`);
  return id;
}

export function getLatestPortrait(userId = DEFAULT_USER_ID): PortraitV1 | null {
  const row = db.prepare(
    "SELECT data_json FROM portraits WHERE user_id=? ORDER BY version DESC LIMIT 1"
  ).get(userId) as any;
  if (!row) return null;
  try { return JSON.parse(row.data_json) as PortraitV1; } catch { return null; }
}

// ── Render for diagnostics / CLI ─────────────────────────────────────────

export function portraitToReadable(p: PortraitV1): string {
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  YOUR PORTRAIT");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`◆ ${p.compass.headline}`);
  lines.push("");
  lines.push(p.compass.paragraph);
  lines.push("");
  if (p.compass.three_questions.length > 0) {
    lines.push("◆ THE QUESTIONS THAT MATTER");
    for (const q of p.compass.three_questions) lines.push(`  ? ${q}`);
    lines.push("");
  }

  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("  ORACLE COUNCIL — 5 voices");
  lines.push("───────────────────────────────────────────────────────────────");
  for (const o of p.oracles) {
    lines.push("");
    lines.push(`${o.icon}  ${o.displayName.toUpperCase()}`);
    lines.push("");
    lines.push(o.narrative);
    if (o.questions.length > 0) {
      lines.push("");
      for (const q of o.questions) lines.push(`   ? ${q}`);
    }
    lines.push(`   (${o.runDurationMs}ms)`);
    lines.push("");
  }
  return lines.join("\n");
}
