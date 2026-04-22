/**
 * Local Scanner — orchestrates all local data sources.
 *
 * One function: runLocalScan() — reads browser history, contacts, calendar.
 * All data stays local. No API keys. No OAuth. No cloud.
 */
import { db, DEFAULT_USER_ID, logExecution } from "../../infra/storage/db.js";
import { nanoid } from "nanoid";
import { scanBrowserHistory, getAvailableBrowsers } from "./browser-history.js";
import { scanContacts } from "./contacts.js";
import { scanAllCalendars, unifiedToIngestion } from "./calendar-unified.js";
import { deepScanMac, profileToText } from "./deep-scan.js";
import { extractAndSavePeople } from "./people-extractor.js";
import { extractFromText } from "../../cognition/extractor.js";
import { bus } from "../../orchestration/bus.js";
import type { IngestionEvent } from "../types.js";

// ── Consent Management ─────────────────────────────────────────────────────

export function hasConsent(userId: string): boolean {
  const consent = db.prepare("SELECT id FROM scan_consent WHERE user_id=? AND scope='local' AND revoked_at IS NULL").get(userId);
  return !!consent;
}

export function grantConsent(userId: string): void {
  db.prepare("UPDATE scan_consent SET revoked_at=datetime('now') WHERE user_id=? AND scope='local' AND revoked_at IS NULL").run(userId);
  db.prepare("INSERT INTO scan_consent (id, user_id, scope, version) VALUES (?,?,?,?)").run(nanoid(), userId, "local", "1.0");
}

export function revokeConsent(userId: string): void {
  db.prepare("UPDATE scan_consent SET revoked_at=datetime('now') WHERE user_id=? AND scope='local' AND revoked_at IS NULL").run(userId);
}

export interface LocalScanResult {
  browserEvents: number;
  contacts: number;
  calendarEvents: number;
  nodesCreated: number;
  browsers: string[];
}

export interface LocalScanStatus {
  enabled: boolean;
  lastScanAt: string | null;
  lastResult: LocalScanResult | null;
  availableBrowsers: string[];
}

export function getLocalScanStatus(): LocalScanStatus {
  const lastScan = db.prepare(
    "SELECT finished_at, events_fetched, nodes_created FROM ingestion_log WHERE user_id=? AND source='local' AND status='done' ORDER BY started_at DESC LIMIT 1"
  ).get(DEFAULT_USER_ID) as any;

  return {
    enabled: true, // always available on macOS
    lastScanAt: lastScan?.finished_at ?? null,
    lastResult: lastScan ? {
      browserEvents: 0, contacts: 0, calendarEvents: 0,
      nodesCreated: lastScan.nodes_created,
      browsers: getAvailableBrowsers(),
    } : null,
    availableBrowsers: getAvailableBrowsers(),
  };
}

export async function runLocalScan(opts?: {
  browser?: boolean;
  contacts?: boolean;
  calendar?: boolean;
  sinceDaysAgo?: number;
}): Promise<LocalScanResult> {
  const {
    browser = true,
    contacts = true,
    calendar = true,
    sinceDaysAgo = 30,
  } = opts ?? {};

  console.log("[LocalScan] Starting local scan...");

  const logId = nanoid();
  db.prepare("INSERT INTO ingestion_log (id, user_id, source, run_type, status) VALUES (?,?,?,?,?)")
    .run(logId, DEFAULT_USER_ID, "local", "full", "running");

  const nodesBefore = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  let browserEvents: IngestionEvent[] = [];
  let contactEvents: IngestionEvent[] = [];
  let calendarEvents: IngestionEvent[] = [];

  try {
    // ── Step 0: Deep Mac scan — apps, projects, files, tech stack ──
    // This runs FIRST because it's instant (no LLM) and gives rich context.
    // Step 5 addition: run calendar unification in parallel and merge its
    // summary into the macProfile so the extractor sees schedule info too.
    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "deep_scan", status: "running", found: 0 } });
    const [macProfile, calUnified] = await Promise.all([
      Promise.resolve(deepScanMac()),
      calendar ? scanAllCalendars(sinceDaysAgo).catch(err => {
        console.error("[CalendarUnified] error:", err?.message);
        return null;
      }) : Promise.resolve(null),
    ]);
    if (calUnified) {
      macProfile.calendarSummary = calUnified.summary;
      // Feed unified events into the same pipeline the extractor expects
      calendarEvents = unifiedToIngestion(calUnified.events);
      bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "calendar", status: "done", found: calendarEvents.length } });
    }
    const profileText = profileToText(macProfile);
    if (profileText.length > 50) {
      console.log("[LocalScan] Deep scan: extracting from Mac profile...");
      await extractFromText(profileText);
      await new Promise(r => setTimeout(r, 500));
    }

    // ── Step 0.5a: Health inference from time patterns ──
    // Create health nodes from screen time analysis — no LLM needed
    try {
      const msgs = db.prepare(
        "SELECT created_at FROM agent_executions WHERE user_id=? ORDER BY created_at DESC LIMIT 100"
      ).all(DEFAULT_USER_ID) as any[];

      const browserVisits = browserEvents ?? [];
      const lateNightCount = browserVisits.filter(e => {
        try { return new Date(e.occurredAt).getHours() >= 23 || new Date(e.occurredAt).getHours() < 4; } catch { return false; }
      }).length;

      if (lateNightCount > 10) {
        const existing = db.prepare("SELECT id FROM graph_nodes WHERE user_id=? AND domain='health' AND label LIKE '%Sleep%'").get(DEFAULT_USER_ID);
        if (!existing) {
          db.prepare("INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail) VALUES (?,?,?,?,?,?,?,?)")
            .run(nanoid(), DEFAULT_USER_ID, "health", "Sleep Deficit Risk", "risk", "active", "Inferred from browsing timestamps", `${lateNightCount} late-night browsing sessions detected (11pm-4am)`);
        }
      }
    } catch {}

    // ── Step 0.5b: Extract people from browser history + WeChat ──
    // Direct to DB — no LLM needed, just pattern matching
    const peopleResult = extractAndSavePeople();
    console.log(`[LocalScan] People: ${peopleResult.total} extracted from ${JSON.stringify(peopleResult.sources)}`);

    // ── Step 1: Gather events from all sources ──
    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "browser", status: "running", found: 0 } });
    if (browser) browserEvents = scanBrowserHistory(sinceDaysAgo);
    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "browser", status: "done", found: browserEvents.length } });

    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "contacts", status: "running", found: 0 } });
    if (contacts) contactEvents = scanContacts();
    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "contacts", status: "done", found: contactEvents.length } });

    // (calendar events already collected via scanAllCalendars above — skipping
    // redundant scanCalendar() call that was here pre-Step-5)

    const allEvents = [...browserEvents, ...contactEvents, ...calendarEvents];
    const totalFetched = allEvents.length;

    console.log(`[LocalScan] Collected: ${browserEvents.length} URLs, ${contactEvents.length} contacts, ${calendarEvents.length} calendar events`);

    if (allEvents.length === 0) {
      db.prepare("UPDATE ingestion_log SET status='done', events_fetched=0, finished_at=datetime('now') WHERE id=?").run(logId);
      return { browserEvents: 0, contacts: 0, calendarEvents: 0, nodesCreated: 0, browsers: getAvailableBrowsers() };
    }

    // Group by type for smarter extraction prompts
    // Browser: aggregate by domain to reduce noise
    const domainGroups = new Map<string, { title: string; visits: number }[]>();
    for (const e of browserEvents) {
      const url = (e.metadata as any)?.url ?? "";
      const hostname = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return "unknown"; } })();
      if (!domainGroups.has(hostname)) domainGroups.set(hostname, []);
      domainGroups.get(hostname)!.push({ title: e.rawText.split("\n")[0]?.replace("Browsed: ", "") ?? "", visits: (e.metadata as any)?.visits ?? 1 });
    }

    // Build aggregated browser summary (top 30 domains by visit count)
    const topDomains = Array.from(domainGroups.entries())
      .map(([domain, pages]) => ({ domain, totalVisits: pages.reduce((s, p) => s + p.visits, 0), topPages: pages.sort((a, b) => b.visits - a.visits).slice(0, 3) }))
      .sort((a, b) => b.totalVisits - a.totalVisits)
      .slice(0, 30);

    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "extraction", status: "running", found: allEvents.length } });
    if (topDomains.length > 0) {
      const browserText = "Recent browsing activity (most visited sites):\n" +
        topDomains.map(d => `${d.domain} (${d.totalVisits} visits): ${d.topPages.map(p => p.title).join("; ")}`).join("\n");
      await extractFromText(browserText);
      await new Promise(r => setTimeout(r, 500));
    }

    // Contacts: batch in groups of 20
    for (let i = 0; i < contactEvents.length; i += 20) {
      const batch = contactEvents.slice(i, i + 20);
      const text = batch.map(e => e.rawText).join("\n---\n");
      await extractFromText(text);
      if (i + 20 < contactEvents.length) await new Promise(r => setTimeout(r, 500));
    }

    // Calendar: batch in groups of 10
    for (let i = 0; i < calendarEvents.length; i += 10) {
      const batch = calendarEvents.slice(i, i + 10);
      const text = batch.map(e => e.rawText).join("\n---\n");
      await extractFromText(text);
      if (i + 10 < calendarEvents.length) await new Promise(r => setTimeout(r, 500));
    }

    const nodesAfter = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
    const nodesCreated = nodesAfter - nodesBefore;
    bus.publish({ type: "SCAN_PROGRESS", payload: { phase: "done", status: "done", found: nodesCreated } });

    db.prepare("UPDATE ingestion_log SET status='done', events_fetched=?, nodes_created=?, finished_at=datetime('now') WHERE id=?")
      .run(totalFetched, nodesCreated, logId);

    logExecution("Local Scanner", `Scan done: ${browserEvents.length} URLs, ${contactEvents.length} contacts, ${calendarEvents.length} events → ${nodesCreated} nodes`);
    console.log(`[LocalScan] Done: ${totalFetched} events → ${nodesCreated} new nodes`);

    return {
      browserEvents: browserEvents.length,
      contacts: contactEvents.length,
      calendarEvents: calendarEvents.length,
      nodesCreated,
      browsers: getAvailableBrowsers(),
    };
  } catch (err: any) {
    console.error("[LocalScan] Error:", err.message);
    db.prepare("UPDATE ingestion_log SET status='failed', error=?, finished_at=datetime('now') WHERE id=?")
      .run(err.message?.slice(0, 500), logId);
    logExecution("Local Scanner", `Scan failed: ${err.message}`, "failed");
    return { browserEvents: browserEvents.length, contacts: contactEvents.length, calendarEvents: calendarEvents.length, nodesCreated: 0, browsers: getAvailableBrowsers() };
  }
}
