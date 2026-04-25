/**
 * Local Apple Calendar Scanner — reads events via AppleScript.
 * macOS will show TCC permission dialog on first run.
 */
import { execSync } from "child_process";
import type { IngestionEvent } from "../types.js";

export function scanCalendar(sinceDaysAgo = 30): IngestionEvent[] {
  try {
    const script = `
      set sinceDate to (current date) - ${sinceDaysAgo} * days
      set output to ""
      tell application "Calendar"
        repeat with cal in every calendar
          set calName to name of cal
          set evts to (every event of cal whose start date >= sinceDate)
          repeat with evt in evts
            set s to summary of evt
            set sd to start date of evt
            set ed to end date of evt
            try
              set loc to location of evt
            on error
              set loc to ""
            end try
            try
              set desc to description of evt
            on error
              set desc to ""
            end try
            try
              set attendeeNames to ""
              repeat with att in every attendee of evt
                set attendeeNames to attendeeNames & name of att & ","
              end repeat
            on error
              set attendeeNames to ""
            end try
            set output to output & s & "|" & sd & "|" & ed & "|" & loc & "|" & attendeeNames & "|" & calName & "|" & desc & "\\n"
          end repeat
        end repeat
        return output
      end tell
    `;

    // Pipe stderr to /dev/null — Calendar.app not running emits -600 to
    // stderr on every run which noisily pollutes server logs.
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}' 2>/dev/null`, {
      timeout: 30000,
      encoding: "utf-8",
    });

    const lines = raw.split("\n").filter(Boolean);
    const events: IngestionEvent[] = [];

    for (const line of lines) {
      const [summary, startDate, endDate, location, attendees, calName, description] = line.split("|");
      if (!summary || summary.trim().length < 2) continue;

      const parts = [
        `Calendar event: ${summary.trim()}`,
        `Date: ${startDate?.trim() ?? ""}`,
        attendees?.trim() ? `Attendees: ${attendees.trim().replace(/,$/, "")}` : "",
        location?.trim() ? `Location: ${location.trim()}` : "",
        calName?.trim() ? `Calendar: ${calName.trim()}` : "",
        description?.trim() ? `Description: ${description.trim().slice(0, 200)}` : "",
      ].filter(Boolean);

      events.push({
        source: "google_calendar" as const, // reuse type
        externalId: `localcal:${summary.trim()}:${startDate?.trim()}`,
        occurredAt: startDate ? new Date(startDate.trim()).toISOString() : new Date().toISOString(),
        rawText: parts.join("\n"),
        metadata: { source: "apple_calendar", summary: summary.trim(), attendees: attendees?.trim() },
      });
    }

    console.log(`[LocalScan] Calendar: ${events.length} events`);
    return events;
  } catch (err: any) {
    if (err.message?.includes("not allowed") || err.message?.includes("-1743")) {
      console.log("[LocalScan] Calendar: permission denied by macOS. User needs to grant access.");
    } else {
      console.error("[LocalScan] Calendar error:", err.message);
    }
    return [];
  }
}
