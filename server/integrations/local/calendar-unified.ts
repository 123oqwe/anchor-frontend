/**
 * Calendar Unification — merges Apple + Google + Fantastical + summarizes.
 *
 * Why this matters commercially:
 *   Anchor's value prop "help me with my schedule" only works if schedule is
 *   actually complete. Most real users have 2-3 calendar sources (work Google
 *   + personal Apple + maybe Outlook) and Anchor saying "you're free Tuesday"
 *   while the user has a Google work meeting is a trust-destroying moment.
 *
 * Strategy (in order of coverage):
 *   1. Apple Calendar (AppleScript) — already carries CalDAV-synced Google if
 *      user set up Internet Accounts, so this is primary
 *   2. Google Calendar API — query directly if OAuth token present, catches
 *      sub-calendars / shared calendars the user didn't add to Apple
 *   3. Fantastical — detect presence (don't parse its DB for now; deferred)
 *
 * Dedup strategy: normalize(summary + startHour) collision → same event.
 * Start hour granularity (not minute) to catch timezone-shifted duplicates.
 *
 * Output:
 *   - UnifiedEvent[] for extractor ingestion (existing IngestionEvent flow)
 *   - CalendarSummary — rich stats for profile inference (Step 7)
 *   - derived signals surfaced in profile text
 */
import axios from "axios";
import { scanCalendar } from "./calendar.js";
import { findApp } from "./app-registry.js";
import { getFreshAccessToken, getTokens } from "../token-store.js";
import { DEFAULT_USER_ID } from "../../infra/storage/db.js";
import type { IngestionEvent } from "../types.js";
import fs from "fs";
import path from "path";
import os from "os";

// ── Types ──────────────────────────────────────────────────────────────────

export type CalendarSource = "apple" | "google" | "fantastical" | "outlook";

export interface UnifiedEvent {
  summary: string;
  startAt: string;        // ISO
  endAt: string;          // ISO
  durationMinutes: number;
  location?: string;
  description?: string;
  attendees: string[];
  calendarName?: string;
  source: CalendarSource;
  dedupKey: string;       // normalize(summary) + start hour bucket
}

export interface CalendarSummary {
  totalEvents: number;
  uniqueEvents: number;          // after dedup
  sources: Record<CalendarSource, number>;
  eventsPerWeek: number;
  workHoursRatio: number;        // fraction during Mon-Fri 9am-6pm
  weekendRatio: number;          // fraction on Sat/Sun
  eveningRatio: number;          // fraction 6pm-11pm
  avgDurationMinutes: number;
  backToBackRate: number;        // fraction of events with another starting within 15min of end
  recurringCount: number;        // same summary appears 3+ times
  uniqueAttendees: number;
  topAttendees: { name: string; count: number }[];
  peakDay: string;               // e.g. "Tuesday"
  peakHour: number;              // 0-23
  signals: CalendarSignal[];
  fantasticalDetected: boolean;
  googleOAuthAvailable: boolean;
}

export interface CalendarSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Apple — reuse existing scanner, normalize output ──────────────────────

function appleToUnified(events: IngestionEvent[]): UnifiedEvent[] {
  const out: UnifiedEvent[] = [];
  for (const e of events) {
    const md: any = e.metadata ?? {};
    const startAt = e.occurredAt;
    const summary = String(md.summary ?? "").trim() || "(no title)";
    // Calendar.ts doesn't emit endAt/duration cleanly — reparse from rawText
    let durationMinutes = 60;
    const durMatch = e.rawText.match(/Duration:\s*(\d+)/i);
    if (durMatch) durationMinutes = parseInt(durMatch[1]);
    const endAt = new Date(new Date(startAt).getTime() + durationMinutes * 60_000).toISOString();
    const attendees = String(md.attendees ?? "")
      .split(",").map((s: string) => s.trim()).filter(Boolean);
    const location = String(md.location ?? "");

    out.push({
      summary,
      startAt,
      endAt,
      durationMinutes,
      location: location || undefined,
      attendees,
      source: "apple",
      dedupKey: dedupKeyFor(summary, startAt),
    });
  }
  return out;
}

// ── Google Calendar — direct API query via OAuth token if available ──────

async function scanGoogleCalendar(sinceDaysAgo: number): Promise<UnifiedEvent[]> {
  const tokens = getTokens(DEFAULT_USER_ID, "google");
  if (!tokens) return [];
  try {
    const access = await getFreshAccessToken(DEFAULT_USER_ID, "google");
    if (!access) return [];

    const timeMin = new Date(Date.now() - sinceDaysAgo * 86400_000).toISOString();
    const timeMax = new Date(Date.now() + 60 * 86400_000).toISOString();   // 60 days forward

    // List user's calendars first
    const calListResp = await axios.get("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: { Authorization: "Bearer " + access },
      timeout: 10_000,
    }).catch(() => null);
    if (!calListResp) return [];

    const calendars = (calListResp.data?.items ?? []).map((c: any) => ({
      id: c.id as string,
      name: c.summaryOverride ?? c.summary ?? c.id,
      primary: !!c.primary,
    }));

    const all: UnifiedEvent[] = [];
    for (const cal of calendars) {
      const q = new URLSearchParams({
        timeMin, timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      const resp = await axios.get(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`,
        { headers: { Authorization: "Bearer " + access }, timeout: 15_000 }
      ).catch(() => null);
      if (!resp) continue;

      for (const e of resp.data?.items ?? []) {
        const startRaw = e.start?.dateTime ?? e.start?.date;
        const endRaw = e.end?.dateTime ?? e.end?.date;
        if (!startRaw) continue;
        const startAt = new Date(startRaw).toISOString();
        const endAt = endRaw ? new Date(endRaw).toISOString() : startAt;
        const durationMinutes = Math.max(1, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000));
        const summary = String(e.summary ?? "(no title)").trim();
        const attendees = (e.attendees ?? [])
          .map((a: any) => a.displayName ?? a.email ?? "")
          .filter(Boolean) as string[];

        all.push({
          summary,
          startAt, endAt, durationMinutes,
          location: e.location ?? undefined,
          description: e.description ?? undefined,
          attendees,
          calendarName: cal.name,
          source: "google",
          dedupKey: dedupKeyFor(summary, startAt),
        });
      }
    }
    return all;
  } catch {
    return [];
  }
}

// ── Fantastical detection (presence-only for now) ─────────────────────────

function fantasticalInstalled(): boolean {
  return !!findApp("Fantastical") &&
    (fs.existsSync("/Applications/Fantastical.app") ||
     fs.existsSync(path.join(os.homedir(), "Applications/Fantastical.app")));
}

// ── Dedup key + merge ─────────────────────────────────────────────────────

function dedupKeyFor(summary: string, startAt: string): string {
  const norm = summary.toLowerCase().trim().replace(/[^\w\u4e00-\u9fff]+/g, "");
  const hour = new Date(startAt).toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return `${norm}|${hour}`;
}

function mergeAndDedup(...lists: UnifiedEvent[][]): UnifiedEvent[] {
  const bySource: Record<string, CalendarSource> = {};
  const byKey = new Map<string, UnifiedEvent>();
  for (const list of lists) {
    for (const e of list) {
      const existing = byKey.get(e.dedupKey);
      if (!existing) {
        byKey.set(e.dedupKey, e);
      } else {
        // Source priority: google (most structured) > apple > fantastical
        if (e.source === "google" && existing.source !== "google") byKey.set(e.dedupKey, e);
        if (existing.attendees.length === 0 && e.attendees.length > 0) byKey.set(e.dedupKey, e);
      }
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.startAt.localeCompare(b.startAt));
}

// ── Summary computation ───────────────────────────────────────────────────

export function summarizeCalendar(events: UnifiedEvent[], sinceDaysAgo = 30): CalendarSummary {
  const sources: Record<CalendarSource, number> = { apple: 0, google: 0, fantastical: 0, outlook: 0 };
  let workHoursCount = 0;
  let weekendCount = 0;
  let eveningCount = 0;
  let totalDuration = 0;
  let backToBackCount = 0;
  const summaryFreq = new Map<string, number>();
  const attendeeFreq = new Map<string, number>();
  const dayFreq = new Array(7).fill(0);
  const hourFreq = new Array(24).fill(0);

  // Sort by start to compute back-to-back
  const sorted = [...events].sort((a, b) => a.startAt.localeCompare(b.startAt));

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    sources[e.source]++;
    const d = new Date(e.startAt);
    const day = d.getDay();          // 0=Sun
    const hour = d.getHours();
    totalDuration += e.durationMinutes;
    dayFreq[day]++;
    hourFreq[hour]++;
    if (day === 0 || day === 6) weekendCount++;
    if (day >= 1 && day <= 5 && hour >= 9 && hour < 18) workHoursCount++;
    if (hour >= 18 && hour < 23) eveningCount++;

    const s = e.summary.toLowerCase().trim();
    if (s) summaryFreq.set(s, (summaryFreq.get(s) ?? 0) + 1);
    for (const a of e.attendees) {
      const name = a.trim();
      if (name) attendeeFreq.set(name, (attendeeFreq.get(name) ?? 0) + 1);
    }

    // Back-to-back: next event starts within 15min of this end
    if (i < sorted.length - 1) {
      const gap = (new Date(sorted[i + 1].startAt).getTime() - new Date(e.endAt).getTime()) / 60_000;
      if (gap >= 0 && gap <= 15) backToBackCount++;
    }
  }

  const totalEvents = events.length;
  const eventsPerWeek = sinceDaysAgo > 0 ? Math.round((totalEvents / sinceDaysAgo) * 7 * 10) / 10 : 0;
  const workHoursRatio = totalEvents > 0 ? workHoursCount / totalEvents : 0;
  const weekendRatio = totalEvents > 0 ? weekendCount / totalEvents : 0;
  const eveningRatio = totalEvents > 0 ? eveningCount / totalEvents : 0;
  const avgDuration = totalEvents > 0 ? totalDuration / totalEvents : 0;
  const backToBackRate = totalEvents > 1 ? backToBackCount / (totalEvents - 1) : 0;

  const recurringCount = Array.from(summaryFreq.values()).filter(c => c >= 3).length;
  const uniqueAttendees = attendeeFreq.size;
  const topAttendees = Array.from(attendeeFreq.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, 10);

  const peakDayIdx = dayFreq.indexOf(Math.max(...dayFreq));
  const peakHour = hourFreq.indexOf(Math.max(...hourFreq));
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const signals: CalendarSignal[] = [];
  if (totalEvents === 0) signals.push({ name: "calendar-empty", strength: "strong", evidence: "No events found — either calendar is truly empty or not accessible" });
  if (eventsPerWeek >= 20) signals.push({ name: "meeting-heavy-professional", strength: "strong", evidence: `${eventsPerWeek} events/week` });
  else if (eventsPerWeek >= 10) signals.push({ name: "meeting-regular", strength: "medium", evidence: `${eventsPerWeek} events/week` });
  else if (eventsPerWeek > 0 && eventsPerWeek < 3) signals.push({ name: "async-lifestyle-low-meetings", strength: "medium", evidence: `${eventsPerWeek} events/week — mostly async` });

  if (backToBackRate >= 0.3) signals.push({ name: "back-to-back-scheduler", strength: "strong", evidence: `${Math.round(backToBackRate * 100)}% of events are back-to-back` });
  if (weekendRatio >= 0.15) signals.push({ name: "weekend-worker-or-social", strength: "medium", evidence: `${Math.round(weekendRatio * 100)}% of events on weekends` });
  if (eveningRatio >= 0.25) signals.push({ name: "evening-calendar-user", strength: "medium", evidence: `${Math.round(eveningRatio * 100)}% of events after 6pm` });
  if (workHoursRatio >= 0.7) signals.push({ name: "strict-work-hours-pattern", strength: "medium", evidence: `${Math.round(workHoursRatio * 100)}% during Mon-Fri 9-6` });
  if (recurringCount >= 5) signals.push({ name: "ritual-recurring-meeting-keeper", strength: "medium", evidence: `${recurringCount} recurring events` });

  // Long focus blocks signal
  const longBlocks = events.filter(e => e.durationMinutes >= 120).length;
  if (longBlocks >= 3) signals.push({ name: "long-focus-block-scheduler", strength: "medium", evidence: `${longBlocks} events ≥ 2hrs` });

  // Cross-source usage signal
  const sourceCount = Object.values(sources).filter(c => c > 0).length;
  if (sourceCount >= 2) signals.push({ name: "multi-calendar-user", strength: "medium", evidence: `uses ${sourceCount} calendar sources` });

  return {
    totalEvents,
    uniqueEvents: totalEvents,   // already deduped before summary
    sources,
    eventsPerWeek,
    workHoursRatio,
    weekendRatio,
    eveningRatio,
    avgDurationMinutes: Math.round(avgDuration),
    backToBackRate: Math.round(backToBackRate * 100) / 100,
    recurringCount,
    uniqueAttendees,
    topAttendees,
    peakDay: DAYS[peakDayIdx],
    peakHour,
    signals,
    fantasticalDetected: fantasticalInstalled(),
    googleOAuthAvailable: !!getTokens(DEFAULT_USER_ID, "google"),
  };
}

// ── Main entry ────────────────────────────────────────────────────────────

export async function scanAllCalendars(sinceDaysAgo = 30): Promise<{
  events: UnifiedEvent[];
  summary: CalendarSummary;
}> {
  const appleIngested = scanCalendar(sinceDaysAgo);
  const appleEvents = appleToUnified(appleIngested);
  const googleEvents = await scanGoogleCalendar(sinceDaysAgo);
  const merged = mergeAndDedup(appleEvents, googleEvents);
  const summary = summarizeCalendar(merged, sinceDaysAgo);
  console.log(`[CalendarUnified] apple=${appleEvents.length} google=${googleEvents.length} → unified=${merged.length}. ${summary.eventsPerWeek}/wk, peak ${summary.peakDay} ${summary.peakHour}:00`);
  return { events: merged, summary };
}

// ── Compat: convert to IngestionEvent for existing extractor pipeline ────

export function unifiedToIngestion(events: UnifiedEvent[]): IngestionEvent[] {
  return events.map((e) => ({
    source: "google_calendar" as const,
    externalId: `unified:${e.source}:${e.summary}:${e.startAt}`,
    occurredAt: e.startAt,
    rawText: [
      `Calendar event: ${e.summary}`,
      `Date: ${e.startAt}`,
      `Duration: ${e.durationMinutes} min`,
      e.attendees.length > 0 ? `Attendees: ${e.attendees.join(", ")}` : "",
      e.location ? `Location: ${e.location}` : "",
      e.calendarName ? `Calendar: ${e.calendarName}` : "",
      e.description ? `Description: ${e.description.slice(0, 300)}` : "",
      `Source: ${e.source}`,
    ].filter(Boolean).join("\n"),
    metadata: { source: e.source, summary: e.summary, attendees: e.attendees.join(","), location: e.location },
  }));
}

// ── Render for extractor ──────────────────────────────────────────────────

export function calendarSummaryToText(summary: CalendarSummary): string {
  const lines: string[] = [];
  lines.push("CALENDAR PROFILE:");
  if (summary.totalEvents === 0) {
    lines.push("  No calendar events found.");
    if (!summary.googleOAuthAvailable) lines.push("  Google Calendar OAuth not granted — user may have events there.");
    return lines.join("\n");
  }
  const sources = Object.entries(summary.sources).filter(([_, n]) => n > 0).map(([s, n]) => `${s}(${n})`).join(", ");
  lines.push(`  Total events: ${summary.totalEvents} (${summary.eventsPerWeek}/week). Sources: ${sources}`);
  if (summary.fantasticalDetected) lines.push(`  Fantastical installed but DB not parsed (can be added later).`);
  lines.push(`  Peak activity: ${summary.peakDay}, ~${summary.peakHour}:00`);
  lines.push(`  Rhythm: ${(summary.workHoursRatio * 100).toFixed(0)}% work hours · ${(summary.weekendRatio * 100).toFixed(0)}% weekend · ${(summary.eveningRatio * 100).toFixed(0)}% evening`);
  lines.push(`  Average duration: ${summary.avgDurationMinutes}min. Back-to-back rate: ${(summary.backToBackRate * 100).toFixed(0)}%. Recurring: ${summary.recurringCount} series.`);
  if (summary.topAttendees.length > 0) {
    const top = summary.topAttendees.slice(0, 5).map(a => `${a.name}(${a.count})`).join(", ");
    lines.push(`  Top collaborators (${summary.uniqueAttendees} unique total): ${top}`);
  }
  if (summary.signals.length > 0) {
    lines.push("  Signals:");
    for (const s of summary.signals) lines.push(`    [${s.strength}] ${s.name} — ${s.evidence}`);
  }
  return lines.join("\n");
}
