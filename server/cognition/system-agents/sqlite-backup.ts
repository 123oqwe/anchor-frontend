/**
 * SQLite Daily Backup cron — daily 2:55am, runs just before Dream so the
 * snapshot is pre-mutation. Keeps last 7 daily files in server/infra/backups.
 *
 * cron_pattern is LOCKED (must precede Dream's 3am run for pre-mutation
 * snapshots; rotation logic assumes daily cadence).
 * voice is USER (one-line status).
 * proactive is USER — off by default (silent unless failing).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const SqliteBackupCronSpec: SystemCronSpec = {
  id: "sqlite_backup",
  schemaVersion: 1,
  name: "SQLite Daily Backup",
  description: "Daily 02:55 — uses sqlite backup API; keeps last 7 days.",

  purpose: locked(
    "Take a consistent file-level snapshot of anchor.db just before Dream " +
    "begins mutating. Rolling 7-day window — older files auto-pruned. " +
    "Local only; the encrypted weekly backup handles off-device durability."
  ),
  voice: userField("One line per backup: filename."),

  cron_pattern: locked("55 2 * * *"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(false),
};
