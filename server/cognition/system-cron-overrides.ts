/**
 * L3 Cognition — System cron user-controlled overrides.
 *
 * Companion to agent-spec.ts but for crons (which don't go through the
 * full Soul/Body/Faculty composer). Cron overrides are flat:
 *   - snooze_until: pause the cron until ISO timestamp
 *   - proactive_off: disable user-facing notifications
 *   - user_added_conditions: extra pre-fire filters
 *
 * Used by orchestration/cron.ts gate before invoking any system cron body.
 */

import { db } from "../infra/storage/db.js";

export interface CronOverride {
  cron_id: string;
  snooze_until: string | null;
  proactive_off: number;
  user_added_conditions: any[];
}

export function getSystemCronOverride(cronId: string): CronOverride | null {
  try {
    const row = db.prepare(
      "SELECT cron_id, snooze_until, proactive_off, user_added_conditions FROM system_cron_overrides WHERE cron_id = ?"
    ).get(cronId) as any;
    if (!row) return null;
    return {
      cron_id: row.cron_id,
      snooze_until: row.snooze_until,
      proactive_off: row.proactive_off,
      user_added_conditions: (() => {
        try { return JSON.parse(row.user_added_conditions); } catch { return []; }
      })(),
    };
  } catch {
    // Table doesn't exist yet (pre-migration boot) — treat as no override.
    return null;
  }
}

export function isCronSnoozed(cronId: string): boolean {
  const o = getSystemCronOverride(cronId);
  if (!o?.snooze_until) return false;
  const until = new Date(o.snooze_until).getTime();
  return !Number.isNaN(until) && until > Date.now();
}

export function isCronDisabled(cronId: string): boolean {
  const o = getSystemCronOverride(cronId);
  return !!o?.proactive_off;
}
