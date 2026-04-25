/**
 * L2 Memory & Retrieval — Retrieval contracts.
 *
 * NOT a storage layer. This is the INTELLIGENCE of recall:
 * - What to surface, when, and why
 * - Context-aware: match memories to the current question
 * - Confidence + recency weighted scoring
 * - Different retrieval routes for different consumers
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { type MemoryClass, MEMORY_CLASSES } from "./classes.js";
import { nanoid } from "nanoid";

export interface MemoryRecord {
  id: string;
  type: MemoryClass;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  createdAt: string;
  /** Bi-temporal — when the FACT became true in the world (not when learned).
   *  Backfilled to created_at on legacy rows; new rows set explicitly. */
  validFrom?: string | null;
  /** When the fact stopped being true. NULL = still valid. */
  validTo?: string | null;
  /** When Anchor INGESTED the memory (transaction time). */
  recordedAt?: string | null;
  relevanceScore?: number;  // computed at retrieval time
}

// ── Scoring — confidence × recency × keyword relevance ─────────────────────

function scoreMemory(mem: MemoryRecord, queryKeywords: string[], now: number): number {
  // Base: confidence (0-1)
  let score = mem.confidence;

  // Recency bonus: memories from last 24h get 1.0, decays to 0.3 over 30 days
  const ageMs = now - new Date(mem.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.max(0.3, 1.0 - (ageDays / 30) * 0.7);
  score *= recencyFactor;

  // Type weight: semantic > episodic > working (for decision context)
  const typeWeights: Record<string, number> = { semantic: 1.2, episodic: 1.0, working: 0.8 };
  score *= typeWeights[mem.type] ?? 1.0;

  // Keyword relevance: boost if memory content matches query words
  if (queryKeywords.length > 0) {
    const contentLower = (mem.title + " " + mem.content + " " + mem.tags.join(" ")).toLowerCase();
    let matches = 0;
    for (const kw of queryKeywords) {
      if (contentLower.includes(kw.toLowerCase())) matches++;
    }
    const relevanceFactor = 1.0 + (matches / queryKeywords.length) * 1.5;  // up to 2.5x boost
    score *= relevanceFactor;
  }

  return score;
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall", "must", "need", "dare", "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before", "after", "above", "below", "between", "out", "off", "over", "under", "again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all", "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "just", "about", "also", "what", "which", "who", "whom", "this", "that", "these", "those", "am", "but", "and", "or", "if", "it", "its", "my", "me", "we", "our", "you", "your", "he", "him", "his", "she", "her", "they", "them", "their", "i"]);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

// ── Retrieval Routes ────────────────────────────────────────────────────────

/**
 * Route A: For Decision Agent — context-aware, scored, best memories for reasoning.
 * Reads the user's question, finds the most relevant memories.
 */
export function getForDecision(userMessage: string, limit = 12): MemoryRecord[] {
  const allMems = db.prepare(
    // Filter archived — forgetting-curve'd memories stay queryable via getByClass
    // or direct id lookup but don't flood the Decision Agent's default context.
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt, valid_from as validFrom, valid_to as validTo, recorded_at as recordedAt FROM memories WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT 100"
  ).all(DEFAULT_USER_ID) as any[];

  const keywords = extractKeywords(userMessage);
  const now = Date.now();

  const scored = allMems
    .map(r => {
      const mem: MemoryRecord = { ...r, tags: safeParseTags(r.tags) };
      mem.relevanceScore = scoreMemory(mem, keywords, now);
      return mem;
    })
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
    .slice(0, limit);

  touchAccessFireAndForget(scored.map(m => m.id));
  return scored;
}

/**
 * Hybrid retrieval: keyword scoring (sparse) + semantic embedding (dense) fused via RRF.
 * Reciprocal Rank Fusion collapses two independent ranked lists without needing
 * score normalization — rank position is the only signal. k=60 is the canonical
 * smoothing constant from the original Cormack+Clarke 2009 paper.
 *
 * Falls back to keyword-only if RAG is unavailable (no embedding provider key,
 * no embeddings yet stored, or embed() throws). Anchor must never be bricked by
 * a missing API key.
 */
/**
 * Record that these memories were read. The Ebbinghaus forgetting curve uses
 * last_accessed_at as its decay anchor — recalling a memory resets the clock,
 * so "used memories stay sharp, unused ones fade." Called fire-and-forget
 * from the retrieval read path; a missing update never hurts correctness.
 */
function touchAccessFireAndForget(memoryIds: string[]): void {
  if (memoryIds.length === 0) return;
  // Dynamic import + background-fire avoids adding latency to read path;
  // lifecycle.ts imports retrieval.ts for some ops, avoiding circularity.
  import("./lifecycle.js")
    .then(m => memoryIds.forEach(id => m.recordMemoryAccess(id)))
    .catch(() => {});
}

export async function getForDecisionHybrid(userMessage: string, limit = 12): Promise<MemoryRecord[]> {
  const keywordTop = getForDecision(userMessage, 30);

  let semanticIds: string[] = [];
  try {
    const { ragRetrieve } = await import("../infra/rag/index.js");
    const sem = await ragRetrieve(userMessage, 30);
    semanticIds = sem.map(r => r.id);
  } catch {
    // RAG unavailable — fall through to keyword-only
  }

  if (semanticIds.length === 0) return keywordTop.slice(0, limit);

  // RRF fusion: both lists contribute 1/(k + rank) per appearance
  const RRF_K = 60;
  const scores = new Map<string, number>();
  keywordTop.forEach((m, idx) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (RRF_K + idx + 1));
  });
  semanticIds.forEach((id, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + idx + 1));
  });

  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const topIds = ranked.map(e => e[0]);
  if (topIds.length === 0) return [];

  const placeholders = topIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, type, title, content, tags, source, confidence, created_at as createdAt,
            valid_from as validFrom, valid_to as validTo, recorded_at as recordedAt
     FROM memories WHERE id IN (${placeholders}) AND user_id=? AND status='active'`
  ).all(...topIds, DEFAULT_USER_ID) as any[];

  const byId = new Map(rows.map(r => [r.id, r]));
  const ordered = topIds
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(r => ({
      ...r,
      tags: safeParseTags(r.tags),
      relevanceScore: scores.get(r.id),
    }));

  // Bump last_accessed_at — Ebbinghaus decay uses this as recall anchor
  touchAccessFireAndForget(ordered.map(m => m.id));

  return ordered;
}

/**
 * Route B: For Execution Agent — recent episodic + working context.
 */
export function getForExecution(limit = 8): MemoryRecord[] {
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND status='active' AND type IN ('working','episodic') ORDER BY created_at DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, limit) as any[];
  return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
}

/**
 * Route C: For Cron / Digest — only working memory (today's context).
 */
export function getForDigest(limit = 5): MemoryRecord[] {
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND type='working' ORDER BY created_at DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, limit) as any[];
  return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
}

/** Get Twin insights — behavioral priors for Decision Agent. */
export function getTwinPriors(): { category: string; insight: string; confidence: number }[] {
  return db.prepare(
    "SELECT category, insight, confidence FROM twin_insights WHERE user_id=? ORDER BY confidence DESC"
  ).all(DEFAULT_USER_ID) as any[];
}

/** Get memories by type. */
export function getByClass(memClass: MemoryClass, limit = 50): MemoryRecord[] {
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND type=? ORDER BY created_at DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, memClass, limit) as any[];
  return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
}

/** Search memories using FTS5 full-text search (hybrid: ranked keyword matching).
 *  Falls back to LIKE if FTS5 table doesn't exist yet. */
export function searchMemories(query: string, limit = 20): MemoryRecord[] {
  try {
    // FTS5 ranked search — much faster and more relevant than LIKE
    const rows = db.prepare(`
      SELECT m.id, m.type, m.title, m.content, m.tags, m.source, m.confidence, m.created_at as createdAt,
             rank as ftsRank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ? AND m.user_id = ?
      ORDER BY rank LIMIT ?
    `).all(query, DEFAULT_USER_ID, limit) as any[];
    return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
  } catch {
    // Fallback to LIKE if FTS5 not available
    const rows = db.prepare(
      "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND (content LIKE ? OR title LIKE ?) ORDER BY created_at DESC LIMIT ?"
    ).all(DEFAULT_USER_ID, `%${query}%`, `%${query}%`, limit) as any[];
    return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
  }
}

/** Get memory stats by class. */
export function getStats(): Record<MemoryClass, number> {
  const rows = db.prepare(
    "SELECT type, COUNT(*) as count FROM memories WHERE user_id=? GROUP BY type"
  ).all(DEFAULT_USER_ID) as any[];
  const stats: Record<string, number> = { working: 0, episodic: 0, semantic: 0 };
  for (const r of rows) stats[r.type] = r.count;
  return stats as Record<MemoryClass, number>;
}

// ── Context serialization (for L3 Cognition prompt injection) ───────────────

/**
 * Serialize memories for Decision Agent prompt — CONTEXT-AWARE.
 * Hybrid: keyword + semantic via RRF fusion. Falls back to keyword-only
 * if embedding provider is unavailable.
 *
 * Each memory carries an explicit temporal label (Zep-style) so the LLM
 * doesn't treat stale facts as current. Format options:
 *   [type · valid YYYY-MM-DD → now]   — fact still true
 *   [type · valid YYYY-MM-DD → YYYY-MM-DD]  — fact has expired
 *   [type · YYYY-MM-DD]               — point-in-time event (no validity range)
 * This is the technical move behind Zep's 63.8% LongMemEval score (vs Mem0
 * 49%): explicit temporal scope lets the LLM reason about whether a memory
 * is "still in effect" instead of silently assuming.
 */
export async function serializeForPrompt(userMessage: string, limit = 10): Promise<string> {
  const mems = await getForDecisionHybrid(userMessage, limit);
  if (mems.length === 0) return "No memory data yet.";
  return mems.map(m => {
    const score = m.relevanceScore ? ` [relevance: ${m.relevanceScore.toFixed(3)}]` : "";
    return `${formatTemporalLabel(m)} ${m.title}: ${m.content}${score}`;
  }).join("\n");
}

/** Format a memory's temporal scope for LLM consumption.
 *  Choices:
 *   - episodic events → single date label (one moment in time)
 *   - semantic/working with valid_to → expired range
 *   - semantic/working without valid_to → still-valid range
 *   - missing both → fall back to type label only
 */
function formatTemporalLabel(m: MemoryRecord): string {
  const validFrom = m.validFrom ? toShortDate(m.validFrom) : null;
  const validTo = m.validTo ? toShortDate(m.validTo) : null;

  // Episodic memories represent a single happened-event, not an ongoing fact —
  // a single date label is more honest than a "valid range"
  if (m.type === "episodic" && validFrom) {
    return `[episodic · ${validFrom}]`;
  }

  if (validFrom && validTo) {
    return `[${m.type} · valid ${validFrom} → ${validTo}]`;
  }
  if (validFrom) {
    return `[${m.type} · valid ${validFrom} → now]`;
  }
  return `[${m.type}]`;
}

function toShortDate(s: string): string {
  // SQLite stores "YYYY-MM-DD HH:MM:SS"; ISO uses "YYYY-MM-DDTHH:MM:SSZ".
  // Both have the date in chars 0-10. Robust to either.
  return s.slice(0, 10);
}

/** Serialize Twin priors for prompt injection. */
export function serializeTwinForPrompt(): string {
  const priors = getTwinPriors();
  if (priors.length === 0) return "No behavioral insights yet.";
  return priors.map(p => `${p.category} (${Math.round(p.confidence * 100)}% confidence): ${p.insight}`).join("\n");
}

// ── Write operations ────────────────────────────────────────────────────────

/**
 * Memory relevance filter (Mem0-inspired).
 * Decides if content is worth persisting. Prevents memory bloat.
 * Returns adjusted confidence, or null if not worth storing.
 */
function assessRelevance(opts: { title: string; content: string; tags: string[]; type: MemoryClass }): number | null {
  const text = `${opts.title} ${opts.content}`.toLowerCase();

  // Skip pure greetings/acknowledgments
  if (text.length < 20 && /^(hi|hello|hey|thanks|ok|sure|got it|cool|nice|great|yes|no)\b/.test(text)) {
    return null;
  }

  // Skip near-duplicates (same title in last 24h)
  const recent = db.prepare(
    "SELECT id FROM memories WHERE user_id=? AND title=? AND created_at >= datetime('now', '-24 hours')"
  ).get(DEFAULT_USER_ID, opts.title) as any;
  if (recent) return null;

  // Boost: mentions graph nodes
  const nodeLabels = db.prepare(
    "SELECT label FROM graph_nodes WHERE user_id=? LIMIT 50"
  ).all(DEFAULT_USER_ID) as any[];
  const mentionsNode = nodeLabels.some((n: any) => {
    const name = n.label.split(/[\s(]/)[0].toLowerCase();
    return name.length >= 3 && text.includes(name);
  });

  // Boost: decision-related content
  const isDecision = /\b(should|decide|prioritize|choice|trade-?off|risk|deadline|urgent|important)\b/.test(text);

  // Boost: has meaningful tags
  const hasTags = opts.tags.length > 0 && !opts.tags.every(t => t === "general");

  // Calculate adjusted confidence
  let confidence = 0.7; // base
  if (mentionsNode) confidence += 0.15;
  if (isDecision) confidence += 0.1;
  if (hasTags) confidence += 0.05;
  if (opts.type === "semantic") confidence = Math.max(confidence, 0.85); // semantic always high

  return Math.min(1.0, confidence);
}

export function writeMemory(opts: {
  type: MemoryClass;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
}): string {
  // Mem0-inspired relevance check — skip low-value content
  const adjustedConfidence = assessRelevance(opts);
  if (adjustedConfidence === null) {
    return ""; // not worth storing
  }

  const id = nanoid();
  db.prepare(
    "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, opts.type, opts.title, opts.content, JSON.stringify(opts.tags), opts.source, adjustedConfidence);

  // Fire-and-forget: embed for semantic search. Never blocks the write path.
  // Silently no-op if embedding provider unavailable (autoEmbed handles).
  import("../infra/rag/index.js")
    .then(m => m.autoEmbed(id, `${opts.title}: ${opts.content}`))
    .catch(() => {});

  return id;
}

export function writeTwinInsight(opts: { category: string; insight: string; confidence: number }): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, opts.category, opts.insight, opts.confidence);
  return id;
}

// ── Lifecycle operations (called by L4 Orchestration cron) ──────────────────

/** Clean up expired working memory (TTL = 7 days). */
export function expireWorkingMemory(): number {
  const ttl = MEMORY_CLASSES.working.ttlDays ?? 7;
  const result = db.prepare(
    `DELETE FROM memories WHERE user_id=? AND type='working' AND julianday('now') - julianday(created_at) > ?`
  ).run(DEFAULT_USER_ID, ttl);
  return result.changes;
}

/** Promote recurring episodic patterns to semantic memory.
 *  If the same topic appears 3+ times in episodic, create a semantic summary. */
export function promoteRecurringPatterns(): number {
  // Find tags that appear 3+ times in episodic memories
  const recurring = db.prepare(`
    SELECT tags, COUNT(*) as cnt FROM memories
    WHERE user_id=? AND type='episodic'
    GROUP BY tags HAVING cnt >= 3
    ORDER BY cnt DESC LIMIT 5
  `).all(DEFAULT_USER_ID) as any[];

  let promoted = 0;
  for (const row of recurring) {
    const tags = safeParseTags(row.tags);
    if (tags.length === 0) continue;
    const tagStr = tags.join(", ");

    // Check if we already promoted this pattern
    const existing = db.prepare(
      "SELECT id FROM memories WHERE user_id=? AND type='semantic' AND title LIKE ?"
    ).get(DEFAULT_USER_ID, `%Recurring: ${tagStr.slice(0, 30)}%`);
    if (existing) continue;

    // Get the episodic memories for context
    const episodes = db.prepare(
      "SELECT content FROM memories WHERE user_id=? AND type='episodic' AND tags=? ORDER BY created_at DESC LIMIT 5"
    ).all(DEFAULT_USER_ID, row.tags) as any[];

    const summary = episodes.map(e => e.content).join(" | ").slice(0, 200);

    writeMemory({
      type: "semantic",
      title: `Recurring: ${tagStr.slice(0, 30)}`,
      content: `Pattern detected across ${row.cnt} episodes: ${summary}`,
      tags: [...tags, "auto-promoted"],
      source: "Memory Promotion",
      confidence: 0.7 + Math.min(0.2, row.cnt * 0.03),
    });
    promoted++;
  }
  return promoted;
}

// ── Route D: For Explanation — why did the system decide this? ──────────────

export function getForExplanation(decisionId: string, limit = 5): MemoryRecord[] {
  // Find memories that were referenced in this decision's context
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND (tags LIKE ? OR content LIKE ?) ORDER BY confidence DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, `%decision%`, `%${decisionId}%`, limit) as any[];
  return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
}

// ── Route E: For Historical — what happened over time? ──────────────────────

export function getHistorical(query: string, daysBack = 30, limit = 20): MemoryRecord[] {
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND created_at >= datetime('now', ? || ' days') AND (content LIKE ? OR title LIKE ?) ORDER BY created_at ASC LIMIT ?"
  ).all(DEFAULT_USER_ID, `-${daysBack}`, `%${query}%`, `%${query}%`, limit) as any[];
  return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
}

// ── Memory invalidation + correction ────────────────────────────────────────

/** Invalidate a memory (mark as unreliable, reduce confidence to 0). */
export function invalidateMemory(memoryId: string, reason: string): void {
  db.prepare("UPDATE memories SET confidence=0, content = content || ' [INVALIDATED: ' || ? || ']' WHERE id=? AND user_id=?")
    .run(reason, memoryId, DEFAULT_USER_ID);
}

/** Correct a memory — update content and mark as corrected. */
export function correctMemory(memoryId: string, newContent: string, correctionSource: string): void {
  db.prepare("UPDATE memories SET content=?, source=?, confidence=0.95 WHERE id=? AND user_id=?")
    .run(`[CORRECTED] ${newContent}`, correctionSource, memoryId, DEFAULT_USER_ID);
}

/** Find and invalidate memories that conflict with a new fact. */
export function resolveConflicts(newFact: string, tags: string[]): number {
  const tagStr = JSON.stringify(tags);
  // Find memories with same tags but contradicting content
  const candidates = db.prepare(
    "SELECT id, content FROM memories WHERE user_id=? AND tags=? AND confidence > 0.3 ORDER BY created_at DESC LIMIT 5"
  ).all(DEFAULT_USER_ID, tagStr) as any[];

  let invalidated = 0;
  for (const c of candidates) {
    // If the old memory's content directly contradicts, invalidate it
    if (c.content.length > 0 && !c.content.includes("[INVALIDATED") && !c.content.includes("[CORRECTED")) {
      invalidateMemory(c.id, `Superseded by: ${newFact.slice(0, 80)}`);
      invalidated++;
    }
  }
  return invalidated;
}

// ── Pre-conversation flush (OpenClaw pattern) ──────────────────────────────

/**
 * When conversation history gets long (8+ turns), summarize older turns
 * into an episodic memory to prevent info loss during context compression.
 */
export function flushConversationToMemory(
  history: { role: string; content: string }[],
  mode: string
): boolean {
  if (history.length < 8) return false;

  // Take the first half of history and summarize
  const halfIdx = Math.floor(history.length / 2);
  const oldTurns = history.slice(0, halfIdx);
  const summary = oldTurns
    .filter(h => h.content.length > 10)
    .map(h => `${h.role}: ${h.content.slice(0, 100)}`)
    .join(" | ")
    .slice(0, 300);

  writeMemory({
    type: "episodic",
    title: `Conversation summary (${mode})`,
    content: summary,
    tags: ["conversation", "flush", mode],
    source: "Pre-compaction Flush",
    confidence: 0.75,
  });
  return true;
}

// ── Periodic nudge (Hermes pattern) ─────────────────────────────────────────

let turnsSinceLastNudge = 0;

/**
 * Every 5 conversation turns, evaluate if there's something worth
 * persisting as a higher-value memory (semantic promotion candidate).
 * Returns a hint to the Decision Agent to include in its response.
 */
export function checkPeriodicNudge(): string | null {
  turnsSinceLastNudge++;
  if (turnsSinceLastNudge < 5) return null;
  turnsSinceLastNudge = 0;

  // Check if recent episodic memories have a repeating pattern
  const recent = db.prepare(
    "SELECT tags, COUNT(*) as cnt FROM memories WHERE user_id=? AND type='episodic' AND created_at >= datetime('now', '-3 days') GROUP BY tags HAVING cnt >= 2 ORDER BY cnt DESC LIMIT 1"
  ).get(DEFAULT_USER_ID) as any;

  if (recent) {
    let tags: string[];
    try { tags = JSON.parse(recent.tags); } catch { return null; }
    return `[System note: The topic "${tags.join(", ")}" has come up ${recent.cnt} times recently. Consider if this is becoming a pattern worth noting.]`;
  }
  return null;
}

// ── Frozen prompt snapshot (Hermes pattern) ─────────────────────────────────

let frozenSnapshot: string | null = null;
let snapshotTimestamp = 0;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes — refresh after this

/**
 * Returns a frozen memory snapshot for prompt injection.
 * Caches the serialized memory string to enable LLM prefix caching.
 * Only refreshes every 5 minutes.
 */
export async function getFrozenSnapshot(userMessage: string): Promise<string> {
  const now = Date.now();
  if (frozenSnapshot && (now - snapshotTimestamp) < SNAPSHOT_TTL_MS) {
    return frozenSnapshot;
  }
  frozenSnapshot = await serializeForPrompt(userMessage);
  snapshotTimestamp = now;
  return frozenSnapshot;
}

/** Force-refresh the snapshot (call after Dream consolidation or major memory write). */
export function invalidateSnapshot(): void {
  frozenSnapshot = null;
  snapshotTimestamp = 0;
}

// ── Dialectic user modeling (Hermes/Honcho pattern) ─────────────────────────

/**
 * Instead of simple key-value preferences, model the user through
 * the TENSION between their stated preferences and actual behavior.
 * Called by Twin Agent to create richer semantic memories.
 */
export function writeDialecticInsight(opts: {
  stated: string;      // what user says they want
  observed: string;    // what user actually does
  tension: string;     // the gap between them
  resolution?: string; // if resolved, how
}): string {
  return writeMemory({
    type: "semantic",
    title: `Dialectic: ${opts.stated.slice(0, 30)} vs behavior`,
    content: `Stated: ${opts.stated}. Observed: ${opts.observed}. Tension: ${opts.tension}${opts.resolution ? `. Resolution: ${opts.resolution}` : ""}`,
    tags: ["dialectic", "twin", "behavioral-gap"],
    source: "Twin Agent (dialectic)",
    confidence: 0.85,
  });
}

function safeParseTags(raw: string): string[] {
  try { return JSON.parse(raw); } catch { return []; }
}
