/**
 * L2 Memory — Dream Engine.
 *
 * Inspired by Claude Code's Auto Dream + OpenClaw's Dreaming + Hermes consolidation.
 * Runs offline (cron 3am) to consolidate, prune, merge, and promote memories.
 *
 * Operations:
 * 1. Prune — remove stale/low-value memories
 * 2. Merge contradictions — detect conflicting memories, resolve via LLM
 * 3. Promote — recurring episodic → semantic
 * 4. Time normalize — "next Thursday" → "2026-04-23"
 * 5. Skill creation — complex execution patterns → reusable skill docs
 * 6. Capacity enforcement — keep total under MAX_MEMORIES
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { object } from "../infra/compute/index.js";
import { z } from "zod";
import { pickVariant } from "../orchestration/experiment-runner.js";

const MAX_MEMORIES = 200;

// ── 1. Prune stale memories ─────────────────────────────────────────────────

export function pruneStale(): number {
  let pruned = 0;

  // Working memory older than 7 days
  pruned += db.prepare(
    "DELETE FROM memories WHERE user_id=? AND type='working' AND julianday('now') - julianday(created_at) > 7"
  ).run(DEFAULT_USER_ID).changes;

  // Episodic with confidence < 0.5 older than 14 days
  pruned += db.prepare(
    "DELETE FROM memories WHERE user_id=? AND type='episodic' AND confidence < 0.5 AND julianday('now') - julianday(created_at) > 14"
  ).run(DEFAULT_USER_ID).changes;

  return pruned;
}

// ── 2. Detect + merge contradictions ────────────────────────────────────────

export async function mergeContradictions(): Promise<number> {
  // Get all semantic memories (these are long-term "truths" that might contradict)
  const semantics = db.prepare(
    "SELECT id, title, content, confidence, created_at FROM memories WHERE user_id=? AND type='semantic' ORDER BY created_at"
  ).all(DEFAULT_USER_ID) as any[];

  if (semantics.length < 2) return 0;

  try {
    const memoriesList = semantics.map((m: any, i: number) =>
      `[${i}] "${m.title}": ${m.content} (confidence: ${m.confidence})`
    ).join("\n");

    const baseSystem = `You analyze memories for contradictions. Given a list of semantic memories, find pairs that CONTRADICT each other.
Two memories contradict if they say opposite things about the same topic.
"Prefers email" vs "Now prefers Slack" = contradiction.
"Likes morning meetings" vs "Hired a CTO" = NOT a contradiction (different topics).
If no contradictions, return an empty array.`;
    const finalSystem = pickVariant({ key: "dream.contradictions_prompt", fallback: baseSystem }).value;
    const parsed = await object({
      task: "twin_edit_learning",
      system: finalSystem,
      messages: [{ role: "user", content: `Memories:\n${memoriesList}` }],
      schema: z.object({
        contradictions: z.array(z.object({
          ids: z.array(z.number()).length(2),
          resolution: z.string(),
          keep_newer: z.boolean().default(true),
        })).default([]),
      }),
      maxTokens: 400,
    });
    let merged = 0;

    for (const c of parsed.contradictions) {
      const [oldIdx, newIdx] = c.ids;
      const oldMem = semantics[oldIdx];
      const newMem = semantics[newIdx];
      if (!oldMem || !newMem) continue;

      if (c.resolution) {
        db.prepare("UPDATE memories SET content=?, updated_at=datetime('now') WHERE id=?")
          .run(c.resolution.slice(0, 300), newMem.id);
      }
      db.prepare("DELETE FROM memories WHERE id=?").run(oldMem.id);
      merged++;
    }
    return merged;
  } catch (err: any) {
    console.error("[Dream] Contradiction merge error:", err.message);
    return 0;
  }
}

// ── 3. Promote recurring patterns ───────────────────────────────────────────

export function promoteRecurring(): number {
  const recurring = db.prepare(`
    SELECT tags, COUNT(*) as cnt FROM memories
    WHERE user_id=? AND type='episodic'
    GROUP BY tags HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 5
  `).all(DEFAULT_USER_ID) as any[];

  let promoted = 0;
  for (const row of recurring) {
    let tags: string[];
    try { tags = JSON.parse(row.tags); } catch { continue; }
    if (tags.length === 0) continue;
    const tagStr = tags.join(", ");

    const existing = db.prepare(
      "SELECT id FROM memories WHERE user_id=? AND type='semantic' AND title LIKE ?"
    ).get(DEFAULT_USER_ID, `%Recurring: ${tagStr.slice(0, 20)}%`);
    if (existing) continue;

    const episodes = db.prepare(
      "SELECT content FROM memories WHERE user_id=? AND type='episodic' AND tags=? ORDER BY created_at DESC LIMIT 5"
    ).all(DEFAULT_USER_ID, row.tags) as any[];

    const summary = episodes.map((e: any) => e.content).join(" | ").slice(0, 200);
    db.prepare(
      "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
    ).run(nanoid(), DEFAULT_USER_ID, "semantic", `Recurring: ${tagStr.slice(0, 30)}`,
      `Pattern across ${row.cnt} episodes: ${summary}`,
      JSON.stringify([...tags, "auto-promoted"]), "Dream Engine", 0.7 + Math.min(0.2, row.cnt * 0.03));
    promoted++;
  }
  return promoted;
}

// ── 4. Time normalization ───────────────────────────────────────────────────

export function normalizeTimeReferences(): number {
  const now = new Date();
  const mems = db.prepare(
    "SELECT id, content FROM memories WHERE user_id=? AND (content LIKE '%next week%' OR content LIKE '%tomorrow%' OR content LIKE '%next month%' OR content LIKE '%this week%' OR content LIKE '%days ago%')"
  ).all(DEFAULT_USER_ID) as any[];

  let normalized = 0;
  for (const m of mems) {
    let content = m.content;
    let changed = false;

    // "tomorrow" → actual date
    if (/\btomorrow\b/i.test(content)) {
      const d = new Date(now); d.setDate(d.getDate() + 1);
      content = content.replace(/\btomorrow\b/gi, d.toISOString().slice(0, 10));
      changed = true;
    }
    // "next week" → actual date range
    if (/\bnext week\b/i.test(content)) {
      const d = new Date(now); d.setDate(d.getDate() + 7);
      content = content.replace(/\bnext week\b/gi, `week of ${d.toISOString().slice(0, 10)}`);
      changed = true;
    }
    // "next month" → actual month
    if (/\bnext month\b/i.test(content)) {
      const d = new Date(now); d.setMonth(d.getMonth() + 1);
      content = content.replace(/\bnext month\b/gi, d.toISOString().slice(0, 7));
      changed = true;
    }
    // "this week" → actual date
    if (/\bthis week\b/i.test(content)) {
      content = content.replace(/\bthis week\b/gi, `week of ${now.toISOString().slice(0, 10)}`);
      changed = true;
    }

    if (changed) {
      db.prepare("UPDATE memories SET content=? WHERE id=?").run(content, m.id);
      normalized++;
    }
  }
  return normalized;
}

// ── 5. Skill creation from complex executions ───────────────────────────────

export async function createSkillsFromExecutions(): Promise<number> {
  // Find execution sequences with 3+ tool calls that haven't been turned into skills
  const recentExecs = db.prepare(`
    SELECT action FROM agent_executions
    WHERE user_id=? AND agent='Execution Agent' AND status='success'
    AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC LIMIT 30
  `).all(DEFAULT_USER_ID) as any[];

  if (recentExecs.length < 5) return 0;

  // Check if we already created a skill recently
  const recentSkill = db.prepare(
    "SELECT id FROM skills WHERE user_id=? AND created_at >= datetime('now', '-3 days')"
  ).get(DEFAULT_USER_ID);
  if (recentSkill) return 0;

  try {
    const execSummary = recentExecs.map((e: any) => e.action).join("\n");

    const parsed = await object({
      task: "twin_edit_learning",
      system: `You analyze execution logs and extract reusable skills/patterns.
A "skill" is a repeatable sequence of actions the user does regularly.
If you see a clear pattern (e.g., "follow up with investor" always involves: search → draft email → update graph), create a skill.
If no clear pattern, return an empty array.`,
      messages: [{ role: "user", content: `Recent executions:\n${execSummary}` }],
      schema: z.object({
        skills: z.array(z.object({
          name: z.string(),
          description: z.string().default(""),
          steps: z.array(z.string()),
          trigger: z.string().default(""),
        })).default([]),
      }),
      maxTokens: 400,
    });
    let created = 0;

    for (const s of parsed.skills) {
      if (!s.name || s.steps.length === 0) continue;
      const existing = db.prepare("SELECT id FROM skills WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, s.name);
      if (existing) continue;

      db.prepare(
        "INSERT INTO skills (id, user_id, name, description, steps, trigger_pattern) VALUES (?,?,?,?,?,?)"
      ).run(nanoid(), DEFAULT_USER_ID, s.name, s.description, JSON.stringify(s.steps), s.trigger);
      created++;
    }
    return created;
  } catch {
    return 0;
  }
}

// ── 6. Capacity enforcement ─────────────────────────────────────────────────

export function enforceCapacity(): number {
  const count = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (count <= MAX_MEMORIES) return 0;

  const excess = count - MAX_MEMORIES;
  // Delete lowest-scoring memories (old + low confidence + episodic first)
  const result = db.prepare(`
    DELETE FROM memories WHERE id IN (
      SELECT id FROM memories WHERE user_id=?
      ORDER BY
        CASE type WHEN 'working' THEN 0 WHEN 'episodic' THEN 1 WHEN 'semantic' THEN 2 END,
        confidence ASC,
        created_at ASC
      LIMIT ?
    )
  `).run(DEFAULT_USER_ID, excess);

  return result.changes;
}

// ── Master Dream function ───────────────────────────────────────────────────

export async function runDream(): Promise<{
  pruned: number; merged: number; promoted: number;
  contradictions: number; skillsCreated: number; capacityRemoved: number;
  timeNormalized: number;
  decayed: number; archived: number; arbitrationsQueued: number;
}> {
  console.log("[Dream] Starting memory consolidation...");

  // Order matters: decay BEFORE prune so low-use memories can fall
  // through the archive threshold naturally. Arbitration runs AFTER
  // mergeContradictions so only the high-stakes survivors get queued.
  const { decayed, archived } = (await import("./lifecycle.js")).applyForgettingCurve();
  const pruned = pruneStale();
  const timeNormalized = normalizeTimeReferences();
  const contradictions = await mergeContradictions();
  const arbitrationsQueued = await (await import("./lifecycle.js")).detectHighStakesContradictions();
  const promoted = promoteRecurring();
  const skillsCreated = await createSkillsFromExecutions();
  const capacityRemoved = enforceCapacity();

  const stats = { pruned, merged: contradictions, promoted, contradictions, skillsCreated, capacityRemoved, timeNormalized, decayed, archived, arbitrationsQueued };

  // Log the dream run
  db.prepare(
    "INSERT INTO dream_log (id, pruned, merged, promoted, contradictions, skills_created) VALUES (?,?,?,?,?,?)"
  ).run(nanoid(), pruned, contradictions, promoted, contradictions, skillsCreated);

  logExecution("Dream Engine", `Dream complete: decayed=${decayed} archived=${archived} pruned=${pruned} merged=${contradictions} arbitrations=${arbitrationsQueued} promoted=${promoted} skills=${skillsCreated}`);
  console.log(`[Dream] Complete: decayed=${decayed}, archived=${archived}, pruned=${pruned}, merged=${contradictions}, arbitrations=${arbitrationsQueued}, promoted=${promoted}, skills=${skillsCreated}, capacity=${capacityRemoved}`);

  return stats;
}
