/**
 * Decay Checker cron — runs every 6h. Marks stale graph nodes as 'decaying'
 * after 5 days of inactivity so the UI can dim them and Twin can flag drift.
 *
 * cron_pattern is LOCKED (decay window must match graph semantics).
 * voice is USER (silent by default — surfaces only via UI dimming).
 * proactive is USER (user can toggle whether decay triggers a notification).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const DecayCheckerCronSpec: SystemCronSpec = {
  id: "decay_checker",
  schemaVersion: 1,
  name: "Decay Checker",
  description: "Every 6h — marks graph nodes 'decaying' after 5 days of no signal.",

  purpose: locked(
    "Sweep graph_nodes for inactivity. Anything not touched in 5 days flips " +
    "to 'decaying' so the UI can dim it and Dream can consider pruning."
  ),
  voice: userField("Silent — emits only when nodes change state."),

  cron_pattern: locked("0 */6 * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
