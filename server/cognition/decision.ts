/**
 * L3 Cognition — Decision Agent.
 *
 * Pure reasoning: reads L1 graph + L2 memory + Twin priors → produces
 * structured recommendation (editable steps or advice).
 * No HTTP, no DB writes, no side effects.
 */
import { text } from "../infra/compute/index.js";
import { serializeForPrompt as graphPrompt, serializeStateForPrompt, serializeEdgesForPrompt } from "../graph/reader.js";
import { serializeForPrompt as memoryPrompt, serializeTwinForPrompt } from "../memory/retrieval.js";

export interface DecisionResult {
  raw: string;             // full LLM output
  isPlan: boolean;
  structured?: {
    type: string;
    suggestion_summary: string;
    reasoning: string;
    editable_steps: { id: number; content: string; time_estimate?: string }[];
    risk_level: string;
    referenced_nodes: string[];
  };
}

const DECISION_SYSTEM_PROMPT = `You are Anchor's Decision Agent. You know the user through their Human Graph and behavioral patterns.

{STATE}

HUMAN GRAPH:
{GRAPH}

{EDGES}

BEHAVIORAL MEMORY:
{MEMORY}

TWIN INSIGHTS (user behavioral priors):
{TWIN}

RULES:
1. For actionable requests, respond with a JSON object containing editable steps the user can modify.
2. For conversational questions, respond with plain text advice (2-3 sentences, direct, personal).
3. When producing steps, reference specific items from the graph. Factor in twin insights.
4. Always output valid JSON when you detect the user wants a plan, action, or task list.

JSON FORMAT (when actionable):
{
  "type": "plan",
  "suggestion_summary": "One sentence explaining your recommendation",
  "reasoning": "Why this approach, referencing graph/twin data",
  "editable_steps": [
    { "id": 1, "content": "Specific action", "time_estimate": "20min" },
    { "id": 2, "content": "Another action", "time_estimate": "1h" }
  ],
  "risk_level": "low" | "high",
  "referenced_nodes": ["node labels referenced"]
}

PLAIN TEXT FORMAT (when conversational):
Just respond naturally in 2-3 sentences. Be direct and personal.`;

function buildSystemPrompt(): string {
  return DECISION_SYSTEM_PROMPT
    .replace("{STATE}", serializeStateForPrompt())
    .replace("{GRAPH}", graphPrompt())
    .replace("{EDGES}", serializeEdgesForPrompt())
    .replace("{MEMORY}", memoryPrompt())
    .replace("{TWIN}", serializeTwinForPrompt());
}

/** Run the Decision Agent on a user message with conversation history. */
export async function decide(
  message: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<DecisionResult> {
  const system = buildSystemPrompt();

  const raw = await text({
    task: "decision",
    system,
    messages: [...history, { role: "user", content: message }],
    maxTokens: 1024,
  });

  // Try to parse structured plan from response
  let structured: DecisionResult["structured"] = undefined;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.type === "plan" && Array.isArray(parsed?.editable_steps)) {
        structured = parsed;
      }
    }
  } catch {}

  return {
    raw,
    isPlan: !!structured,
    structured,
  };
}
