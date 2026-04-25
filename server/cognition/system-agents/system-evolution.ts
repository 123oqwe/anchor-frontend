/**
 * System Evolution cron — Sunday 6am, after GEPA. Applies routing
 * optimisations to the model router based on GEPA's findings.
 *
 * cron_pattern is LOCKED (must run after GEPA — order matters; routing
 * changes apply immediately for the coming week).
 * voice is USER (routes-updated count).
 * proactive is USER — off (system-internal change; user can read the changelog).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const SystemEvolutionCronSpec: SystemCronSpec = {
  id: "system_evolution",
  schemaVersion: 1,
  name: "System Evolution",
  description: "Sunday 06:00 — applies model-router optimisations from GEPA.",

  purpose: locked(
    "Take GEPA's optimisation candidates and apply the router changes that " +
    "would reduce cost / latency without dropping quality. Sequenced after " +
    "GEPA so the analysis is current."
  ),
  voice: userField("Routes-updated count."),

  cron_pattern: locked("0 6 * * 0"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
