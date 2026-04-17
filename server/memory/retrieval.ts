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
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 100"
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

  return scored;
}

/**
 * Route B: For Execution Agent — recent episodic + working context.
 */
export function getForExecution(limit = 8): MemoryRecord[] {
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND type IN ('working','episodic') ORDER BY created_at DESC LIMIT ?"
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

/** Search memories by content (keyword match). */
export function searchMemories(query: string, limit = 20): MemoryRecord[] {
  const rows = db.prepare(
    "SELECT id, type, title, content, tags, source, confidence, created_at as createdAt FROM memories WHERE user_id=? AND (content LIKE ? OR title LIKE ?) ORDER BY created_at DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, `%${query}%`, `%${query}%`, limit) as any[];
  return rows.map(r => ({ ...r, tags: safeParseTags(r.tags) }));
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
 * Takes the user's actual message and returns the most relevant memories.
 */
export function serializeForPrompt(userMessage: string, limit = 10): string {
  const mems = getForDecision(userMessage, limit);
  if (mems.length === 0) return "No memory data yet.";
  return mems.map(m => {
    const score = m.relevanceScore ? ` [relevance: ${m.relevanceScore.toFixed(2)}]` : "";
    return `[${m.type}] ${m.title}: ${m.content}${score}`;
  }).join("\n");
}

/** Serialize Twin priors for prompt injection. */
export function serializeTwinForPrompt(): string {
  const priors = getTwinPriors();
  if (priors.length === 0) return "No behavioral insights yet.";
  return priors.map(p => `${p.category} (${Math.round(p.confidence * 100)}% confidence): ${p.insight}`).join("\n");
}

// ── Write operations ────────────────────────────────────────────────────────

export function writeMemory(opts: {
  type: MemoryClass;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
}): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, opts.type, opts.title, opts.content, JSON.stringify(opts.tags), opts.source, opts.confidence);
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

function safeParseTags(raw: string): string[] {
  try { return JSON.parse(raw); } catch { return []; }
}
