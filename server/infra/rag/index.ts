/**
 * L8 Infrastructure — RAG (Retrieval-Augmented Generation).
 *
 * Adds semantic search to L2 Memory by computing and storing
 * vector embeddings for every memory entry.
 *
 * Architecture:
 *   Write path: writeMemory → also compute embedding → store in embeddings table
 *   Read path: query text → embed → KNN search → return ranked memories
 *
 * Uses L8 compute layer's embed() function for model-agnostic embeddings.
 * Storage: SQLite embeddings table (can upgrade to sqlite-vec for true KNN).
 * Fallback: if no embedding model available, falls back to FTS5 keyword search.
 */
import { db, DEFAULT_USER_ID } from "../storage/db.js";
import { nanoid } from "nanoid";

// ── Embedding storage ───────────────────────────────────────────────────────

// Ensure embeddings table exists
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
  `);
} catch {}

/** Store an embedding for a memory. */
export function storeEmbedding(memoryId: string, embedding: number[], modelId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?,?,?)"
  ).run(memoryId, JSON.stringify(embedding), modelId);
}

/** Get embedding for a memory. */
export function getEmbedding(memoryId: string): number[] | null {
  const row = db.prepare("SELECT embedding FROM memory_embeddings WHERE memory_id=?").get(memoryId) as any;
  if (!row) return null;
  try { return JSON.parse(row.embedding); } catch { return null; }
}

// ── Cosine similarity ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Semantic search ─────────────────────────────────────────────────────────

/**
 * Search memories by semantic similarity.
 * 1. Embed the query using L8 compute
 * 2. Compare against all stored embeddings
 * 3. Return top-K most similar memories
 *
 * Falls back to FTS5 if embeddings not available.
 */
export async function semanticSearch(
  queryEmbedding: number[],
  limit = 10
): Promise<{ memoryId: string; similarity: number }[]> {
  const rows = db.prepare(
    "SELECT memory_id, embedding FROM memory_embeddings"
  ).all() as any[];

  if (rows.length === 0) return [];

  const scored = rows.map(row => {
    let emb: number[];
    try { emb = JSON.parse(row.embedding); } catch { return null; }
    return {
      memoryId: row.memory_id as string,
      similarity: cosineSimilarity(queryEmbedding, emb),
    };
  }).filter(Boolean) as { memoryId: string; similarity: number }[];

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Concurrency limiter for embedding calls. Dream cycles and cron jobs can
 * writeMemory() in tight loops (10-100 writes/second); without a gate we'd
 * fan out 100 concurrent HTTP calls to the embedding provider, triggering
 * rate limits or 429s and possibly incurring billing spikes. Cap at 2 in
 * flight; any overflow queues.
 */
const EMBED_MAX_CONCURRENT = 2;
let embedInFlight = 0;
const embedWaitQueue: (() => void)[] = [];

function acquireEmbedSlot(): Promise<void> {
  if (embedInFlight < EMBED_MAX_CONCURRENT) {
    embedInFlight++;
    return Promise.resolve();
  }
  return new Promise(resolve => embedWaitQueue.push(resolve));
}

function releaseEmbedSlot(): void {
  const next = embedWaitQueue.shift();
  if (next) next();
  else embedInFlight--;
}

/**
 * Auto-embed a memory on write.
 * Called after writeMemory() — non-blocking, fire-and-forget, rate-limited.
 */
export async function autoEmbed(memoryId: string, content: string): Promise<void> {
  await acquireEmbedSlot();
  try {
    const { embed } = await import("../compute/index.js");
    const embeddings = await embed({ text: content });
    if (embeddings && embeddings[0]) {
      storeEmbedding(memoryId, embeddings[0], "auto");
    }
  } catch {
    // Embedding model not available — silently skip. FTS5 keyword search
    // remains as fallback.
  } finally {
    releaseEmbedSlot();
  }
}

// ── RAG pipeline: embed query → search → return enriched context ────────────

export async function ragRetrieve(
  query: string,
  limit = 8
): Promise<{ id: string; content: string; similarity: number }[]> {
  try {
    const { embed } = await import("../compute/index.js");
    const queryEmb = await embed({ text: query });
    if (!queryEmb || !queryEmb[0]) return [];

    const results = await semanticSearch(queryEmb[0], limit);
    if (results.length === 0) return [];

    // Single batch fetch — avoids N+1 (previously: one SELECT per result)
    const ids = results.map(r => r.memoryId);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, title, content FROM memories WHERE id IN (${placeholders})`
    ).all(...ids) as any[];
    const byId = new Map(rows.map(r => [r.id, r]));

    return results
      .map(r => {
        const mem = byId.get(r.memoryId);
        if (!mem) return null;
        return { id: mem.id, content: `${mem.title}: ${mem.content}`, similarity: r.similarity };
      })
      .filter((x): x is { id: string; content: string; similarity: number } => x !== null);
  } catch {
    return []; // No embedding model → empty RAG results, L2 FTS5 still works
  }
}

/** Status for admin. */
export function getRAGStatus() {
  const embCount = (db.prepare("SELECT COUNT(*) as c FROM memory_embeddings").get() as any)?.c ?? 0;
  const memCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  return {
    totalEmbeddings: embCount,
    totalMemories: memCount,
    coverage: memCount > 0 ? Math.round((embCount / memCount) * 100) : 0,
  };
}
