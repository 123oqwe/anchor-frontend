/**
 * Proactive Suggestion Check cron — every 12h. Scans for trigger conditions
 * (overdue tasks, decay clusters, energy dips) and writes a working-memory
 * note that the next Decision pass picks up.
 *
 * cron_pattern is LOCKED (12h gives the system two distinct daily windows
 * without spamming the working-memory shelf).
 * voice is USER (one-line trigger reason).
 * proactive is USER (default ON — that's literally the agent's job).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const ProactiveCheckCronSpec: SystemCronSpec = {
  id: "proactive_check",
  schemaVersion: 1,
  name: "Proactive Suggestion Check",
  description: "Every 12h — scans system state for proactive triggers.",

  purpose: locked(
    "Look for system signals (overdue, decay clusters, low-energy windows) " +
    "that warrant a proactive nudge. On hit, write a working-memory note so " +
    "the next Decision context surfaces it without spamming a notification."
  ),
  voice: userField("One sentence: reason + suggested action."),

  cron_pattern: locked("0 */12 * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(true),
};
