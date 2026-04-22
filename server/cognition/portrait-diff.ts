/**
 * Portrait Diff — compare two versions of the user's portrait and produce
 * a "what changed about you" narrative. Fuel for retention features.
 *
 * Intended trigger: monthly cron. Persisted as a `portrait_diff` row.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { text } from "../infra/compute/index.js";
import { type PortraitV1 } from "./oracle-council.js";

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portrait_diffs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_version INTEGER,
      to_version INTEGER,
      narrative TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch {}

function getPortraitByVersion(userId: string, version: number): PortraitV1 | null {
  const row = db.prepare("SELECT data_json FROM portraits WHERE user_id=? AND version=?").get(userId, version) as any;
  if (!row) return null;
  try { return JSON.parse(row.data_json); } catch { return null; }
}

export async function generatePortraitDiff(userId = DEFAULT_USER_ID): Promise<string | null> {
  // Latest two versions
  const rows = db.prepare(
    "SELECT version FROM portraits WHERE user_id=? ORDER BY version DESC LIMIT 2"
  ).all(userId) as any[];
  if (rows.length < 2) return null;

  const [toV, fromV] = rows;
  const toP = getPortraitByVersion(userId, toV.version);
  const fromP = getPortraitByVersion(userId, fromV.version);
  if (!toP || !fromP) return null;

  const system = `You compare two versions of a user's AI-generated portrait and write a short "what changed about you" note IN SECOND PERSON addressed to the user. 3-5 sentences. Focus on REAL changes (new identity facets, resolved tensions, shifted interests, new relationships, dropped hypotheses). Do NOT invent changes that the evidence doesn't support. If very little changed, say so plainly.`;

  const user = `FROM (v${fromV.version}, ${(fromP as any).generatedAt?.slice?.(0, 10) ?? ""}):
Headline: ${fromP.compass.headline}
Paragraph: ${fromP.compass.paragraph}

TO (v${toV.version}, ${(toP as any).generatedAt?.slice?.(0, 10) ?? ""}):
Headline: ${toP.compass.headline}
Paragraph: ${toP.compass.paragraph}

Produce the diff narrative now.`;

  const narrative = await text({
    task: "decision",
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: 500,
    agentName: "Portrait Diff",
  });

  const { nanoid } = await import("nanoid");
  const id = nanoid();
  db.prepare(
    "INSERT INTO portrait_diffs (id, user_id, from_version, to_version, narrative) VALUES (?,?,?,?,?)"
  ).run(id, userId, fromV.version, toV.version, narrative);

  return narrative;
}

export function getLatestPortraitDiff(userId = DEFAULT_USER_ID): { narrative: string; from_version: number; to_version: number; created_at: string } | null {
  return db.prepare(
    "SELECT narrative, from_version, to_version, created_at FROM portrait_diffs WHERE user_id=? ORDER BY created_at DESC LIMIT 1"
  ).get(userId) as any;
}
