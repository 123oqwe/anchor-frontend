/**
 * Stale Task Detector cron — daily 10pm. Marks in-progress tasks blocked
 * if they've been open 7+ days without a state change.
 *
 * cron_pattern is LOCKED (end-of-day = right time to flip stale items).
 * voice is USER (none — pure DB op; no LLM).
 * proactive is USER — off by default (status flip surfaces in next morning digest).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const StaleTaskDetectorCronSpec: SystemCronSpec = {
  id: "stale_task_detector",
  schemaVersion: 1,
  name: "Stale Task Detector",
  description: "Daily 22:00 — in-progress tasks idle 7+ days flip to 'blocked'.",

  purpose: locked(
    "Force-honest task statuses: anything still 'in-progress' after 7 days " +
    "without a change is realistically blocked, not progressing. Flip the " +
    "status so the user sees it for what it is."
  ),
  voice: userField("Silent — count only."),

  cron_pattern: locked("0 22 * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
