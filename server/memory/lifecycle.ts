/**
 * Memory Lifecycle — forgetting curves + contradiction arbitration.
 *
 * Complements dream.ts (which prunes, merges low-confidence contradictions,
 * promotes recurring episodic → semantic). This module adds:
 *
 *   1. applyForgettingCurve — Ebbinghaus-style exponential decay on
 *      `confidence` keyed by type-specific half-life. Memories aren't
 *      deleted when their confidence drops — they get status='archived'
 *      so provenance/history remain queryable but they don't surface in
 *      default recall.
 *
 *   2. detectHighStakesContradictions — pairs of HIGH-confidence memories
 *      that contradict are NOT auto-merged. They get queued in
 *      memory_arbitrations for user review. Low-confidence contradictions
 *      remain dream.ts's responsibility.
 *
 *   3. resolveArbitration — user picks which side wins; loser is archived
 *      with a pointer to the winner for audit trail.
 *
 *   4. recordMemoryAccess — touch last_accessed_at when a memory is read
 *      by retrieval. "Recall resets the decay clock" (ACT-R pattern).
 *
 * Design: decay + arbitration are additive, they never destroy data.
 * Any memory that was ever true is still queryable via its status +
 * resolution pointer, so future auditing / "what did I know in Q1"
 * queries are possible.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { text } from "../infra/compute/index.js";

// ── Forgetting curve ────────────────────────────────────────────────────

// Half-life per memory type (days). Working memories fade fast; semantic
// truths age slowly. Tuned so:
//   working: halves in 1 week
//   episodic: halves in 1 month
//   semantic: halves in 6 months
const HALF_LIFE_DAYS: Record<string, number> = {
  working: 7,
  episodic: 30,
  semantic: 180,
};
const ARCHIVE_CONFIDENCE_THRESHOLD = 0.10;
const RECALL_BOOST = 1.10;                  // multiplier applied on read — caps at 1.0

/**
 * Apply exponential decay to memory confidence based on time since last
 * access. Memories that fall below the archive threshold transition to
 * status='archived' (kept, but hidden from default recall).
 *
 * Returns { decayed, archived } counts.
 */
export function applyForgettingCurve(): { decayed: number; archived: number } {
  const rows = db.prepare(
    `SELECT id, type, confidence, last_accessed_at, created_at
     FROM memories
     WHERE user_id = ? AND status = 'active'`
  ).all(DEFAULT_USER_ID) as any[];

  const now = Date.now();
  let decayed = 0, archived = 0;

  const upd = db.prepare(`UPDATE memories SET confidence=? WHERE id=?`);
  const arch = db.prepare(`UPDATE memories SET status='archived' WHERE id=?`);

  db.transaction(() => {
    for (const r of rows) {
      const hl = HALF_LIFE_DAYS[r.type] ?? 30;
      const anchor = r.last_accessed_at ?? r.created_at;
      const ageDays = (now - new Date(anchor).getTime()) / 86_400_000;
      if (ageDays <= 0) continue;
      // C(t) = C₀ × exp(-t·ln(2)/halfLife)
      const decayFactor = Math.exp(-ageDays * Math.LN2 / hl);
      const newConfidence = Math.max(0, Math.min(1, r.confidence * decayFactor));
      if (Math.abs(newConfidence - r.confidence) < 0.005) continue;
      upd.run(newConfidence, r.id);
      decayed++;
      if (newConfidence < ARCHIVE_CONFIDENCE_THRESHOLD) {
        arch.run(r.id);
        archived++;
      }
    }
  })();
  return { decayed, archived };
}

/**
 * Called by retrieval.ts when a memory is successfully returned to a
 * consumer. Bumps confidence back up (capped at 1.0) and refreshes
 * last_accessed_at. This is the "recall resets decay" primitive.
 */
export function recordMemoryAccess(memoryId: string): void {
  db.prepare(
    `UPDATE memories
     SET last_accessed_at = datetime('now'),
         confidence = MIN(1.0, confidence * ?)
     WHERE id = ? AND user_id = ?`
  ).run(RECALL_BOOST, memoryId, DEFAULT_USER_ID);
}

// ── Contradiction arbitration queue ─────────────────────────────────────

const HIGH_STAKES_CONFIDENCE_MIN = 0.7;

/**
 * LLM-scan for pairs of HIGH-confidence semantic memories that contradict.
 * Queue them for user review instead of auto-merging. Low-confidence
 * contradictions remain dream.ts's responsibility.
 *
 * Caller: nightly dream cron, AFTER dream.mergeContradictions has run
 * (so anything remaining is by definition high-confidence-on-both-sides).
 */
export async function detectHighStakesContradictions(): Promise<number> {
  const mems = db.prepare(
    `SELECT id, title, content, confidence
     FROM memories
     WHERE user_id=? AND type='semantic' AND status='active' AND confidence >= ?
     ORDER BY created_at`
  ).all(DEFAULT_USER_ID, HIGH_STAKES_CONFIDENCE_MIN) as any[];

  if (mems.length < 2) return 0;

  // Don't re-queue already-open or already-resolved pairs
  const existing = db.prepare(
    `SELECT left_id, right_id FROM memory_arbitrations WHERE user_id=?`
  ).all(DEFAULT_USER_ID) as any[];
  const alreadyQueued = new Set<string>();
  for (const r of existing) {
    alreadyQueued.add(pairKey(r.left_id, r.right_id));
  }

  const listing = mems.slice(0, 30).map((m: any, i: number) =>
    `[${i}] id=${m.id} conf=${m.confidence.toFixed(2)} | ${m.title}: ${m.content.slice(0, 180)}`
  ).join("\n");

  let verdict: { pairs?: Array<{ a: number; b: number; topic: string; severity: "low"|"medium"|"high" }> };
  try {
    const raw = await text({
      task: "twin_edit_learning",
      system: `You are analyzing HIGH-confidence semantic memories for contradictions that are too consequential to auto-merge.

Two memories contradict if they say opposite things ABOUT THE SAME topic or entity. Examples:
- "Kevin works at Acme" vs "Kevin works at Beta" — topic=Kevin's employer → HIGH severity
- "Prefers morning meetings" vs "Prefers evening calls" — topic=meeting preference → MEDIUM
- "Likes coffee" vs "Just became a CTO" — DIFFERENT topics → NOT a contradiction

Output ONLY a JSON object:
{ "pairs": [{ "a": <int>, "b": <int>, "topic": "<what they disagree about>", "severity": "low"|"medium"|"high" }] }

Include only pairs where:
  - They are clearly on the same topic
  - The statements are genuinely mutually exclusive (not just different aspects)

If no contradictions: { "pairs": [] }`,
      messages: [{ role: "user", content: `High-confidence semantic memories (id index in [..]):\n${listing}` }],
      maxTokens: 600,
    });
    const stripped = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    verdict = m ? JSON.parse(m[0]) : { pairs: [] };
  } catch (err: any) {
    // LLM unavailable — graceful no-op, arbitration is a best-effort layer
    console.warn("[Lifecycle] contradiction detection unavailable:", err?.message);
    return 0;
  }

  let queued = 0;
  if (!Array.isArray(verdict?.pairs)) return 0;
  for (const p of verdict.pairs) {
    const a = mems[p.a], b = mems[p.b];
    if (!a || !b || a.id === b.id) continue;
    if (alreadyQueued.has(pairKey(a.id, b.id))) continue;
    db.prepare(
      `INSERT INTO memory_arbitrations
        (id, user_id, kind, left_id, right_id, left_preview, right_preview, topic, severity, status)
       VALUES (?,?,?,?,?,?,?,?,?,'open')`
    ).run(
      nanoid(), DEFAULT_USER_ID, "memory",
      a.id, b.id,
      `${a.title}: ${a.content.slice(0, 300)}`,
      `${b.title}: ${b.content.slice(0, 300)}`,
      typeof p.topic === "string" ? p.topic.slice(0, 120) : null,
      p.severity === "high" || p.severity === "low" ? p.severity : "medium",
    );
    queued++;
  }
  return queued;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * User arbitrates a queued contradiction. Loser is archived with a
 * resolution_note referencing the winner so provenance is preserved.
 */
export function resolveArbitration(
  arbitrationId: string,
  resolution: "keep_left" | "keep_right" | "keep_both" | "custom",
  opts: { customMemory?: { title: string; content: string }; note?: string } = {},
): boolean {
  const row = db.prepare(
    `SELECT * FROM memory_arbitrations WHERE id=? AND user_id=? AND status='open'`
  ).get(arbitrationId, DEFAULT_USER_ID) as any;
  if (!row) return false;

  if (resolution === "keep_left" || resolution === "keep_right") {
    const loserId = resolution === "keep_left" ? row.right_id : row.left_id;
    const winnerId = resolution === "keep_left" ? row.left_id : row.right_id;
    db.prepare(
      `UPDATE memories SET status='archived'
       WHERE id=? AND user_id=?`
    ).run(loserId, DEFAULT_USER_ID);
    // Bump the winner's confidence as user explicitly confirmed it
    db.prepare(
      `UPDATE memories SET confidence = MIN(1.0, confidence + 0.1), last_accessed_at = datetime('now')
       WHERE id=? AND user_id=?`
    ).run(winnerId, DEFAULT_USER_ID);
  } else if (resolution === "custom" && opts.customMemory) {
    // User wrote a corrected memory — archive both, insert new one
    db.prepare(
      `UPDATE memories SET status='archived'
       WHERE id IN (?, ?) AND user_id=?`
    ).run(row.left_id, row.right_id, DEFAULT_USER_ID);
    db.prepare(
      `INSERT INTO memories
        (id, user_id, type, title, content, tags, source, confidence)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      nanoid(), DEFAULT_USER_ID, "semantic",
      opts.customMemory.title, opts.customMemory.content,
      JSON.stringify(["arbitration", "user-corrected"]),
      "User Arbitration", 0.95,
    );
  }
  // keep_both: just close the arbitration without touching memories

  db.prepare(
    `UPDATE memory_arbitrations
     SET status='resolved', resolution=?, resolution_note=?, resolved_at=datetime('now')
     WHERE id=?`
  ).run(resolution, opts.note ?? null, arbitrationId);
  return true;
}

export function listOpenArbitrations(limit = 50) {
  return db.prepare(
    `SELECT id, kind, left_id as leftId, right_id as rightId,
            left_preview as leftPreview, right_preview as rightPreview,
            topic, severity, status, created_at as createdAt
     FROM memory_arbitrations WHERE user_id=? AND status='open'
     ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              created_at DESC LIMIT ?`
  ).all(DEFAULT_USER_ID, limit);
}
