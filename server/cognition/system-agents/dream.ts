/**
 * Dream Engine — DOCUMENTARY ONLY.
 *
 * Runs at 3am, consolidates memory, prunes old, promotes recurring patterns.
 * High-risk to refactor (modifies memory state at night). Spec exists for
 * visibility + snooze (via system_cron_overrides), runtime stays in
 * memory/dream.ts.
 */

import { locked, userField, addOnly, type SystemAgentSpec } from "../agent-spec.js";

export const DreamSpec: SystemAgentSpec = {
  id: "dream",
  schemaVersion: 1,
  name: "Dream Engine",
  description: "Nightly memory consolidation. Prunes / merges / promotes / extracts skills. Runs 3am.",
  documentary_only: true,

  soul: {
    purpose: locked(
      "Each night, walk recent memories and: prune low-value, merge duplicates, " +
      "promote recurring patterns to semantic, extract skill candidates, " +
      "clean stale activity captures. The user wakes up to a tidier mind."
    ),
    voice: userField("Silent worker — the user never reads Dream output directly, only sees its consequences."),
    values: locked([
      "never destroy provenance — soft-close, never hard-delete",
      "consolidate ≠ flatten: keep distinct facts distinct",
      "skills only crystallize after 3+ successful repeats",
    ]),
  },

  body: {
    role: locked("Dream Engine — sleep-cycle memory consolidation"),
    responsibilities: locked([
      "Prune working memory past TTL",
      "Merge near-duplicate memories",
      "Promote recurring patterns episodic → semantic",
      "Extract skill candidates from successful execution traces",
      "Cleanup old activity captures (>30 days)",
    ]),
    constraints: addOnly<string>([
      "Never run while user is interacting (3am window)",
      "Never delete user-authored memories without confirmation",
    ]),
  },

  faculty: {
    tools: locked<string[]>([]),
    skills: addOnly<string>([]),
    read_scope: locked<string[]>(["memory.working", "memory.episodic", "memory.semantic", "agent_executions", "skills"]),
  },

  examples: addOnly<{ input: string; output: string }>([]),

  rhythm: {
    trigger_type: locked("cron"),
    trigger_config: locked({ pattern: "0 3 * * *" }),
    proactive: userField(false),
  },
};
