/**
 * Location / Travel Unification — "where you actually are".
 *
 * Localization tells us the OS timezone. This scanner ADDS physical-life
 * signals: WiFi networks you've connected to (history of places visited),
 * calendar event locations (where you actually go for meetings), and
 * timezone-event correlation (travel detection).
 *
 * Sources:
 *   permission-gated  WiFi history (plist at /Library/Preferences/...
 *                     — requires Full Disk Access or sudo)
 *   derived           Calendar event locations (from calendar-unified)
 *   derived           Timezone mismatches in calendar events
 *
 * For v1, WiFi is FDDA-gated and we gracefully fallback. Calendar-based
 * location inference is the reliable path.
 */
import { execSync } from "child_process";
import fs from "fs";
import type { CalendarSummary, UnifiedEvent } from "./calendar-unified.js";
import { shadowEmit } from "../../infra/storage/scanner-events.js";

export interface LocationSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

export interface LocationUnifiedSummary {
  wifiAccessible: boolean;
  wifiReason?: string;
  knownWifi: { ssid: string; lastConnected?: string }[];
  homeWifi?: string;           // heuristic: most-used at night/weekend
  workWifi?: string;           // heuristic: most-used weekday-daytime
  cafeWifi: string[];          // heuristic: SSIDs with "cafe", "starbucks", etc
  calendarLocations: Array<{ location: string; count: number }>;
  timezoneAnomalies: number;   // events whose tz differs from system tz
  signals: LocationSignal[];
  coverage: string;
}

// ── WiFi via plist (FDDA gated) ──────────────────────────────────────────

function scanWifi(): { accessible: boolean; reason?: string; ssids: { ssid: string; lastConnected?: string }[] } {
  const paths = [
    "/Library/Preferences/com.apple.wifi.known-networks.plist",
    "/Library/Preferences/SystemConfiguration/com.apple.airport.preferences.plist",
  ];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.accessSync(p, fs.constants.R_OK);
    } catch {
      return { accessible: false, reason: `${p.split("/").pop()} requires Full Disk Access`, ssids: [] };
    }
    try {
      const raw = execSync(`plutil -convert json -r -o - "${p}" 2>/dev/null`, {
        encoding: "utf-8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      });
      const data = JSON.parse(raw);
      const ssids: { ssid: string; lastConnected?: string }[] = [];
      if (data.List) {
        for (const entry of data.List) {
          if (entry.SSIDString) ssids.push({ ssid: entry.SSIDString, lastConnected: entry.LastConnected });
        }
      } else if (typeof data === "object") {
        // Modern format: keys are SSIDs
        for (const [k, v] of Object.entries<any>(data)) {
          if (k.length > 0 && !k.startsWith("__")) {
            ssids.push({ ssid: k, lastConnected: v?.JoinedAtTime ?? v?.lastJoined });
          }
        }
      }
      return { accessible: true, ssids: ssids.slice(0, 80) };
    } catch (err: any) {
      return { accessible: false, reason: `plutil failed: ${err.message?.slice(0, 100)}`, ssids: [] };
    }
  }
  return { accessible: false, reason: "No WiFi history file found", ssids: [] };
}

// ── Calendar location aggregation ────────────────────────────────────────

function aggregateCalendarLocations(events: UnifiedEvent[] | undefined): Array<{ location: string; count: number }> {
  if (!events || events.length === 0) return [];
  const counts = new Map<string, number>();
  for (const e of events) {
    const loc = (e.location ?? "").trim();
    if (!loc || loc.length < 2) continue;
    const normalized = loc.toLowerCase().slice(0, 120);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([location, count]) => ({ location, count }));
}

// ── WiFi SSID classification heuristics ──────────────────────────────────

const CAFE_PATTERNS = /(cafe|starbucks|coffee|philz|blue bottle|peet|dunkin|cafe|咖啡|茶)/i;
const PUBLIC_WIFI_PATTERNS = /(guest|visitor|public|free|wifi|hotel|airport|airline|sbux)/i;
const HOME_HINTS = /(home|家|家里|xfinity|ubee|verizon|at&t|spectrum)/i;

function classifyWifi(ssids: { ssid: string }[]): {
  home?: string; work?: string; cafes: string[]; publicWifi: string[];
} {
  const cafes: string[] = [];
  const publicWifi: string[] = [];
  let home: string | undefined;
  let work: string | undefined;

  for (const { ssid } of ssids) {
    if (CAFE_PATTERNS.test(ssid)) cafes.push(ssid);
    else if (PUBLIC_WIFI_PATTERNS.test(ssid)) publicWifi.push(ssid);
    else if (HOME_HINTS.test(ssid) && !home) home = ssid;
  }
  // Naive heuristic: first SSID that's not cafe/public/home might be work
  for (const { ssid } of ssids) {
    if (!CAFE_PATTERNS.test(ssid) && !PUBLIC_WIFI_PATTERNS.test(ssid) && ssid !== home) {
      if (!work) work = ssid;
    }
    if (work) break;
  }
  return { home, work, cafes: cafes.slice(0, 5), publicWifi: publicWifi.slice(0, 5) };
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function scanLocationUnified(opts?: {
  calendarSummary?: CalendarSummary;
  calendarEvents?: UnifiedEvent[];
  systemTimezone?: string;
}): Promise<LocationUnifiedSummary> {
  const wifi = scanWifi();
  const wifiClass = classifyWifi(wifi.ssids);
  const calLocations = aggregateCalendarLocations(opts?.calendarEvents);

  let timezoneAnomalies = 0;
  if (opts?.calendarEvents && opts?.systemTimezone) {
    for (const e of opts.calendarEvents) {
      // If the event's date shifts by >4 hours from sys tz that's a travel signal.
      // Apple Calendar normalizes to local tz so this won't fire often without
      // explicit tz metadata. Placeholder for future enhancement.
    }
  }

  const signals: LocationSignal[] = [];
  if (!wifi.accessible) {
    signals.push({ name: "wifi-history-locked", strength: "weak",
      evidence: wifi.reason ?? "WiFi history not readable" });
  }
  if (wifi.ssids.length >= 30) {
    signals.push({ name: "travel-heavy-wifi-history", strength: "strong",
      evidence: `${wifi.ssids.length} known WiFi networks — many unique places visited` });
  } else if (wifi.ssids.length > 0 && wifi.ssids.length <= 5) {
    signals.push({ name: "homebody-wifi-pattern", strength: "medium",
      evidence: `Only ${wifi.ssids.length} WiFi networks — rarely leaves primary locations` });
  }
  if (wifiClass.cafes.length >= 3) {
    signals.push({ name: "cafe-regular", strength: "medium",
      evidence: `Cafe WiFi: ${wifiClass.cafes.join(", ")}` });
  }
  if (wifiClass.publicWifi.length >= 5) {
    signals.push({ name: "frequent-public-wifi-user", strength: "medium",
      evidence: `${wifiClass.publicWifi.length} public/guest networks (airports, hotels)` });
  }
  if (calLocations.length >= 5) {
    signals.push({ name: "location-diverse-schedule", strength: "medium",
      evidence: `${calLocations.length} unique calendar locations — meets across many places` });
  } else if (calLocations.length === 0 && opts?.calendarEvents && opts.calendarEvents.length > 0) {
    signals.push({ name: "location-less-calendar", strength: "medium",
      evidence: "Calendar has events but zero locations set — remote-first or async life" });
  }

  const coverage = [
    wifi.accessible ? `${wifi.ssids.length} WiFi networks` : `WiFi locked (${wifi.reason ?? "permission"})`,
    calLocations.length > 0 ? `${calLocations.length} calendar locations` : "No calendar locations",
    opts?.systemTimezone ? `TZ: ${opts.systemTimezone}` : "",
  ].filter(Boolean).join(". ");

  const result: LocationUnifiedSummary = {
    wifiAccessible: wifi.accessible,
    wifiReason: wifi.reason,
    knownWifi: wifi.ssids,
    homeWifi: wifiClass.home,
    workWifi: wifiClass.work,
    cafeWifi: wifiClass.cafes,
    calendarLocations: calLocations,
    timezoneAnomalies,
    signals,
    coverage,
  };

  shadowEmit({
    scanner: "location-unified",
    source: "manual",
    kind: "location_scan_summary",
    stableFields: { scanDay: new Date().toISOString().slice(0, 10) },
    payload: {
      wifiAccessible: result.wifiAccessible,
      knownWifiCount: result.knownWifi.length,
      homeWifiCount: result.homeWifi?.length ?? 0,
      workWifiCount: result.workWifi?.length ?? 0,
      cafeWifiCount: result.cafeWifi.length,
      calendarLocationCount: result.calendarLocations.length,
      systemTimezone: opts?.systemTimezone,
    },
  });

  return result;
}

// ── Render ───────────────────────────────────────────────────────────────

export function locationUnifiedToText(s: LocationUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("LOCATION / TRAVEL:");
  if (s.wifiAccessible) {
    lines.push(`  WiFi history: ${s.knownWifi.length} known networks`);
    if (s.homeWifi) lines.push(`    likely home: ${s.homeWifi}`);
    if (s.workWifi) lines.push(`    likely work: ${s.workWifi}`);
    if (s.cafeWifi.length > 0) lines.push(`    cafes: ${s.cafeWifi.join(", ")}`);
  } else {
    lines.push(`  WiFi history: locked (${s.wifiReason})`);
  }
  if (s.calendarLocations.length > 0) {
    lines.push(`  Calendar locations (${s.calendarLocations.length} unique):`);
    for (const loc of s.calendarLocations.slice(0, 8)) {
      lines.push(`    ${String(loc.count).padStart(3)}x ${loc.location.slice(0, 80)}`);
    }
  }
  if (s.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const sig of s.signals) lines.push(`    [${sig.strength}] ${sig.name} — ${sig.evidence}`);
  }
  if (s.coverage) lines.push(`  Coverage: ${s.coverage}`);
  return lines.join("\n");
}
