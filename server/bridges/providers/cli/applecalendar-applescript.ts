/**
 * Apple Calendar (direct AppleScript) — Tier 0, zero setup on macOS.
 *
 * Works because Calendar.app syncs with whichever calendar service the user
 * already configured (iCloud, Google via macOS Accounts, Exchange). Anchor
 * doesn't need its own OAuth.
 */
import { runCli, hasBinary } from "./base.js";
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";

interface CreateEventInput {
  title: string;
  date: string;               // YYYY-MM-DD
  time?: string;              // HH:MM 24h
  durationMinutes?: number;
  description?: string;
  location?: string;
  calendarName?: string;      // target a specific local calendar (default: first)
}

function buildScript(input: CreateEventInput): string {
  const q = (s: string) => `"${(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '" & return & "')}"`;
  const time = input.time ?? "09:00";
  const duration = input.durationMinutes ?? 60;
  const [year, month, day] = input.date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  const calendarTarget = input.calendarName
    ? `calendar ${q(input.calendarName)}`
    : `calendar 1`;

  return `tell application "Calendar"
  tell ${calendarTarget}
    set startDate to current date
    set year of startDate to ${year}
    set month of startDate to ${month}
    set day of startDate to ${day}
    set hours of startDate to ${hour}
    set minutes of startDate to ${minute}
    set seconds of startDate to 0
    set endDate to startDate + ${duration} * minutes
    set newEvent to make new event with properties {summary:${q(input.title)}, start date:startDate, end date:endDate${input.description ? `, description:${q(input.description)}` : ""}${input.location ? `, location:${q(input.location)}` : ""}}
    return id of newEvent
  end tell
end tell`;
}

export const appleCalendarAppleScriptProvider: ProviderDef<CreateEventInput, { eventId: string }> = {
  id: "applecalendar-applescript",
  kind: "cli",
  capability: "calendar.create_event",
  displayName: "Apple Calendar (direct)",
  platforms: ["macos"],
  requires: {},
  concurrency: "serial",
  rateLimit: { maxPerMinute: 30 },
  // No targetApp — Calendar.app is governed by macOS Automation permission.

  async healthCheck(): Promise<HealthStatus> {
    if (process.platform !== "darwin") {
      return { healthy: false, reason: "macOS only", checkedAt: Date.now() };
    }
    const has = await hasBinary("osascript");
    if (!has) return { healthy: false, reason: "osascript missing", checkedAt: Date.now() };

    const r = await runCli(
      "osascript",
      ["-e", 'tell application "Finder" to exists application file id "com.apple.iCal"'],
      { timeoutMs: 3_000 }
    );
    if (r.stdout.trim() !== "true") {
      return { healthy: false, reason: "Calendar.app not installed", checkedAt: Date.now() };
    }
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<{ eventId: string }>> {
    const script = buildScript(input);
    const r = await runCli("osascript", ["-e", script], { timeoutMs: 15_000 });

    if (r.exitCode !== 0) {
      const msg = r.stderr.trim();
      if (msg.includes("-1743") || msg.toLowerCase().includes("not authorized")) {
        return {
          success: false,
          output: "Calendar.app access denied. Grant Automation permission in System Settings → Privacy & Security → Automation.",
          error: "PERMISSION_DENIED",
          errorKind: "terminal",
        };
      }
      return {
        success: false,
        output: `Calendar create failed: ${msg.slice(0, 200)}`,
        error: msg,
        errorKind: "retryable",
      };
    }

    const eventId = r.stdout.trim();
    return {
      success: true,
      output: `Created "${input.title}" on ${input.date} at ${input.time ?? "09:00"} (Apple Calendar)`,
      data: { eventId },
    };
  },

  friendlyError(err) {
    const msg = String(err?.message ?? err ?? "").toLowerCase();
    if (msg.includes("not authorized") || msg.includes("-1743")) {
      return "Calendar needs permission. System Settings → Privacy & Security → Automation.";
    }
    return err?.message ?? "Apple Calendar failed";
  },
};
