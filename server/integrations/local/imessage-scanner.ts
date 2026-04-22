/**
 * iMessage Scanner — reads ~/Library/Messages/chat.db to extract REAL
 * relationship strength (per-contact message counts + patterns).
 *
 * Why this matters commercially:
 *   Contacts tells you WHO, calendar tells you WHEN you meet, but iMessage
 *   tells you WHO MATTERS. A Contacts list of 500 people means nothing if
 *   you only actually text 12 of them. Anchor's "knows your relationships"
 *   moat lives here.
 *
 * We NEVER store or transmit message CONTENT. We only count:
 *   - total messages per contact (sent + received separately)
 *   - first / last message dates per contact
 *   - hourly distribution (late-night texts = close relationships)
 *   - reply-initiation asymmetry (who starts, who reciprocates)
 *
 * Requires Full Disk Access. The code handles FDDA denial gracefully: scanner
 * returns an empty summary with a "needs-fdda" signal so downstream prompts
 * can ask user to grant access.
 */
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

const CHAT_DB = path.join(os.homedir(), "Library/Messages/chat.db");

// Apple CFAbsoluteTime epoch = 2001-01-01 UTC, unix epoch = 1970-01-01 UTC
const APPLE_EPOCH_OFFSET = 978307200; // seconds between the two

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatContact {
  handle: string;                 // email or phone number (raw)
  displayName?: string;           // resolved from Contacts later
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  firstMessageAt: string;         // ISO
  lastMessageAt: string;          // ISO
  relationshipStrength: number;   // 0-100 composite score
  initiationRatio: number;        // sent / total (0 = all received, 1 = all sent)
  peakHour: number;               // 0-23
  lateNightCount: number;         // messages between 11pm-4am
}

export interface ChatSummary {
  accessible: boolean;
  reason?: string;                // if not accessible, why
  totalMessages: number;
  uniqueContacts: number;
  topContacts: ChatContact[];     // top 20 by messageCount
  dateRangeStart: string;
  dateRangeEnd: string;
  totalSentCount: number;
  totalReceivedCount: number;
  sentReceivedRatio: number;      // tells us if user initiates or responds
  hourlyDistribution: number[];   // length 24
  signals: ChatSignal[];
}

export interface ChatSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Date conversion ──────────────────────────────────────────────────────

/** Apple's date col may be seconds or nanoseconds since 2001-01-01 UTC. */
function appleDateToUnixMs(v: number): number {
  if (!v) return 0;
  // Heuristic: values > 10^15 are nanoseconds, else seconds
  if (v > 1e15) {
    return Math.round(v / 1e6) + APPLE_EPOCH_OFFSET * 1000;
  }
  return (v + APPLE_EPOCH_OFFSET) * 1000;
}

function appleDateToIso(v: number): string {
  const ms = appleDateToUnixMs(v);
  return ms ? new Date(ms).toISOString() : "";
}

// ── Relationship strength scoring ────────────────────────────────────────

/** Composite score 0-100 from message volume, recency, and balance. */
function computeStrength(messageCount: number, sentCount: number, lastAtMs: number, totalMaxMessages: number): number {
  const volumeScore = Math.min(50, (messageCount / Math.max(10, totalMaxMessages)) * 50);
  // Recency: recent = higher. Scored out of 30
  const daysAgo = lastAtMs ? (Date.now() - lastAtMs) / 86400_000 : 999;
  const recencyScore = daysAgo < 7 ? 30 : daysAgo < 30 ? 22 : daysAgo < 90 ? 12 : daysAgo < 365 ? 5 : 0;
  // Balance: 40-60% sent ratio = ideal close relationship; extremes = one-sided
  const sentRatio = messageCount > 0 ? sentCount / messageCount : 0;
  const balanceScore = (1 - Math.abs(sentRatio - 0.5) * 2) * 20;   // 0 at 0% or 100%, 20 at 50%
  return Math.round(volumeScore + recencyScore + balanceScore);
}

// ── Main ──────────────────────────────────────────────────────────────────

export function scanIMessage(sinceDaysAgo = 90): ChatSummary {
  const empty: ChatSummary = {
    accessible: false,
    totalMessages: 0, uniqueContacts: 0, topContacts: [],
    dateRangeStart: "", dateRangeEnd: "",
    totalSentCount: 0, totalReceivedCount: 0, sentReceivedRatio: 0,
    hourlyDistribution: new Array(24).fill(0),
    signals: [],
  };

  if (!fs.existsSync(CHAT_DB)) {
    return { ...empty, reason: "Messages.app DB not found (user may not use iMessage on this Mac)" };
  }

  // Try to copy + open — if FDDA not granted this will throw
  const tmpPath = path.join(os.tmpdir(), `anchor_chat_${Date.now()}.db`);
  let db: Database.Database;
  try {
    fs.copyFileSync(CHAT_DB, tmpPath);
    db = new Database(tmpPath, { readonly: true, fileMustExist: true });
  } catch (err: any) {
    const needsFdda = /operation not permitted|EACCES|EPERM/i.test(err.message ?? "");
    return {
      ...empty,
      reason: needsFdda
        ? "Full Disk Access not granted to this process — grant in System Settings > Privacy & Security > Full Disk Access"
        : `Could not open chat.db: ${err.message?.slice(0, 200)}`,
      signals: [{
        name: "imessage-needs-fdda",
        strength: "strong",
        evidence: needsFdda ? "Full Disk Access missing" : "DB copy/open failed",
      }],
    };
  }

  try {
    // WAL mode may have recent messages in .wal — also copy if exists
    for (const ext of ["-wal", "-shm"]) {
      const src = CHAT_DB + ext;
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, tmpPath + ext); } catch {}
      }
    }

    const sinceUnixSec = (Date.now() - sinceDaysAgo * 86400_000) / 1000;
    // Convert unix seconds → apple seconds (for older chat.db format)
    const sinceAppleSec = sinceUnixSec - APPLE_EPOCH_OFFSET;
    // Newer chat.db uses nanoseconds; query handles both by OR-ing ranges
    const sinceAppleNs = sinceAppleSec * 1e9;

    interface Row {
      handle: string;
      msg_count: number;
      sent_count: number;
      first_date: number;
      last_date: number;
    }

    // Group by handle. is_from_me=1 means sent by user.
    const rows = db.prepare(`
      SELECT
        h.id AS handle,
        COUNT(*) AS msg_count,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sent_count,
        MIN(m.date) AS first_date,
        MAX(m.date) AS last_date
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE (m.date >= ? OR m.date >= ?) AND h.id IS NOT NULL
      GROUP BY h.id
      ORDER BY msg_count DESC
      LIMIT 200
    `).all(sinceAppleSec, sinceAppleNs) as Row[];

    if (rows.length === 0) {
      db.close();
      fs.unlinkSync(tmpPath);
      return { ...empty, accessible: true, reason: "DB opened but no messages in range" };
    }

    // Per-contact hour distribution — separate query to avoid GROUP BY complexity
    const hourStmt = db.prepare(`
      SELECT
        h.id AS handle,
        CAST(strftime('%H', datetime(m.date / CASE WHEN m.date > 1e15 THEN 1e9 ELSE 1 END + 978307200, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
        COUNT(*) AS cnt
      FROM message m
      JOIN handle h ON m.handle_id = h.ROWID
      WHERE (m.date >= ? OR m.date >= ?)
      GROUP BY h.id, hour
    `);
    const hourRows = hourStmt.all(sinceAppleSec, sinceAppleNs) as { handle: string; hour: number; cnt: number }[];

    // Build per-contact hour map
    const contactHours = new Map<string, Map<number, number>>();
    for (const r of hourRows) {
      if (!contactHours.has(r.handle)) contactHours.set(r.handle, new Map());
      contactHours.get(r.handle)!.set(r.hour, r.cnt);
    }

    // Global hourly distribution
    const hourlyDistribution = new Array(24).fill(0);
    for (const r of hourRows) hourlyDistribution[r.hour] += r.cnt;

    // Compose contacts
    const maxMsgCount = rows[0]?.msg_count ?? 0;
    const contacts: ChatContact[] = rows.map((r) => {
      const hours = contactHours.get(r.handle) ?? new Map();
      let peakHour = 0, peakCount = 0, lateNight = 0;
      hours.forEach((cnt, h) => {
        if (cnt > peakCount) { peakCount = cnt; peakHour = h; }
        if (h >= 23 || h < 4) lateNight += cnt;
      });
      const firstMs = appleDateToUnixMs(r.first_date);
      const lastMs = appleDateToUnixMs(r.last_date);
      const strength = computeStrength(r.msg_count, r.sent_count, lastMs, maxMsgCount);
      return {
        handle: r.handle,
        messageCount: r.msg_count,
        sentCount: r.sent_count,
        receivedCount: r.msg_count - r.sent_count,
        firstMessageAt: firstMs ? new Date(firstMs).toISOString() : "",
        lastMessageAt: lastMs ? new Date(lastMs).toISOString() : "",
        relationshipStrength: strength,
        initiationRatio: r.msg_count > 0 ? r.sent_count / r.msg_count : 0,
        peakHour,
        lateNightCount: lateNight,
      };
    });

    const totalMessages = rows.reduce((s, r) => s + r.msg_count, 0);
    const totalSent = rows.reduce((s, r) => s + r.sent_count, 0);
    const totalRecv = totalMessages - totalSent;
    const sentReceivedRatio = totalMessages > 0 ? totalSent / totalMessages : 0;

    // Derive signals
    const signals: ChatSignal[] = [];
    if (totalMessages >= 1000) signals.push({ name: "high-volume-imessage-user", strength: "strong", evidence: `${totalMessages} messages in ${sinceDaysAgo}d` });
    else if (totalMessages >= 200) signals.push({ name: "regular-imessage-user", strength: "medium", evidence: `${totalMessages} messages in ${sinceDaysAgo}d` });
    else if (totalMessages < 50) signals.push({ name: "minimal-imessage-user", strength: "medium", evidence: `only ${totalMessages} messages in ${sinceDaysAgo}d (may use WeChat/WhatsApp primarily)` });

    if (sentReceivedRatio > 0.65) signals.push({ name: "conversation-initiator", strength: "medium", evidence: `${Math.round(sentReceivedRatio * 100)}% of messages sent by user` });
    else if (sentReceivedRatio < 0.35) signals.push({ name: "conversation-responder", strength: "medium", evidence: `${Math.round(sentReceivedRatio * 100)}% sent by user — mostly responds` });

    // Close relationships signal: any contact with >100 msgs in range
    const veryClose = contacts.filter(c => c.messageCount >= 100).length;
    if (veryClose >= 5) signals.push({ name: "wide-close-network", strength: "strong", evidence: `${veryClose} contacts with 100+ messages` });
    else if (veryClose >= 2) signals.push({ name: "tight-inner-circle", strength: "medium", evidence: `${veryClose} deeply-active contacts` });

    // Late-night signal
    const totalLate = contacts.reduce((s, c) => s + c.lateNightCount, 0);
    if (totalLate >= 50) signals.push({ name: "late-night-texter", strength: "medium", evidence: `${totalLate} messages between 11pm-4am` });

    // Peak-hour lifestyle signal
    const peakGlobal = hourlyDistribution.indexOf(Math.max(...hourlyDistribution));
    if (peakGlobal >= 22 || peakGlobal < 4) signals.push({ name: "late-night-chat-peak", strength: "medium", evidence: `Peak chat hour: ${peakGlobal}:00` });

    db.close();
    fs.unlinkSync(tmpPath);

    const dateStart = contacts.reduce((min, c) => c.firstMessageAt && (!min || c.firstMessageAt < min) ? c.firstMessageAt : min, "");
    const dateEnd = contacts.reduce((max, c) => c.lastMessageAt && c.lastMessageAt > max ? c.lastMessageAt : max, "");

    return {
      accessible: true,
      totalMessages,
      uniqueContacts: rows.length,
      topContacts: contacts.slice(0, 20),
      dateRangeStart: dateStart,
      dateRangeEnd: dateEnd,
      totalSentCount: totalSent,
      totalReceivedCount: totalRecv,
      sentReceivedRatio: Math.round(sentReceivedRatio * 100) / 100,
      hourlyDistribution,
      signals,
    };
  } catch (err: any) {
    try { db.close(); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ...empty, reason: `Query failed: ${err.message?.slice(0, 200)}` };
  }
}

// ── Render for profile text ──────────────────────────────────────────────

export function chatSummaryToText(summary: ChatSummary): string {
  const lines: string[] = [];
  lines.push("iMESSAGE RELATIONSHIP SUMMARY:");
  if (!summary.accessible) {
    lines.push(`  Status: not accessible. ${summary.reason ?? ""}`);
    if (summary.signals.length > 0) {
      for (const s of summary.signals) lines.push(`    [${s.strength}] ${s.name} — ${s.evidence}`);
    }
    return lines.join("\n");
  }
  if (summary.totalMessages === 0) {
    lines.push("  No iMessage history in the selected window.");
    return lines.join("\n");
  }
  lines.push(`  Total messages: ${summary.totalMessages} across ${summary.uniqueContacts} contacts (${summary.dateRangeStart.slice(0, 10)} → ${summary.dateRangeEnd.slice(0, 10)})`);
  lines.push(`  Sent by user: ${summary.totalSentCount} (${Math.round(summary.sentReceivedRatio * 100)}%) — Received: ${summary.totalReceivedCount}`);

  if (summary.topContacts.length > 0) {
    lines.push("  Top relationships by message volume:");
    for (const c of summary.topContacts.slice(0, 10)) {
      const handle = c.handle.length > 40 ? c.handle.slice(0, 40) + "..." : c.handle;
      lines.push(`    [${String(c.relationshipStrength).padStart(3)}] ${handle.padEnd(42)} · ${c.messageCount} msgs (${Math.round(c.initiationRatio * 100)}% sent) · peak ${c.peakHour}:00${c.lateNightCount > 5 ? ` · ${c.lateNightCount} late-night` : ""}`);
    }
  }

  // Peak hour
  const peakGlobal = summary.hourlyDistribution.indexOf(Math.max(...summary.hourlyDistribution));
  lines.push(`  Peak chat hour (all contacts): ${peakGlobal}:00`);

  if (summary.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const s of summary.signals) lines.push(`    [${s.strength}] ${s.name} — ${s.evidence}`);
  }
  return lines.join("\n");
}
