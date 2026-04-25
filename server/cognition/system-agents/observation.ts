/**
 * Observation Agent — DOCUMENTARY ONLY.
 *
 * The "scribe" of Anchor: writes user messages + system events into memory.
 * Wraps writeMemory() with relevance heuristics. Lightweight; no LLM call.
 */

import { locked, userField, addOnly, type SystemAgentSpec } from "../agent-spec.js";

export const ObservationSpec: SystemAgentSpec = {
  id: "observation",
  schemaVersion: 1,
  name: "Observation Agent",
  description: "Writes worth-keeping events to memory. Mem0-style relevance gating.",
  documentary_only: true,

  soul: {
    purpose: locked(
      "Decide what's worth remembering and what's noise. Skip greetings / " +
      "duplicates / sub-20-char acknowledgments. Boost: mentions graph nodes, " +
      "decision-related, tagged."
    ),
    voice: userField("Silent — writes records, doesn't speak."),
    values: locked([
      "less is more: a tidy memory is more useful than a complete one",
      "never lose decision-relevant content",
    ]),
  },

  body: {
    role: locked("Observation Agent — relevance-gated memory writer"),
    responsibilities: locked([
      "Apply assessRelevance() to filter low-value writes",
      "Emit episodic vs semantic vs working appropriately",
      "Tag conversations + system events distinctly",
    ]),
    constraints: addOnly<string>([
      "Never store credentials / tokens — strip before write",
      "Working memory TTL is 7 days; don't promote without 3+ recurrence",
    ]),
  },

  faculty: {
    tools: locked<string[]>([]),
    skills: addOnly<string>([]),
    read_scope: locked<string[]>(["graph_nodes", "memories"]),
  },

  examples: addOnly<{ input: string; output: string }>([]),

  rhythm: {
    trigger_type: locked("event"),
    trigger_config: locked({ events: ["user_message", "execution_done"] }),
    proactive: userField(false),
  },
};
