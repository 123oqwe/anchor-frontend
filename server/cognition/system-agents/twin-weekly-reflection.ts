/**
 * Twin Weekly Reflection cron — Monday 9am. Twin Agent extracts ONE
 * behavioural pattern from the past week's executions + tasks, then runs
 * drift detection comparing recent vs older insights.
 *
 * cron_pattern is LOCKED (Monday morning = retrospective window).
 * voice is USER (Twin tone — user may already have customised it).
 * proactive is USER (default ON — insight is meant for the human).
 */

import { locked, userField, addOnly, type SystemCronSpec } from "../agent-spec.js";

export const TwinWeeklyReflectionCronSpec: SystemCronSpec = {
  id: "twin_weekly_reflection",
  schemaVersion: 1,
  name: "Weekly Twin Reflection",
  description: "Monday 09:00 — Twin extracts one behavioural insight + drift check.",

  purpose: locked(
    "Run Twin against the prior 7 days of executions to surface a single " +
    "high-confidence behavioural insight, then compare recent vs older " +
    "insights to detect personality drift."
  ),
  voice: userField("Concise behavioural observation + a question."),

  cron_pattern: locked("0 9 * * 1"),
  conditions: addOnly<{ field: string; op: string; value: any }>([]),
  proactive: userField(true),
};
