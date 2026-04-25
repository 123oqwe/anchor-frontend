/**
 * Graph Update from Activity cron — every 6h at :30. Aggregates the prior
 * window of activity_captures into graph_node updates (last_seen, focus
 * spikes, tool-of-record).
 *
 * cron_pattern is LOCKED (offset by :30 to avoid colliding with the
 * top-of-hour ingestion pipeline; same 6h cadence).
 * voice is USER (insights line + count).
 * proactive is USER — off; insights flow through normal memory.
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const GraphUpdateActivityCronSpec: SystemCronSpec = {
  id: "graph_update_activity",
  schemaVersion: 1,
  name: "Graph Update from Activity",
  description: "Every 6h at :30 — fold activity_captures into graph_nodes.",

  purpose: locked(
    "Aggregate the past 6h of activity_captures into graph_node updates: " +
    "refresh last_seen, mark tools-of-record, surface focus-spike insights. " +
    "Offset 30 minutes from ingestion so the two writers don't collide."
  ),
  voice: userField("Count + insight strings."),

  cron_pattern: locked("30 */6 * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
