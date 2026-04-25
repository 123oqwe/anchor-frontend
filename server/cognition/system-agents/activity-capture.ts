/**
 * Activity Capture cron — every 5 minutes. Snapshots the active window
 * (app + title + URL) into activity_captures for later graph mapping.
 *
 * cron_pattern is LOCKED (5min is the resolution the activity-monitor
 * pipeline assumes — changing it would break window aggregation).
 * voice is USER (none — pure capture; no surface).
 * proactive is USER — off (telemetry is silent by definition).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const ActivityCaptureCronSpec: SystemCronSpec = {
  id: "activity_capture",
  schemaVersion: 1,
  name: "Activity Capture",
  description: "Every 5min — snapshot active window into activity_captures.",

  purpose: locked(
    "Sample the active app/window/URL every 5 minutes so downstream graph " +
    "updates have raw activity to work with. Zero LLM cost; pure local " +
    "capture written to activity_captures."
  ),
  voice: userField("Silent."),

  cron_pattern: locked("*/5 * * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
