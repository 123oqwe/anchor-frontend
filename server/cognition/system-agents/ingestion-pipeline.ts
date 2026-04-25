/**
 * Ingestion Pipeline cron — every 6h. Incremental Gmail + Calendar scan,
 * builds graph nodes from new events.
 *
 * cron_pattern is LOCKED (6h cadence balances API quotas vs freshness).
 * voice is USER (status counts; user may want chattier).
 * proactive is USER — off by default (results surface via new graph nodes).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const IngestionPipelineCronSpec: SystemCronSpec = {
  id: "ingestion_pipeline",
  schemaVersion: 1,
  name: "Ingestion Pipeline",
  description: "Every 6h — incremental Gmail + Calendar fetch into the graph.",

  purpose: locked(
    "Pull only new Gmail + Calendar events since the last cursor and " +
    "convert them into graph nodes. Incremental, not full re-scan, to " +
    "respect API quotas and avoid duplicate processing."
  ),
  voice: userField("Counts only: events fetched → nodes created."),

  cron_pattern: locked("0 */6 * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
