/**
 * Messages Unification — one view of "who you actually talk to" across
 * iMessage, WeChat, Telegram, Slack, WhatsApp, Signal, Discord, Line, Kakao.
 *
 * Reality check: most chat apps on macOS store messages encrypted or in
 * proprietary binary formats that can't be parsed without reverse-engineering
 * their client code. We're honest about this. Data sources by tier:
 *
 *   Tier A (full content):     iMessage (chat.db, FDDA)
 *   Tier B (structured API):   Slack (OAuth), Telegram (optional)
 *   Tier C (frequency proxy):  activity_captures rows for comms-* apps
 *   Tier D (presence only):    WeChat, WhatsApp, Signal, Discord
 *
 * Entity resolution: iMessage hands are emails/phones; Slack handles are
 * usernames. We try fuzzy match on display name + email overlap to merge
 * same-person-across-apps. Conservative — when in doubt, keep separate.
 */
import { db, DEFAULT_USER_ID } from "../../infra/storage/db.js";
import { findApp } from "./app-registry.js";
import { scanIMessage, type ChatSummary, type ChatContact } from "./imessage-scanner.js";
import { getTokens } from "../token-store.js";
import { shadowEmit } from "../../infra/storage/scanner-events.js";

export type MessagesTier = "full-content" | "api" | "frequency-proxy" | "presence-only";

export interface ChatAppStatus {
  appId: string;
  displayName: string;
  installed: boolean;
  active: boolean;
  tier: MessagesTier;
  messageCount?: number;         // if tier A or B — actual msgs in last 30d
  activitySessionCount?: number; // if tier C — number of captured sessions
  lastActivityAt?: string;
  peakHour?: number;
}

export interface UnifiedContact {
  displayName: string;
  handles: string[];               // iMessage: email/phone; Slack: userId/name
  sources: string[];               // "imessage", "slack", etc
  totalMessages: number;
  crossAppMatched: boolean;
  strength: number;                // 0-100
  evidence: string[];
}

export interface MessagesUnifiedSummary {
  apps: ChatAppStatus[];
  totalAppsInstalled: number;
  totalAppsActive: number;
  primaryChat: string;             // app id
  primaryChatDominance: number;    // 0-1 share of total activity
  topContacts: UnifiedContact[];
  crossAppMatches: number;
  signals: UnifiedMessagesSignal[];
  coverage: string;
}

export interface UnifiedMessagesSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Chat app catalog (subset of app-registry focused on comms) ───────────

const TRACKED_CHAT_APPS: { id: string; name: string; activityNames: string[] }[] = [
  { id: "imessage",  name: "iMessage",  activityNames: ["Messages"] },
  { id: "wechat",    name: "WeChat",    activityNames: ["WeChat"] },
  { id: "telegram",  name: "Telegram",  activityNames: ["Telegram"] },
  { id: "whatsapp",  name: "WhatsApp",  activityNames: ["WhatsApp"] },
  { id: "signal",    name: "Signal",    activityNames: ["Signal"] },
  { id: "discord",   name: "Discord",   activityNames: ["Discord"] },
  { id: "slack",     name: "Slack",     activityNames: ["Slack"] },
  { id: "line",      name: "LINE",      activityNames: ["LINE"] },
  { id: "kakaotalk", name: "KakaoTalk", activityNames: ["KakaoTalk"] },
];

// ── Activity aggregator (Tier C) ─────────────────────────────────────────

interface ActivityStats {
  sessionCount: number;
  lastActivityAt?: string;
  peakHour?: number;
  uniqueWindowTitles: number;
}

function getActivityStats(appName: string, days = 30): ActivityStats {
  try {
    const sinceClause = `datetime('now', '-${days} days')`;
    const rows = db.prepare(
      `SELECT captured_at, window_title FROM activity_captures
       WHERE app_name = ? AND captured_at >= ${sinceClause}`
    ).all(appName) as any[];
    if (rows.length === 0) return { sessionCount: 0, uniqueWindowTitles: 0 };

    const titles = new Set<string>();
    const hourBins = new Array(24).fill(0);
    let last = "";
    for (const r of rows) {
      if (r.window_title) titles.add(r.window_title);
      if (r.captured_at > last) last = r.captured_at;
      const hour = new Date(r.captured_at).getHours();
      hourBins[hour]++;
    }
    const peakHour = hourBins.indexOf(Math.max(...hourBins));
    return {
      sessionCount: rows.length,
      lastActivityAt: last,
      peakHour,
      uniqueWindowTitles: titles.size,
    };
  } catch {
    return { sessionCount: 0, uniqueWindowTitles: 0 };
  }
}

// ── Slack (Tier B) ──────────────────────────────────────────────────────

async function trySlackPresence(): Promise<{ tokenPresent: boolean }> {
  const tok = getTokens(DEFAULT_USER_ID, "slack");
  return { tokenPresent: !!tok };
  // Future: if token present, call conversations.list + per-channel history
  // then aggregate per-user message counts. Deferred — OAuth flow for Slack
  // isn't wired yet.
}

// ── Entity resolution — fuzzy match iMessage handles with other sources ──

function normalizeHandle(s: string): string {
  return s.toLowerCase().trim().replace(/^[+]?1/, "").replace(/\D/g, "") ||
         s.toLowerCase().trim();
}

function resolveContacts(imessage: ChatSummary): UnifiedContact[] {
  if (!imessage.accessible) return [];
  const unified: UnifiedContact[] = [];
  const maxStrength = imessage.topContacts[0]?.relationshipStrength ?? 100;

  for (const c of imessage.topContacts) {
    unified.push({
      displayName: c.handle,             // resolved from Contacts at render time
      handles: [c.handle],
      sources: ["imessage"],
      totalMessages: c.messageCount,
      crossAppMatched: false,
      strength: Math.round((c.relationshipStrength / maxStrength) * 100),
      evidence: [
        `iMessage: ${c.messageCount} msgs (${Math.round(c.initiationRatio * 100)}% sent)`,
      ],
    });
  }

  // Cross-check handle against macOS Contacts for display name lift
  // (Contacts scanner already populated ingestion_log; reuse graph_nodes of type=person)
  try {
    const people = db.prepare(
      "SELECT label, detail FROM graph_nodes WHERE user_id=? AND type='person'"
    ).all(DEFAULT_USER_ID) as any[];
    for (const u of unified) {
      const handleNorm = normalizeHandle(u.handles[0] ?? "");
      for (const p of people) {
        const detailNorm = normalizeHandle(p.detail ?? "");
        const labelNorm = (p.label ?? "").toLowerCase();
        // If handle looks like email and appears in person detail text
        if (u.handles[0]?.includes("@") && p.detail?.includes(u.handles[0])) {
          u.displayName = p.label;
          u.evidence.push(`Contact match: ${p.label}`);
          break;
        }
        // Phone partial match
        if (handleNorm.length >= 7 && detailNorm.includes(handleNorm.slice(-7))) {
          u.displayName = p.label;
          u.evidence.push(`Contact match: ${p.label}`);
          break;
        }
      }
    }
  } catch {}

  return unified;
}

// ── Main scanner ─────────────────────────────────────────────────────────

export async function scanMessagesUnified(): Promise<MessagesUnifiedSummary> {
  const imessageSummary = scanIMessage(90);
  const slack = await trySlackPresence();

  const apps: ChatAppStatus[] = [];

  for (const tracked of TRACKED_CHAT_APPS) {
    const registryHit = findApp(tracked.name);
    const installed = !!registryHit;

    // Activity stats
    let activityStats: ActivityStats = { sessionCount: 0, uniqueWindowTitles: 0 };
    for (const name of tracked.activityNames) {
      const s = getActivityStats(name);
      if (s.sessionCount > activityStats.sessionCount) activityStats = s;
    }

    let tier: MessagesTier;
    let messageCount: number | undefined;

    if (tracked.id === "imessage") {
      tier = imessageSummary.accessible ? "full-content" : "presence-only";
      messageCount = imessageSummary.totalMessages;
    } else if (tracked.id === "slack" && slack.tokenPresent) {
      tier = "api";
    } else if (activityStats.sessionCount > 0) {
      tier = "frequency-proxy";
    } else {
      tier = "presence-only";
    }

    apps.push({
      appId: tracked.id,
      displayName: tracked.name,
      installed,
      active: activityStats.sessionCount > 0 || (tracked.id === "imessage" && imessageSummary.totalMessages > 0),
      tier,
      messageCount,
      activitySessionCount: activityStats.sessionCount > 0 ? activityStats.sessionCount : undefined,
      lastActivityAt: activityStats.lastActivityAt,
      peakHour: activityStats.peakHour,
    });
  }

  const active = apps.filter(a => a.active);
  const installed = apps.filter(a => a.installed);

  // Primary chat app: by message count if available, else by session count
  let primaryChat = "";
  let primaryShare = 0;
  const totalSignal = active.reduce((s, a) => s + (a.messageCount ?? a.activitySessionCount ?? 0), 0);
  if (totalSignal > 0) {
    const sorted = [...active].sort((a, b) => (b.messageCount ?? b.activitySessionCount ?? 0) - (a.messageCount ?? a.activitySessionCount ?? 0));
    primaryChat = sorted[0].appId;
    primaryShare = (sorted[0].messageCount ?? sorted[0].activitySessionCount ?? 0) / totalSignal;
  }

  const topContacts = resolveContacts(imessageSummary).slice(0, 15);

  const signals: UnifiedMessagesSignal[] = [];
  if (installed.length >= 4) {
    signals.push({ name: "multi-platform-chat-user", strength: "strong",
      evidence: `${installed.length} chat apps installed: ${installed.map(a => a.displayName).join(", ")}` });
  }
  if (primaryShare >= 0.7) {
    signals.push({ name: `${primaryChat}-dominant`, strength: "strong",
      evidence: `${primaryChat} = ${Math.round(primaryShare * 100)}% of chat signal` });
  } else if (active.length >= 3 && primaryShare < 0.4) {
    signals.push({ name: "fragmented-chat-stack", strength: "medium",
      evidence: `${active.length} active apps, no dominant (top = ${Math.round(primaryShare * 100)}%)` });
  }
  // iMessage + WeChat coexistence = CN-US bridge social life
  const hasWechat = apps.find(a => a.appId === "wechat")?.active;
  const hasImessage = apps.find(a => a.appId === "imessage")?.active;
  if (hasWechat && hasImessage) {
    signals.push({ name: "cn-us-chat-bridge", strength: "strong",
      evidence: "Active in both WeChat and iMessage — spans CN and US social graphs" });
  }
  // Privacy tier signal
  const hasSignal = apps.find(a => a.appId === "signal")?.installed;
  const hasTelegram = apps.find(a => a.appId === "telegram")?.installed;
  if (hasSignal || hasTelegram) {
    signals.push({ name: "privacy-aware-messenger-user", strength: "medium",
      evidence: [hasSignal && "Signal", hasTelegram && "Telegram"].filter(Boolean).join(" + ") });
  }
  // Coverage honesty
  const contentReadable = apps.filter(a => a.tier === "full-content" || a.tier === "api").length;
  if (contentReadable === 0 && active.length > 0) {
    signals.push({ name: "zero-content-readable", strength: "strong",
      evidence: "No chat apps with readable content — relationship data is frequency-only or unknown" });
  }

  const coverage = buildCoverageStatement(apps, imessageSummary);

  const result: MessagesUnifiedSummary = {
    apps,
    totalAppsInstalled: installed.length,
    totalAppsActive: active.length,
    primaryChat,
    primaryChatDominance: Math.round(primaryShare * 100) / 100,
    topContacts,
    crossAppMatches: topContacts.filter(c => c.crossAppMatched).length,
    signals,
    coverage,
  };

  shadowEmit({
    scanner: "messages-unified",
    source: "imessage",
    kind: "messages_scan_summary",
    stableFields: { scanDay: new Date().toISOString().slice(0, 10) },
    payload: {
      totalAppsInstalled: result.totalAppsInstalled,
      totalAppsActive: result.totalAppsActive,
      primaryChat: result.primaryChat,
      primaryChatDominance: result.primaryChatDominance,
      apps: result.apps.map(a => ({ id: a.appId, active: a.active, tier: a.tier, messageCount: a.messageCount })),
      topContactCount: result.topContacts.length,
      crossAppMatches: result.crossAppMatches,
    },
  });

  return result;
}

function buildCoverageStatement(apps: ChatAppStatus[], imessageSummary: ChatSummary): string {
  const fullContent = apps.filter(a => a.tier === "full-content" && a.active);
  const freqProxy = apps.filter(a => a.tier === "frequency-proxy" && a.active);
  const presenceOnly = apps.filter(a => a.tier === "presence-only" && a.installed);

  const parts: string[] = [];
  if (fullContent.length > 0) {
    parts.push(`Full message content readable for: ${fullContent.map(a => a.displayName).join(", ")}`);
  }
  if (freqProxy.length > 0) {
    parts.push(`Frequency-only (Accessibility activity): ${freqProxy.map(a => a.displayName).join(", ")}`);
  }
  if (presenceOnly.length > 0) {
    parts.push(`Installed but encrypted / unreadable: ${presenceOnly.map(a => a.displayName).join(", ")}`);
  }
  if (!imessageSummary.accessible && apps.some(a => a.appId === "imessage" && a.installed)) {
    parts.push(`iMessage DB found but requires Full Disk Access to read`);
  }
  return parts.join(". ");
}

// ── Render for profile text ──────────────────────────────────────────────

export function messagesUnifiedToText(summary: MessagesUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("MESSAGING / CHAT UNIFIED VIEW:");
  lines.push(`  Active chat apps: ${summary.totalAppsActive} of ${summary.totalAppsInstalled} installed.`);
  if (summary.primaryChat) {
    lines.push(`  Primary chat: ${summary.primaryChat} (${Math.round(summary.primaryChatDominance * 100)}% of measurable activity)`);
  }

  // Per-app status
  const active = summary.apps.filter(a => a.active).sort((a, b) => (b.messageCount ?? b.activitySessionCount ?? 0) - (a.messageCount ?? a.activitySessionCount ?? 0));
  if (active.length > 0) {
    lines.push("  Activity breakdown:");
    for (const a of active) {
      const metric = a.messageCount !== undefined ? `${a.messageCount} msgs` :
                     a.activitySessionCount !== undefined ? `${a.activitySessionCount} activity sessions` :
                     "active";
      lines.push(`    [${a.tier}] ${a.displayName}: ${metric}${a.peakHour !== undefined ? ` (peak ${a.peakHour}:00)` : ""}`);
    }
  }

  // Presence-only count (list itself appears in Coverage + signals below)
  const presenceOnly = summary.apps.filter(a => a.installed && !a.active);
  if (presenceOnly.length > 0) {
    lines.push(`  Installed but inactive: ${presenceOnly.length}`);
  }

  // Top contacts (from iMessage)
  if (summary.topContacts.length > 0) {
    lines.push("  Top relationships (from iMessage; other apps encrypted):");
    for (const c of summary.topContacts.slice(0, 8)) {
      const handle = c.displayName.length > 40 ? c.displayName.slice(0, 40) + "..." : c.displayName;
      lines.push(`    [${c.strength}] ${handle.padEnd(42)} · ${c.totalMessages} msgs · sources: ${c.sources.join(",")}`);
    }
  }

  // Signals
  if (summary.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const s of summary.signals) lines.push(`    [${s.strength}] ${s.name} — ${s.evidence}`);
  }

  if (summary.coverage) {
    lines.push(`  Coverage: ${summary.coverage}`);
  }
  return lines.join("\n");
}
