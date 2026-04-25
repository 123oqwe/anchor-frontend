/**
 * Feedback Detector — DOCUMENTARY ONLY.
 *
 * Daily 4am — scans last 24-72h for re-prompts (user asked similar Q
 * within 15min = previous answer didn't satisfy) and abandonment (plan
 * never executed within 24h = user gave up). Feeds Evolution.
 */

import { locked, userField, addOnly, type SystemAgentSpec } from "../agent-spec.js";

export const FeedbackSpec: SystemAgentSpec = {
  id: "feedback",
  schemaVersion: 1,
  name: "Feedback Detector",
  description: "Detects implicit user signals: re-prompts (didn't satisfy) + abandonments (plan dropped).",
  documentary_only: true,

  soul: {
    purpose: locked(
      "User often doesn't say 'that was wrong' explicitly — they re-ask, or " +
      "they let a plan rot. Detect both. Each signal becomes a row in " +
      "satisfaction_signals for Evolution to learn from."
    ),
    voice: userField("Forensic — outputs are signal counts, not user-facing prose."),
    values: locked([
      "false-positives are worse than false-negatives — better to miss a signal than fabricate one",
      "always link signal back to a specific run_id",
    ]),
  },

  body: {
    role: locked("Feedback Detector — implicit-signal harvester"),
    responsibilities: locked([
      "detectRePrompts: similar query within 15min window",
      "detectAbandonment: plan stalled in pending state >24h",
      "Write satisfaction_signals rows",
    ]),
    constraints: addOnly<string>([
      "Skip detection if user message volume <3 in window (insufficient signal)",
    ]),
  },

  faculty: {
    tools: locked<string[]>([]),
    skills: addOnly<string>([]),
    read_scope: locked<string[]>(["agent_executions", "messages", "agent_jobs"]),
  },

  examples: addOnly<{ input: string; output: string }>([]),

  rhythm: {
    trigger_type: locked("cron"),
    trigger_config: locked({ pattern: "0 4 * * *" }),
    proactive: userField(false),
  },
};
