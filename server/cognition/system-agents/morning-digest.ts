/**
 * Morning Digest cron — Mode C spec (Phase 2 pilot).
 *
 * cron_pattern is LOCKED (timing is contract — user expects 8am).
 * voice is USER (user can change tone).
 * proactive is USER (user can disable user-facing notifications).
 * conditions is ADD_ONLY (user can add pre-fire filters like
 *   "only if energy > 30").
 *
 * Snooze (snooze_until) lives in system_cron_overrides table, separate
 * from spec — it's session-style state, not declarative config.
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const MorningDigestCronSpec: SystemCronSpec = {
  id: "morning_digest",
  schemaVersion: 1,
  name: "Morning Digest",
  description: "8am daily — overnight Anchor activity + today's priority.",

  purpose: locked(
    "Tell the user what happened overnight in Anchor (dreams, scans, " +
    "decisions queued) and surface today's most important thing."
  ),
  voice: userField("Brief, optimistic, action-oriented."),

  cron_pattern: locked("0 8 * * *"),              // 8am daily — locked timing
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(true),
};
