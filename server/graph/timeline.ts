/**
 * L1 Human Graph — Timeline.
 *
 * Per-event timestamp store aggregated from unified scan layers. Events
 * link back to graph nodes via related_node_ids so "interactions with X
 * in the last N days" becomes a single query instead of reconstructing
 * from raw scan data every time.
 *
 * Why a separate table instead of graph_nodes/graph_edges?
 * Commits, meetings, and message sessions happen at scale — one graph
 * node per commit would make PageRank meaningless and serializeForPrompt()
 * unusable. Timeline events stay atomic rows; they link UP to stable
 * nodes (projects, persons) rather than becoming nodes themselves.
 *
 * Idempotency: each event has a stable external_id (e.g. "git:<repoPath>:<sha>",
 * "cal:<dedupKey>"). Re-ingesting the same scan is a no-op thanks to
 * UNIQUE(user_id, external_id).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { queryGraph } from "./reader.js";
import { writeContactAggregate } from "./contact-aggregates.js";
import type { MacProfile } from "../integrations/local/deep-scan.js";

// ── Types ────────────────────────────────────────────────────────────────

export type TimelineSource = "git" | "calendar" | "message" | "email" | "task";
export type TimelineKind = "commit" | "meeting" | "chat-session" | "email-sent" | "email-received" | "task-completed";

export interface TimelineEvent {
  id: string;
  externalId: string;
  occurredAt: string;          // ISO
  source: TimelineSource | string;
  kind: TimelineKind | string;
  summary: string;
  detail?: string | null;
  relatedNodeIds: string[];
  metadata?: Record<string, any> | null;
  createdAt: string;
}

export interface TimelineQuery {
  from?: string;                // ISO — inclusive
  to?: string;                  // ISO — exclusive
  source?: TimelineSource | TimelineSource[];
  kind?: TimelineKind | TimelineKind[];
  nodeId?: string;              // only events mentioning this node
  limit?: number;               // default 100, max 500
  order?: "asc" | "desc";
}

// ── Write ────────────────────────────────────────────────────────────────

export interface RecordEventInput {
  externalId: string;
  occurredAt: string;
  source: TimelineSource | string;
  kind: TimelineKind | string;
  summary: string;
  detail?: string;
  relatedNodeIds?: string[];
  metadata?: Record<string, any>;
}

/** Insert or ignore (idempotent via UNIQUE index on user_id, external_id). */
export function recordEvent(input: RecordEventInput): string | null {
  const id = nanoid();
  const result = db.prepare(
    `INSERT OR IGNORE INTO timeline_events
       (id, user_id, external_id, occurred_at, source, kind, summary, detail, related_node_ids, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, DEFAULT_USER_ID, input.externalId, input.occurredAt,
    input.source, input.kind, input.summary, input.detail ?? null,
    JSON.stringify(input.relatedNodeIds ?? []),
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return result.changes > 0 ? id : null;
}

// ── Query ────────────────────────────────────────────────────────────────

export function queryTimeline(q: TimelineQuery = {}): TimelineEvent[] {
  const LIMIT = Math.min(500, Math.max(1, q.limit ?? 100));
  const wheres = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];

  if (q.from) { wheres.push("occurred_at >= ?"); params.push(q.from); }
  if (q.to) { wheres.push("occurred_at < ?"); params.push(q.to); }
  if (q.source) {
    const srcs = Array.isArray(q.source) ? q.source : [q.source];
    wheres.push(`source IN (${srcs.map(() => "?").join(",")})`);
    params.push(...srcs);
  }
  if (q.kind) {
    const kinds = Array.isArray(q.kind) ? q.kind : [q.kind];
    wheres.push(`kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (q.nodeId) {
    // JSON array contains match — SQLite LIKE on the serialized array
    wheres.push(`related_node_ids LIKE ?`);
    params.push(`%"${q.nodeId}"%`);
  }

  const order = q.order === "asc" ? "ASC" : "DESC";
  const rows = db.prepare(
    `SELECT id, external_id as externalId, occurred_at as occurredAt, source, kind,
            summary, detail, related_node_ids as relatedJson, metadata as metaJson,
            created_at as createdAt
     FROM timeline_events WHERE ${wheres.join(" AND ")}
     ORDER BY occurred_at ${order} LIMIT ?`
  ).all(...params, LIMIT) as any[];

  return rows.map(r => ({
    id: r.id,
    externalId: r.externalId,
    occurredAt: r.occurredAt,
    source: r.source,
    kind: r.kind,
    summary: r.summary,
    detail: r.detail,
    relatedNodeIds: safeParseArray(r.relatedJson),
    metadata: r.metaJson ? safeParseObject(r.metaJson) : null,
    createdAt: r.createdAt,
  }));
}

export interface TimelineBucket {
  date: string;                 // YYYY-MM-DD
  total: number;
  bySource: Record<string, number>;
}

/** Day-level aggregation for calendar-heatmap style views. */
export function aggregateTimelineByDay(q: TimelineQuery = {}): TimelineBucket[] {
  const wheres = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];
  if (q.from) { wheres.push("occurred_at >= ?"); params.push(q.from); }
  if (q.to) { wheres.push("occurred_at < ?"); params.push(q.to); }
  if (q.source) {
    const srcs = Array.isArray(q.source) ? q.source : [q.source];
    wheres.push(`source IN (${srcs.map(() => "?").join(",")})`);
    params.push(...srcs);
  }
  if (q.nodeId) { wheres.push(`related_node_ids LIKE ?`); params.push(`%"${q.nodeId}"%`); }

  const rows = db.prepare(
    `SELECT substr(occurred_at, 1, 10) as date, source, COUNT(*) as c
     FROM timeline_events WHERE ${wheres.join(" AND ")}
     GROUP BY date, source ORDER BY date ASC`
  ).all(...params) as any[];

  const byDate = new Map<string, TimelineBucket>();
  for (const r of rows) {
    let b = byDate.get(r.date);
    if (!b) { b = { date: r.date, total: 0, bySource: {} }; byDate.set(r.date, b); }
    b.total += r.c;
    b.bySource[r.source] = (b.bySource[r.source] ?? 0) + r.c;
  }
  return Array.from(byDate.values());
}

// ── Ingest from scan ─────────────────────────────────────────────────────

/**
 * Pull per-event data out of a MacProfile (scan result) and write it to
 * the timeline. Idempotent via external_id. Returns counts by source.
 */
export function ingestTimelineFromScan(profile: MacProfile): {
  calendarAdded: number;
  commitsAdded: number;
  emailsAdded: number;
  messagesAdded: number;
  skipped: number;
} {
  let calendarAdded = 0, commitsAdded = 0, emailsAdded = 0, messagesAdded = 0, skipped = 0;

  // Build a node-lookup so events can link to relevant graph nodes.
  // Projects/goals/persons from graph — fuzzy match by label keywords.
  const allLinkables = queryGraph({ type: ["project", "goal", "person", "identity"], limit: 200 });
  const personLookup = allLinkables.filter(n => n.type === "person");

  // ── Calendar events ────────────────────────────────────────────────
  const calEvents = (profile as any).calendarEvents as Array<any> | undefined;
  if (Array.isArray(calEvents)) {
    for (const e of calEvents) {
      if (!e?.startAt || !e?.summary) continue;
      const externalId = `cal:${e.dedupKey ?? (e.summary + ":" + e.startAt)}`;
      const relatedNodeIds = linkEventToNodes(e.summary + " " + (e.description ?? ""), e.attendees ?? [], allLinkables);
      const added = recordEvent({
        externalId,
        occurredAt: e.startAt,
        source: "calendar",
        kind: "meeting",
        summary: String(e.summary).slice(0, 200),
        detail: [
          e.location ? `Location: ${e.location}` : "",
          e.attendees?.length ? `Attendees: ${e.attendees.slice(0, 8).join(", ")}` : "",
          e.description ? `Desc: ${String(e.description).slice(0, 200)}` : "",
        ].filter(Boolean).join(" | ") || undefined,
        relatedNodeIds,
        metadata: {
          source: e.source,
          durationMinutes: e.durationMinutes,
          calendarName: e.calendarName,
        },
      });
      if (added) calendarAdded++; else skipped++;
    }
  }

  // ── Git commits — re-query per active repo (commit timestamps aren't
  //     stored in the MacProfile, they only aggregate peakHour/peakDay) ──
  const codeUnified = (profile as any).codeUnified as any;
  if (codeUnified?.repos && Array.isArray(codeUnified.repos)) {
    const activeRepos = codeUnified.repos.filter((r: any) => r.state === "active" && r.path);
    for (const repo of activeRepos.slice(0, 10)) {
      const commits = extractRecentCommits(repo.path, repo.name);
      // Map each commit to the matching project node, if any
      const projectNode = findMatchingNode(repo.name, allLinkables.filter(n => n.type === "project" || n.type === "goal"));
      const relatedNodeIds = projectNode ? [projectNode.id] : [];
      for (const c of commits) {
        const added = recordEvent({
          externalId: `git:${repo.path}:${c.sha}`,
          occurredAt: c.date,
          source: "git",
          kind: "commit",
          summary: c.subject.slice(0, 200),
          detail: `repo: ${repo.name}`,
          relatedNodeIds,
          metadata: { repo: repo.name, sha: c.sha },
        });
        if (added) commitsAdded++; else skipped++;
      }
    }
  }

  // ── Email aggregates (topReceivedFrom / topSentTo) ───────────────────
  // EmailUnifiedSummary is an aggregate (count per sender over the scan
  // window), not a per-message stream. Two sinks per entry:
  //   1. timeline_events — human-readable entry linked to a person node
  //   2. contact_aggregates — per-scan snapshot so cooling/warming has
  //      a time-series to diff against prior scans
  const emailUnified = (profile as any).emailUnified as any;
  const emailWindowDays = emailUnified?.inboxLast30d !== undefined ? 30 : 30;
  if (emailUnified?.accessible) {
    for (const side of ["received", "sent"] as const) {
      const list = side === "received" ? emailUnified.topReceivedFrom : emailUnified.topSentTo;
      if (!Array.isArray(list)) continue;
      for (const person of list) {
        const address: string | undefined = person?.address;
        const displayName: string | undefined = person?.displayName;
        const count: number = person?.count ?? 0;
        const lastAt: string | undefined = side === "received" ? person?.lastReceivedAt : person?.lastSentAt;
        if (!address || count === 0 || !lastAt) continue;
        if (person?.isLikelySubscription) continue;
        const matched = matchPerson(displayName, address, personLookup);
        const relatedNodeIds = matched ? [matched.id] : [];
        const added = recordEvent({
          externalId: `mail:${side}:${address}:${lastAt}`,
          occurredAt: lastAt,
          source: "mail",
          kind: side === "received" ? "email-received-aggregate" : "email-sent-aggregate",
          summary: `${count} emails ${side} ${side === "received" ? "from" : "to"} ${displayName ?? address}`,
          detail: `address: ${address}`,
          relatedNodeIds,
          metadata: { address, displayName, count, direction: side },
        });
        if (added) emailsAdded++; else skipped++;

        // Always write the snapshot (not gated on recordEvent — even if the
        // external_id dedup says "already in timeline", we want a fresh
        // snapshot for time-series diff)
        writeContactAggregate({
          contactNodeId: matched?.id,
          contactHandle: address,
          contactDisplayName: displayName,
          source: "mail",
          direction: side,
          countInWindow: count,
          windowDays: emailWindowDays,
          lastAt,
          metadata: { address, displayName },
        });
      }
    }
  }

  // ── iMessage / Messages aggregates (topContacts) ─────────────────────
  const messagesUnified = (profile as any).messagesUnified as any;
  const topContacts: any[] = messagesUnified?.topContacts
    ?? (profile as any).imessage?.topContacts
    ?? [];
  for (const c of topContacts) {
    const handle: string | undefined = c?.handle;
    const displayName: string | undefined = c?.displayName;
    const count: number = c?.messageCount ?? 0;
    const lastAt: string | undefined = c?.lastMessageAt;
    const firstAt: string | undefined = c?.firstMessageAt;
    if (!handle || count === 0 || !lastAt) continue;
    const matched = matchPerson(displayName, handle, personLookup);
    const relatedNodeIds = matched ? [matched.id] : [];
    const added = recordEvent({
      externalId: `msg:${handle}:${lastAt}`,
      occurredAt: lastAt,
      source: "messages",
      kind: "messages-aggregate",
      summary: `${count} messages with ${displayName ?? handle}`,
      detail: `handle: ${handle}`,
      relatedNodeIds,
      metadata: {
        handle, displayName, count,
        sentCount: c.sentCount, receivedCount: c.receivedCount,
        initiationRatio: c.initiationRatio,
      },
    });
    if (added) messagesAdded++; else skipped++;

    writeContactAggregate({
      contactNodeId: matched?.id,
      contactHandle: handle,
      contactDisplayName: displayName,
      source: "messages",
      direction: "both",
      countInWindow: count,
      windowDays: 999,  // iMessage aggregate is full-history by default; distinguishes it from mail 30d window
      firstAt,
      lastAt,
      metadata: {
        sentCount: c.sentCount, receivedCount: c.receivedCount,
        initiationRatio: c.initiationRatio, relationshipStrength: c.relationshipStrength,
      },
    });
  }

  console.log(
    `[Timeline] ingested: calendar=${calendarAdded} commits=${commitsAdded} emails=${emailsAdded} messages=${messagesAdded} skipped (dupes)=${skipped}`
  );
  return { calendarAdded, commitsAdded, emailsAdded, messagesAdded, skipped };
}

/**
 * Match an email address OR display name to a person node.
 *  - First tries displayName fuzzy-containment (both directions: label in name, name in label).
 *  - Falls back to email local-part match (before @).
 * Returns the first matching person node, or null. Deliberately permissive
 * on false positives — Killer Queries tolerate some noise better than
 * systematically missing a quarter of the user's real contacts.
 */
function matchPerson(
  displayName: string | undefined,
  address: string | undefined,
  persons: { id: string; label: string }[],
): { id: string; label: string } | null {
  const addrLocal = address?.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameNorm = displayName?.toLowerCase().replace(/[^a-z\s]/g, "").trim();

  for (const p of persons) {
    const labelNorm = p.label.toLowerCase().replace(/[^a-z\s]/g, "").trim();
    const labelFirstWord = labelNorm.split(/\s+/)[0];
    if (!labelNorm || labelFirstWord.length < 3) continue;

    // Full-name match (either direction)
    if (nameNorm && (labelNorm === nameNorm || (labelNorm.length >= 6 && nameNorm.includes(labelNorm)) || (nameNorm.length >= 6 && labelNorm.includes(nameNorm)))) {
      return p;
    }
    // First-name unique match (e.g., "Harry" in "Harry Qiao")
    if (nameNorm && labelFirstWord.length >= 3 && nameNorm.split(/\s+/)[0] === labelFirstWord) {
      return p;
    }
    // Email local-part match — "harryqiao" contains "harry"
    if (addrLocal && addrLocal.length >= 4 && labelFirstWord.length >= 4 && addrLocal.includes(labelFirstWord)) {
      return p;
    }
  }
  return null;
}

// ── Git extraction ───────────────────────────────────────────────────────

function extractRecentCommits(
  repoPath: string,
  repoName: string,
  sinceDays = 60,
): Array<{ sha: string; date: string; subject: string }> {
  if (!fs.existsSync(path.join(repoPath, ".git"))) return [];
  try {
    // %H = full sha, %cI = committer date ISO 8601 strict, %s = subject
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10);
    // Filter to the user's own commits — without this, cloned research repos
    // pollute the timeline with unrelated activity.
    const authorEmail = safeExec(`git -C "${repoPath}" config user.email`);
    const authorClause = authorEmail ? `--author="${authorEmail}"` : "";
    const out = safeExec(
      `git -C "${repoPath}" log --since="${since}" ${authorClause} --no-merges --pretty=format:'%H|%cI|%s'`,
      { timeout: 10000 },
    );
    if (!out) return [];
    const commits: Array<{ sha: string; date: string; subject: string }> = [];
    for (const line of out.split("\n")) {
      const [sha, date, ...rest] = line.split("|");
      if (!sha || !date) continue;
      commits.push({ sha, date, subject: rest.join("|") || "(no subject)" });
    }
    return commits;
  } catch { return []; }
}

function safeExec(cmd: string, opts: { timeout?: number } = {}): string {
  try {
    return execSync(cmd, {
      timeout: opts.timeout ?? 5000, encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

// ── Node-linking heuristic ───────────────────────────────────────────────

function linkEventToNodes(text: string, attendees: string[], linkables: { id: string; label: string; type: string }[]): string[] {
  const hay = (text + " " + attendees.join(" ")).toLowerCase();
  const ids = new Set<string>();
  for (const n of linkables) {
    const label = n.label.toLowerCase();
    if (label.length < 3) continue;
    // First keyword ≥4 chars or full label (for short labels) must appear
    const key = label.length > 30 ? label.split(/[\s\-]/).find(w => w.length >= 4) ?? label : label;
    if (key && hay.includes(key)) ids.add(n.id);
  }
  return Array.from(ids);
}

function findMatchingNode(
  repoName: string,
  linkables: { id: string; label: string }[],
): { id: string; label: string } | null {
  const repoKey = repoName.toLowerCase().replace(/[-_]/g, "");
  for (const n of linkables) {
    const labelKey = n.label.toLowerCase().replace(/[-_\s]/g, "");
    if (labelKey.includes(repoKey) || repoKey.includes(labelKey.slice(0, 6))) return n;
  }
  return null;
}

// ── JSON helpers ─────────────────────────────────────────────────────────

function safeParseArray(s: string | null): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function safeParseObject(s: string | null): Record<string, any> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ── Rhythm fingerprint — used by Tempo Oracle ─────────────────────────────

export interface RhythmFingerprint {
  windowDays: number;
  totalEvents: number;
  eventsByKind: Record<string, number>;     // e.g. { commit: 51, meeting: 0 }
  peakHour?: number;                         // 0-23
  peakDayOfWeek?: string;                    // "Monday" .. "Sunday"
  topDaysOfWeek: Array<{ day: string; count: number }>;
  hourHistogram: number[];                   // 24 slots
  avgPerWeek: number;
  longestCommitStreakDays: number;           // consecutive days with ≥1 commit
  activeDaysInWindow: number;
  latestEventAt?: string;
  oldestEventAt?: string;
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Compute a rhythm summary over the timeline's recent window. Unlike
 * `codeUnified.peak_hour` (which is pre-aggregated per repo at scan time),
 * this looks at ALL timeline sources (commits + meetings + anything else
 * ingested) in one pass and cites a unified cadence.
 */
export function computeRhythmFingerprint(opts: {
  windowDays?: number;
  source?: TimelineSource | TimelineSource[];
} = {}): RhythmFingerprint {
  const windowDays = opts.windowDays ?? 180;
  const from = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const events = queryTimeline({ from, source: opts.source, limit: 500, order: "asc" });

  const eventsByKind: Record<string, number> = {};
  const hourHistogram = new Array(24).fill(0) as number[];
  const dowHistogram = new Array(7).fill(0) as number[];
  const commitDates = new Set<string>();
  let latestEventAt: string | undefined;
  let oldestEventAt: string | undefined;

  for (const e of events) {
    eventsByKind[e.kind] = (eventsByKind[e.kind] ?? 0) + 1;
    const d = new Date(e.occurredAt);
    if (Number.isNaN(d.getTime())) continue;
    hourHistogram[d.getHours()]++;
    dowHistogram[d.getDay()]++;
    if (e.kind === "commit") commitDates.add(d.toISOString().slice(0, 10));
    if (!latestEventAt || e.occurredAt > latestEventAt) latestEventAt = e.occurredAt;
    if (!oldestEventAt || e.occurredAt < oldestEventAt) oldestEventAt = e.occurredAt;
  }

  const peakHour = events.length > 0 ? argmax(hourHistogram) : undefined;
  const peakDowIdx = events.length > 0 ? argmax(dowHistogram) : -1;
  const peakDayOfWeek = peakDowIdx >= 0 ? DOW_NAMES[peakDowIdx] : undefined;

  const topDaysOfWeek = dowHistogram
    .map((count, i) => ({ day: DOW_NAMES[i], count }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const activeDates = new Set<string>();
  for (const e of events) activeDates.add(new Date(e.occurredAt).toISOString().slice(0, 10));

  const avgPerWeek = events.length > 0 ? +(events.length / (windowDays / 7)).toFixed(1) : 0;
  const longestCommitStreakDays = longestStreak(Array.from(commitDates).sort());

  return {
    windowDays,
    totalEvents: events.length,
    eventsByKind,
    peakHour,
    peakDayOfWeek,
    topDaysOfWeek,
    hourHistogram,
    avgPerWeek,
    longestCommitStreakDays,
    activeDaysInWindow: activeDates.size,
    latestEventAt,
    oldestEventAt,
  };
}

/** Render rhythm fingerprint as a compact text block for Oracle prompts. */
export function rhythmToText(r: RhythmFingerprint): string {
  if (r.totalEvents === 0) return `Rhythm (last ${r.windowDays}d): NO timeline data`;
  const kinds = Object.entries(r.eventsByKind).map(([k, n]) => `${k}=${n}`).join(" ");
  const days = r.topDaysOfWeek.map(d => `${d.day}(${d.count})`).join(" ");
  const lines = [
    `Rhythm (last ${r.windowDays}d, ${r.totalEvents} events · ${kinds}):`,
    `  peak hour: ${r.peakHour !== undefined ? r.peakHour + ":00" : "—"}; peak day: ${r.peakDayOfWeek ?? "—"}`,
    `  top days of week: ${days || "—"}`,
    `  ${r.avgPerWeek}/week avg, active on ${r.activeDaysInWindow}/${r.windowDays} days, longest commit streak: ${r.longestCommitStreakDays} days`,
    r.latestEventAt ? `  most recent: ${r.latestEventAt.slice(0, 16).replace("T", " ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function argmax(arr: number[]): number {
  let maxI = 0, maxV = -1;
  for (let i = 0; i < arr.length; i++) if (arr[i] > maxV) { maxV = arr[i]; maxI = i; }
  return maxI;
}

function longestStreak(sortedDates: string[]): number {
  if (sortedDates.length === 0) return 0;
  let best = 1, cur = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]).getTime();
    const next = new Date(sortedDates[i]).getTime();
    if (next - prev === 86400_000) { cur++; best = Math.max(best, cur); }
    else if (next - prev > 86400_000) cur = 1;
  }
  return best;
}

// ── Render for diagnostics ───────────────────────────────────────────────

export function timelineToText(events: TimelineEvent[], opts?: { maxLines?: number }): string {
  const max = opts?.maxLines ?? 40;
  if (events.length === 0) return "TIMELINE: (empty)";
  const lines: string[] = ["TIMELINE:"];
  for (const e of events.slice(0, max)) {
    const when = e.occurredAt.slice(0, 16).replace("T", " ");
    lines.push(`  ${when} [${e.source}/${e.kind}] ${e.summary.slice(0, 80)}`);
  }
  if (events.length > max) lines.push(`  … ${events.length - max} more events`);
  return lines.join("\n");
}
