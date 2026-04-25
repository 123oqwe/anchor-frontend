/**
 * Email Unification — relationship + interest signals from email.
 *
 * The highest-value email signals are NOT message bodies, they're the shape:
 *   - Top recipients of YOUR sent mail  = people you deliberately reach out to
 *   - Top senders to YOU (non-subscription) = active inbound relationships
 *   - Newsletter subscriptions = your information diet (pull vs push)
 *   - Inbox unread count       = "inbox as todo" vs "inbox as archive"
 *
 * Sources:
 *   full-content:   Apple Mail (AppleScript, limited to recent window for speed)
 *   api:            Gmail (gmail-rest OAuth) — scaffolded but deferred
 *   presence-only:  Outlook, Spark, Superhuman (read the same IMAP/Gmail
 *                   underneath; Apple Mail is the unifying aggregator)
 *
 * Privacy: we read sender/recipient addresses + subjects + dates only.
 * Never store bodies. Subject is kept only for subscription pattern matching,
 * discarded before output.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { getTokens } from "../token-store.js";
import { DEFAULT_USER_ID } from "../../infra/storage/db.js";
import { shadowEmit } from "../../infra/storage/scanner-events.js";

const HOME = os.homedir();

export type EmailTier = "full-content" | "api" | "presence-only";

export interface EmailSender {
  address: string;
  displayName?: string;
  count: number;
  isLikelySubscription: boolean;
  lastReceivedAt?: string;
}

export interface EmailRecipient {
  address: string;
  displayName?: string;
  count: number;
  lastSentAt?: string;
}

export interface EmailApp {
  appId: string;
  displayName: string;
  installed: boolean;
  active: boolean;
  tier: EmailTier;
}

export interface EmailUnifiedSummary {
  accessible: boolean;
  reason?: string;
  apps: EmailApp[];
  primarySource: string;
  inboxLast30d: number;
  sentLast30d: number;
  inboxUnread?: number;
  topReceivedFrom: EmailSender[];
  topSentTo: EmailRecipient[];
  subscriptionsDetected: number;
  subscriptionDomains: string[];
  signals: EmailSignal[];
  coverage: string;
}

export interface EmailSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Subscription / newsletter heuristic ─────────────────────────────────

const SUBSCRIPTION_PATTERNS = [
  /no-?reply/i, /newsletter/i, /digest/i, /notifications?@/i,
  /news@/i, /mailer@/i, /updates?@/i, /bot@/i, /info@/i,
  /substack\.com$/i, /beehiiv\.com$/i, /convertkit/i,
  /campaign-archive/i, /mailchimp/i, /sendgrid/i, /sparkpost/i,
];

function isLikelySubscription(sender: string, subject?: string): boolean {
  if (!sender) return false;
  for (const re of SUBSCRIPTION_PATTERNS) if (re.test(sender)) return true;
  if (subject && /^(unsubscribe|your daily|your weekly|\[newsletter\])/i.test(subject)) return true;
  return false;
}

function extractAddressAndName(raw: string): { address: string; displayName?: string } {
  if (!raw) return { address: "" };
  // Patterns: "Name <email@domain>" or "email@domain" or "email@domain (Name)"
  const m1 = raw.match(/^([^<]+)<([^>]+)>$/);
  if (m1) return { displayName: m1[1].trim().replace(/^"|"$/g, ""), address: m1[2].trim().toLowerCase() };
  const m2 = raw.match(/^([^@\s]+@[^\s()]+)\s*\(([^)]+)\)$/);
  if (m2) return { address: m2[1].toLowerCase(), displayName: m2[2].trim() };
  return { address: raw.trim().toLowerCase() };
}

// ── Apple Mail via AppleScript ──────────────────────────────────────────

interface RawMsg { sender: string; subject?: string; date: string }

function runAppleScript(script: string, timeoutMs = 30000): string {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: timeoutMs, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024,
    }).trim();
  } catch (e: any) {
    if (e.stderr) throw new Error(e.stderr.toString().slice(0, 300));
    throw e;
  }
}

function scanAppleMailInbox(limit = 300): RawMsg[] {
  const script = `
    tell application "Mail"
      set output to ""
      set cutoff to (current date) - 30 * days
      set msgs to messages of inbox
      set k to count of msgs
      if k > ${limit} then set k to ${limit}
      set counter to 0
      repeat with i from 1 to k
        try
          set m to item i of msgs
          set d to date received of m
          if d < cutoff then exit repeat
          set s to sender of m
          set subj to subject of m
          set output to output & s & "|||" & subj & "|||" & (d as string) & "\\n"
          set counter to counter + 1
          if counter ≥ ${limit} then exit repeat
        end try
      end repeat
      return output
    end tell`;
  const raw = runAppleScript(script, 30000);
  const lines = raw.split("\n").filter(Boolean);
  return lines.map((l) => {
    const [sender, subject, date] = l.split("|||");
    return { sender: sender ?? "", subject: subject ?? "", date: date ?? "" };
  });
}

function scanAppleMailSent(limit = 200): RawMsg[] {
  const script = `
    tell application "Mail"
      set output to ""
      set cutoff to (current date) - 30 * days
      set sentBox to sent mailbox
      set msgs to messages of sentBox
      set k to count of msgs
      if k > ${limit} then set k to ${limit}
      repeat with i from 1 to k
        try
          set m to item i of msgs
          set d to date sent of m
          if d < cutoff then exit repeat
          -- 'to recipients' returns a list
          set recipList to to recipients of m
          set recipStr to ""
          repeat with r in recipList
            set recipStr to recipStr & address of r & ", "
          end repeat
          set subj to subject of m
          set output to output & recipStr & "|||" & subj & "|||" & (d as string) & "\\n"
        end try
      end repeat
      return output
    end tell`;
  const raw = runAppleScript(script, 30000);
  const lines = raw.split("\n").filter(Boolean);
  // We're overloading "sender" field to hold recipients list for sent msgs
  return lines.map((l) => {
    const [recips, subject, date] = l.split("|||");
    return { sender: recips ?? "", subject: subject ?? "", date: date ?? "" };
  });
}

function scanAppleMailUnread(): number | undefined {
  try {
    const raw = runAppleScript(`tell application "Mail" to unread count of inbox`, 5000);
    const n = parseInt(raw, 10);
    return isNaN(n) ? undefined : n;
  } catch { return undefined; }
}

// ── Main ────────────────────────────────────────────────────────────────

export async function scanEmailUnified(): Promise<EmailUnifiedSummary> {
  const apps: EmailApp[] = [];

  // Probe Apple Mail availability
  let mailAccessible = false;
  try {
    runAppleScript(`tell application "Mail" to count of mailboxes`, 3000);
    mailAccessible = true;
    apps.push({
      appId: "apple-mail", displayName: "Mail",
      installed: true, active: true, tier: "full-content",
    });
  } catch {
    apps.push({
      appId: "apple-mail", displayName: "Mail",
      installed: fs.existsSync("/System/Applications/Mail.app"),
      active: false, tier: "full-content",
    });
  }

  // Gmail OAuth presence
  const gmailToken = getTokens(DEFAULT_USER_ID, "google");
  if (gmailToken) {
    apps.push({
      appId: "gmail", displayName: "Gmail (via OAuth)",
      installed: true, active: false, tier: "api",
    });
  }

  // Presence-only clients
  const PRESENCE: Record<string, string> = {
    superhuman: "Superhuman", spark: "Spark", mimestream: "Mimestream",
    outlook: "Microsoft Outlook", airmail: "Airmail",
  };
  for (const [id, appName] of Object.entries(PRESENCE)) {
    if (fs.existsSync(path.join("/Applications", `${appName}.app`)) ||
        fs.existsSync(path.join(HOME, "Applications", `${appName}.app`))) {
      apps.push({
        appId: id, displayName: appName,
        installed: true, active: false, tier: "presence-only",
      });
    }
  }

  if (!mailAccessible) {
    return {
      accessible: false,
      reason: "Apple Mail not accessible via AppleScript — either Mail.app not configured or automation permission denied",
      apps,
      primarySource: "",
      inboxLast30d: 0, sentLast30d: 0,
      topReceivedFrom: [], topSentTo: [],
      subscriptionsDetected: 0, subscriptionDomains: [],
      signals: [{ name: "email-not-scanned", strength: "strong",
        evidence: "Mail.app unavailable; email depth unknown" }],
      coverage: "No email source accessible.",
    };
  }

  // Inbox
  let inboxMsgs: RawMsg[] = [];
  try { inboxMsgs = scanAppleMailInbox(300); } catch {}
  const senderCounts = new Map<string, EmailSender>();
  for (const m of inboxMsgs) {
    const { address, displayName } = extractAddressAndName(m.sender);
    if (!address) continue;
    const sub = isLikelySubscription(m.sender, m.subject);
    const existing = senderCounts.get(address);
    if (existing) {
      existing.count++;
      if (!existing.lastReceivedAt || m.date > existing.lastReceivedAt) existing.lastReceivedAt = m.date;
      existing.isLikelySubscription = existing.isLikelySubscription || sub;
    } else {
      senderCounts.set(address, {
        address, displayName, count: 1,
        isLikelySubscription: sub, lastReceivedAt: m.date,
      });
    }
  }

  // Sent
  let sentMsgs: RawMsg[] = [];
  try { sentMsgs = scanAppleMailSent(200); } catch {}
  const recipCounts = new Map<string, EmailRecipient>();
  for (const m of sentMsgs) {
    const recipients = m.sender.split(",").map(s => s.trim()).filter(Boolean);
    for (const r of recipients) {
      const { address, displayName } = extractAddressAndName(r);
      if (!address) continue;
      const existing = recipCounts.get(address);
      if (existing) {
        existing.count++;
        if (!existing.lastSentAt || m.date > existing.lastSentAt) existing.lastSentAt = m.date;
      } else {
        recipCounts.set(address, { address, displayName, count: 1, lastSentAt: m.date });
      }
    }
  }

  const inboxUnread = scanAppleMailUnread();

  const allSenders = Array.from(senderCounts.values()).sort((a, b) => b.count - a.count);
  const topReceivedFrom = allSenders.filter(s => !s.isLikelySubscription).slice(0, 15);
  const subscriptionSenders = allSenders.filter(s => s.isLikelySubscription);
  const subscriptionDomains = Array.from(new Set<string>(
    subscriptionSenders.map(s => s.address.split("@")[1] ?? "").filter(Boolean)
  )).slice(0, 15);

  const topSentTo = Array.from(recipCounts.values()).sort((a, b) => b.count - a.count).slice(0, 15);

  const signals: EmailSignal[] = [];
  if (inboxMsgs.length === 0 && sentMsgs.length === 0) {
    signals.push({ name: "inactive-mail-user", strength: "strong",
      evidence: "No inbox or sent activity in last 30 days (at this AppleScript sample depth)" });
  }
  if (inboxUnread !== undefined) {
    if (inboxUnread > 500) signals.push({ name: "inbox-bankruptcy-candidate", strength: "strong",
      evidence: `${inboxUnread} unread` });
    else if (inboxUnread > 100) signals.push({ name: "inbox-as-archive", strength: "medium",
      evidence: `${inboxUnread} unread — inbox zero not a goal` });
    else if (inboxUnread < 10) signals.push({ name: "inbox-zero-discipline", strength: "medium",
      evidence: `${inboxUnread} unread — disciplined user` });
  }
  if (subscriptionSenders.length >= 20) signals.push({ name: "newsletter-heavy-diet", strength: "strong",
    evidence: `${subscriptionSenders.length} subscription senders — pull-based info diet` });
  else if (subscriptionSenders.length >= 5) signals.push({ name: "curated-newsletter-user", strength: "medium",
    evidence: `${subscriptionSenders.length} subscriptions: ${subscriptionDomains.slice(0, 5).join(", ")}` });

  if (topSentTo.length > 0 && topSentTo[0].count >= 10) {
    signals.push({ name: "high-volume-reacher", strength: "medium",
      evidence: `Top recipient ${topSentTo[0].displayName ?? topSentTo[0].address}: ${topSentTo[0].count} sends in 30d` });
  }

  const initiationRatio = sentMsgs.length / Math.max(1, sentMsgs.length + inboxMsgs.length);
  if (sentMsgs.length >= 20 && initiationRatio >= 0.4) {
    signals.push({ name: "active-email-initiator", strength: "medium",
      evidence: `${sentMsgs.length} sent vs ${inboxMsgs.length} received → ${Math.round(initiationRatio * 100)}% outbound` });
  } else if (sentMsgs.length >= 10 && initiationRatio < 0.2) {
    signals.push({ name: "reactive-email-user", strength: "medium",
      evidence: `Mostly responds — ${sentMsgs.length} sent vs ${inboxMsgs.length} received` });
  }

  // CN-facing signal
  const cnSenders = allSenders.filter(s =>
    /\.(cn|com\.cn)$/i.test(s.address) || /qq\.com$|163\.com$|126\.com$|sina\.com$/i.test(s.address)
  );
  if (cnSenders.length >= 3) {
    signals.push({ name: "cn-email-network", strength: "medium",
      evidence: `${cnSenders.length} senders from Chinese email domains` });
  }

  const coverage = buildCoverage(apps, gmailToken !== null);

  const result: EmailUnifiedSummary = {
    accessible: true,
    apps,
    primarySource: "apple-mail",
    inboxLast30d: inboxMsgs.length,
    sentLast30d: sentMsgs.length,
    inboxUnread,
    topReceivedFrom,
    topSentTo,
    subscriptionsDetected: subscriptionSenders.length,
    subscriptionDomains,
    signals,
    coverage,
  };

  shadowEmit({
    scanner: "email-unified",
    source: "mail",
    kind: "email_scan_summary",
    stableFields: { scanDay: new Date().toISOString().slice(0, 10) },
    payload: {
      inboxLast30d: result.inboxLast30d,
      sentLast30d: result.sentLast30d,
      inboxUnread: result.inboxUnread,
      topReceivedFrom: result.topReceivedFrom?.slice(0, 10),
      topSentTo: result.topSentTo?.slice(0, 10),
      subscriptionsDetected: result.subscriptionsDetected,
      apps: result.apps.map(a => ({ id: a.appId, active: a.active, tier: a.tier })),
    },
  });

  return result;
}

function buildCoverage(apps: EmailApp[], hasGmailToken: boolean): string {
  const parts: string[] = [];
  const active = apps.filter(a => a.active);
  const presence = apps.filter(a => !a.active && a.tier === "presence-only");
  if (active.length > 0) parts.push(`Readable: ${active.map(a => a.displayName).join(", ")}`);
  if (!hasGmailToken) parts.push("Gmail OAuth not granted (would unlock deeper history + cross-account)");
  if (presence.length > 0) parts.push(`Installed clients (read same IMAP as Mail.app): ${presence.map(a => a.displayName).join(", ")}`);
  return parts.join(". ");
}

// ── Render ──────────────────────────────────────────────────────────────

export function emailUnifiedToText(s: EmailUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("EMAIL PROFILE:");
  if (!s.accessible) {
    lines.push(`  Status: not accessible. ${s.reason ?? ""}`);
    return lines.join("\n");
  }
  lines.push(`  Last 30d: ${s.inboxLast30d} received, ${s.sentLast30d} sent${s.inboxUnread !== undefined ? `, ${s.inboxUnread} unread in inbox` : ""}`);
  lines.push(`  Subscriptions: ${s.subscriptionsDetected}${s.subscriptionDomains.length > 0 ? ` (top domains: ${s.subscriptionDomains.slice(0, 6).join(", ")})` : ""}`);

  if (s.topReceivedFrom.length > 0) {
    lines.push("  Top inbound (non-subscription):");
    for (const f of s.topReceivedFrom.slice(0, 8)) {
      lines.push(`    ${String(f.count).padStart(3)}x · ${f.displayName ?? f.address}${f.displayName ? ` <${f.address}>` : ""}`);
    }
  }
  if (s.topSentTo.length > 0) {
    lines.push("  Top outbound (who YOU email most):");
    for (const r of s.topSentTo.slice(0, 8)) {
      lines.push(`    ${String(r.count).padStart(3)}x · ${r.displayName ?? r.address}${r.displayName ? ` <${r.address}>` : ""}`);
    }
  }
  if (s.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const sig of s.signals) lines.push(`    [${sig.strength}] ${sig.name} — ${sig.evidence}`);
  }
  if (s.coverage) lines.push(`  Coverage: ${s.coverage}`);
  return lines.join("\n");
}
