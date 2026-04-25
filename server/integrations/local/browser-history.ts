/**
 * Local Browser History Scanner — reads Chrome/Safari/Arc SQLite files directly.
 * No API key. No OAuth. Data never leaves the machine.
 *
 * Safety: copies the file first (browser locks it), reads only metadata (URL + title + visit count).
 */
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import type { IngestionEvent } from "../types.js";
import { shadowEmit } from "../../infra/storage/scanner-events.js";

const HOME = os.homedir();

// ── Sensitive URL filter — never ingest these domains ───────────────────────
const BLOCKED_DOMAINS = new Set([
  // Banking
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com",
  "paypal.com", "venmo.com", "stripe.com", "wise.com", "revolut.com",
  // Medical
  "webmd.com", "mayoclinic.org", "healthline.com", "zocdoc.com", "mychart.com",
  // Password managers
  "1password.com", "lastpass.com", "bitwarden.com", "dashlane.com",
  // Adult
  "pornhub.com", "xvideos.com", "xhamster.com",
  // Auth/login pages
  "accounts.google.com", "login.microsoftonline.com", "auth0.com",
  // Social media noise (too much volume, low signal)
  "facebook.com", "instagram.com", "tiktok.com", "reddit.com", "youtube.com",
]);

function isDomainBlocked(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    return BLOCKED_DOMAINS.has(hostname) || hostname.includes("bank") || hostname.includes("health");
  } catch { return true; }
}

// ── Browser profile paths on macOS ──────────────────────────────────────────
interface BrowserProfile {
  name: string;
  historyPath: string;
}

function findBrowserProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];

  // Chrome
  const chromeDir = path.join(HOME, "Library/Application Support/Google/Chrome");
  for (const profile of ["Default", "Profile 1", "Profile 2", "Profile 3"]) {
    const p = path.join(chromeDir, profile, "History");
    if (fs.existsSync(p)) profiles.push({ name: `Chrome/${profile}`, historyPath: p });
  }

  // Arc
  const arcPath = path.join(HOME, "Library/Application Support/Arc/User Data/Default/History");
  if (fs.existsSync(arcPath)) profiles.push({ name: "Arc", historyPath: arcPath });

  // Brave
  const bravePath = path.join(HOME, "Library/Application Support/BraveSoftware/Brave-Browser/Default/History");
  if (fs.existsSync(bravePath)) profiles.push({ name: "Brave", historyPath: bravePath });

  // Edge
  const edgePath = path.join(HOME, "Library/Application Support/Microsoft Edge/Default/History");
  if (fs.existsSync(edgePath)) profiles.push({ name: "Edge", historyPath: edgePath });

  // Safari (different format)
  const safariPath = path.join(HOME, "Library/Safari/History.db");
  if (fs.existsSync(safariPath)) profiles.push({ name: "Safari", historyPath: safariPath });

  return profiles;
}

// ── WebKit timestamp → Unix timestamp ───────────────────────────────────────
function webkitToUnix(webkitTime: number): number {
  return (webkitTime / 1000000) - 11644473600;
}

// ── Read Chromium-based history ─────────────────────────────────────────────
function readChromiumHistory(historyPath: string, sinceDaysAgo: number): IngestionEvent[] {
  const tmpPath = path.join(os.tmpdir(), `anchor_history_${Date.now()}.db`);
  try {
    fs.copyFileSync(historyPath, tmpPath);
    const db = new Database(tmpPath, { readonly: true });

    const sinceTime = (Date.now() / 1000 + 11644473600) * 1000000 - sinceDaysAgo * 86400 * 1000000 * 1000;

    const rows = db.prepare(`
      SELECT u.url, u.title, u.visit_count, MAX(v.visit_time) as last_visit
      FROM urls u
      JOIN visits v ON u.id = v.url
      WHERE v.visit_time > ?
      GROUP BY u.url
      ORDER BY last_visit DESC
      LIMIT 500
    `).all(sinceTime) as any[];

    db.close();

    return rows
      .filter(r => r.title && r.url && !isDomainBlocked(r.url))
      .map(r => {
        const hostname = (() => { try { return new URL(r.url).hostname.replace("www.", ""); } catch { return ""; } })();
        return {
          source: "gmail" as const, // reuse type, actual source is browser
          externalId: `browser:${r.url}`,
          occurredAt: new Date(webkitToUnix(r.last_visit) * 1000).toISOString(),
          rawText: `Browsed: ${r.title}\nURL: ${hostname}\nVisits: ${r.visit_count}`,
          metadata: { source: "browser", url: r.url, visits: r.visit_count },
        };
      });
  } catch (err: any) {
    console.error(`[LocalScan] Failed to read browser history:`, err.message);
    return [];
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Read Safari history ─────────────────────────────────────────────────────
function readSafariHistory(historyPath: string, sinceDaysAgo: number): IngestionEvent[] {
  const tmpPath = path.join(os.tmpdir(), `anchor_safari_${Date.now()}.db`);
  try {
    fs.copyFileSync(historyPath, tmpPath);
    const db = new Database(tmpPath, { readonly: true });

    // Safari uses CoreData epoch (2001-01-01)
    const sinceTime = (Date.now() / 1000) - 978307200 - sinceDaysAgo * 86400;

    const rows = db.prepare(`
      SELECT hi.url, hv.title, hi.visit_count, MAX(hv.visit_time) as last_visit
      FROM history_items hi
      JOIN history_visits hv ON hi.id = hv.history_item
      WHERE hv.visit_time > ?
      GROUP BY hi.url
      ORDER BY last_visit DESC
      LIMIT 500
    `).all(sinceTime) as any[];

    db.close();

    return rows
      .filter(r => r.title && r.url && !isDomainBlocked(r.url))
      .map(r => {
        const hostname = (() => { try { return new URL(r.url).hostname.replace("www.", ""); } catch { return ""; } })();
        return {
          source: "gmail" as const,
          externalId: `safari:${r.url}`,
          occurredAt: new Date((r.last_visit + 978307200) * 1000).toISOString(),
          rawText: `Browsed: ${r.title}\nURL: ${hostname}\nVisits: ${r.visit_count}`,
          metadata: { source: "safari", url: r.url, visits: r.visit_count },
        };
      });
  } catch (err: any) {
    console.error(`[LocalScan] Failed to read Safari history:`, err.message);
    return [];
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getAvailableBrowsers(): string[] {
  return findBrowserProfiles().map(p => p.name);
}

export function scanBrowserHistory(sinceDaysAgo = 30): IngestionEvent[] {
  const profiles = findBrowserProfiles();
  if (profiles.length === 0) return [];

  const allEvents: IngestionEvent[] = [];
  const seenUrls = new Set<string>();

  for (const profile of profiles) {
    const events = profile.name === "Safari"
      ? readSafariHistory(profile.historyPath, sinceDaysAgo)
      : readChromiumHistory(profile.historyPath, sinceDaysAgo);

    for (const e of events) {
      const url = (e.metadata as any)?.url;
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        allEvents.push(e);
      }
    }
  }

  console.log(`[LocalScan] Browser: ${allEvents.length} URLs from ${profiles.map(p => p.name).join(", ")}`);

  // Shadow-emit one summary event per scan run into the hash-chained log so
  // sync bundles include browser-history evidence. Day-bucket dedup means
  // multiple scans the same day collapse to one event.
  const scanDay = new Date().toISOString().slice(0, 10);
  const topDomains = (() => {
    const counts = new Map<string, number>();
    for (const e of allEvents) {
      const url = (e.metadata as any)?.url ?? "";
      try {
        const host = new URL(url).hostname.replace("www.", "");
        counts.set(host, (counts.get(host) ?? 0) + ((e.metadata as any)?.visits ?? 1));
      } catch {}
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([domain, visits]) => ({ domain, visits }));
  })();
  shadowEmit({
    scanner: "browser-history",
    source: "safari",
    kind: "browser_scan_summary",
    stableFields: { scanDay, sinceDaysAgo },
    payload: {
      urlCount: allEvents.length,
      browsers: profiles.map(p => p.name),
      sinceDaysAgo,
      topDomains,
    },
  });

  return allEvents;
}
