/**
 * Google Calendar REST provider (CLI kind — stateless one-shot HTTPS).
 *
 * Real path: reuses the existing Google OAuth token from token-store.
 * POSTs to calendar.googleapis.com. Matches gmail-rest.ts pattern.
 */
import axios from "axios";
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { getFreshAccessToken, isConnected } from "../../../integrations/token-store.js";
import { DEFAULT_USER_ID } from "../../../infra/storage/db.js";

interface CreateEventInput {
  title: string;
  date: string;               // "YYYY-MM-DD"
  time?: string;              // "HH:MM" 24h
  durationMinutes?: number;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;        // default "primary"
}

interface CreateEventOutput {
  eventId: string;
  htmlLink: string;
  start: string;
  end: string;
}

export const gcalRestProvider: ProviderDef<CreateEventInput, CreateEventOutput> = {
  id: "gcal-rest",
  kind: "cli",
  capability: "calendar.create_event",
  displayName: "Google Calendar (REST API)",
  platforms: ["macos", "windows", "linux"],
  requires: { oauth: "google" },
  concurrency: "parallel",
  rateLimit: { maxPerMinute: 60 },
  targetApp: "calendar.google.com",

  async healthCheck(): Promise<HealthStatus> {
    if (!isConnected(DEFAULT_USER_ID, "google")) {
      return { healthy: false, reason: "Google not connected — Settings → Integrations", checkedAt: Date.now() };
    }
    const token = await getFreshAccessToken(DEFAULT_USER_ID, "google");
    if (!token) return { healthy: false, reason: "Google token invalid — reconnect", checkedAt: Date.now() };
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<CreateEventOutput>> {
    const token = await getFreshAccessToken(DEFAULT_USER_ID, "google");
    if (!token) return { success: false, output: "No Google token", error: "NO_TOKEN", errorKind: "terminal" };

    const time = input.time ?? "09:00";
    const duration = input.durationMinutes ?? 60;
    const start = new Date(`${input.date}T${time}:00`);
    const end = new Date(start.getTime() + duration * 60_000);
    const calendarId = input.calendarId ?? "primary";

    const body: any = {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };
    if (input.attendees?.length) {
      body.attendees = input.attendees.map(email => ({ email }));
    }

    try {
      const res = await axios.post(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        body,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15_000 }
      );
      return {
        success: true,
        output: `Created "${input.title}" on ${input.date} at ${time} (${duration}min) — ${res.data.htmlLink}`,
        data: {
          eventId: res.data.id,
          htmlLink: res.data.htmlLink,
          start: res.data.start?.dateTime ?? start.toISOString(),
          end: res.data.end?.dateTime ?? end.toISOString(),
        },
        rollback: async () => {
          try {
            await axios.delete(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${res.data.id}`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 }
            );
          } catch { /* best-effort */ }
        },
      };
    } catch (err: any) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message ?? err.message;
      return {
        success: false,
        output: `GCal create failed: ${msg}`,
        error: msg,
        errorKind: status === 401 || status === 403 ? "terminal" : "retryable",
      };
    }
  },

  friendlyError(err) {
    if (err?.response?.status === 401) return "Google authorization expired. Reconnect in Settings → Integrations.";
    return err?.message ?? "GCal create failed";
  },
};
