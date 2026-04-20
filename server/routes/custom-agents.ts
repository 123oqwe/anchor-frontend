/**
 * Custom Agents — user-created specialized AI agents.
 * Each agent = persona overlay on Decision Agent (instructions + tools).
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { serializeForPrompt } from "../graph/reader.js";
import { extractFromMessage } from "../cognition/extractor.js";
import { writeMemory } from "../memory/retrieval.js";
import { trackPlanDecision } from "../cognition/twin.js";

const router = Router();

const AGENT_TEMPLATES = [
  { name: "Competitor Analyst", instructions: "You are a competitor analysis expert. Research and compare products, features, pricing, and market positioning. Be thorough and data-driven. Always cite sources.", tools: ["web_search", "read_url"] },
  { name: "Email Drafter", instructions: "You draft professional emails. Match the user's tone (check their communication preferences). Be concise. Always include a clear call-to-action.", tools: ["send_email"] },
  { name: "Code Reviewer", instructions: "You review code for bugs, security vulnerabilities, performance issues, and design problems. Be specific about line numbers and suggest fixes.", tools: ["run_code", "read_url"] },
  { name: "Meeting Prep", instructions: "You prepare briefings for meetings. Research attendees, review past interactions, draft talking points. Focus on what the user needs to know and decide.", tools: ["web_search", "read_url"] },
  { name: "Weekly Strategist", instructions: "You analyze the user's week — what went well, what was avoided, what patterns emerged. Give honest, direct feedback like an executive coach.", tools: [] },
];

// List custom agents
router.get("/custom", (_req, res) => {
  const agents = db.prepare("SELECT * FROM user_agents WHERE user_id=? ORDER BY created_at DESC").all(DEFAULT_USER_ID);
  res.json(agents.map((a: any) => ({ ...a, tools: JSON.parse(a.tools), trigger_config: JSON.parse(a.trigger_config) })));
});

// Get templates
router.get("/custom/templates", (_req, res) => {
  res.json(AGENT_TEMPLATES);
});

// Create custom agent
router.post("/custom", (req, res) => {
  const { name, instructions, tools, trigger_type, trigger_config, model_preference } = req.body;
  if (!name || !instructions) return res.status(400).json({ error: "name and instructions required" });
  const id = nanoid();
  db.prepare("INSERT INTO user_agents (id, user_id, name, instructions, tools, trigger_type, trigger_config, model_preference) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, name, instructions, JSON.stringify(tools ?? []), trigger_type ?? "manual", JSON.stringify(trigger_config ?? {}), model_preference ?? null);
  res.json({ id });
});

// Install template
router.post("/custom/install-template", (req, res) => {
  const { templateIndex } = req.body;
  const template = AGENT_TEMPLATES[templateIndex];
  if (!template) return res.status(400).json({ error: "Invalid template index" });
  const existing = db.prepare("SELECT id FROM user_agents WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, template.name);
  if (existing) return res.json({ ok: true, message: "Already installed" });
  const id = nanoid();
  db.prepare("INSERT INTO user_agents (id, user_id, name, instructions, tools) VALUES (?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, template.name, template.instructions, JSON.stringify(template.tools));
  res.json({ id, installed: true });
});

// Update
router.put("/custom/:id", (req, res) => {
  const { name, instructions, tools, trigger_type, trigger_config } = req.body;
  db.prepare("UPDATE user_agents SET name=?, instructions=?, tools=?, trigger_type=?, trigger_config=? WHERE id=? AND user_id=?")
    .run(name, instructions, JSON.stringify(tools ?? []), trigger_type ?? "manual", JSON.stringify(trigger_config ?? {}), req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// Delete
router.delete("/custom/:id", (req, res) => {
  db.prepare("DELETE FROM user_agents WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// Run custom agent
router.post("/custom/:id/run", async (req, res) => {
  const agent = db.prepare("SELECT * FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const runId = nanoid();  // OPT-4: trace correlation

  try {
    const graphContext = serializeForPrompt();

    // Load previous conversations with this agent (independent memory per agent)
    const prevRuns = db.prepare(
      "SELECT content FROM memories WHERE user_id=? AND source=? AND type='episodic' ORDER BY created_at DESC LIMIT 5"
    ).all(DEFAULT_USER_ID, `Custom: ${agent.name}`) as any[];

    const prevContext = prevRuns.length > 0
      ? `\n\nPREVIOUS CONVERSATIONS WITH THIS AGENT:\n${prevRuns.map((r: any) => r.content.slice(0, 200)).join("\n---\n")}`
      : "";

    const systemPrompt = `${agent.instructions}\n\nUser's Human Graph context:\n${graphContext}${prevContext}`;

    const result = await text({
      task: "decision",
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
      maxTokens: 2000,
      runId,
      agentName: `Custom: ${agent.name}`,
    });

    // Log execution with run_id for trace
    db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)")
      .run(nanoid(), DEFAULT_USER_ID, `Custom: ${agent.name}`, message.slice(0, 100), "success", runId);

    // Save result as episodic memory (so next run has context)
    writeMemory({
      type: "episodic",
      title: `${agent.name}: ${message.slice(0, 40)}`,
      content: `User asked: ${message.slice(0, 100)}\nAgent responded: ${result.slice(0, 300)}`,
      tags: ["custom-agent", agent.name.toLowerCase().replace(/\s+/g, "-")],
      source: `Custom: ${agent.name}`,
      confidence: 0.8,
    });

    // Extract insights into graph (non-blocking, fires async internally)
    extractFromMessage(result);

    res.json({ id: runId, content: result, agentName: agent.name });
  } catch (err: any) {
    db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)")
      .run(nanoid(), DEFAULT_USER_ID, `Custom: ${agent.name}`, message.slice(0, 100), "failed", runId);
    res.status(500).json({ error: err.message });
  }
});

// Rate custom agent response (Twin learning)
router.post("/custom/:id/feedback", (req, res) => {
  const agent = db.prepare("SELECT name FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { rating, context } = req.body; // rating: "good" | "bad"
  if (!rating) return res.status(400).json({ error: "rating required" });

  // Record satisfaction signal for Twin
  db.prepare("INSERT INTO satisfaction_signals (id, user_id, signal_type, context, value) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, rating === "good" ? "agent_approved" : "agent_rejected",
         `Custom Agent: ${agent.name} — ${(context ?? "").slice(0, 100)}`,
         rating === "good" ? 1.0 : -1.0);

  // Feed into Twin pattern tracking
  trackPlanDecision(
    rating === "good" ? "confirmed" : "rejected",
    `Custom Agent "${agent.name}" response`,
    1
  );

  logExecution("Twin Agent", `Custom agent feedback: ${agent.name} → ${rating}`);
  res.json({ ok: true });
});

// Natural language agent creation — user describes what they need, system generates agent config
router.post("/custom/from-description", async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: "description required" });

  try {
    const result = await text({
      task: "twin_edit_learning",
      system: `You create AI agent configurations from natural language descriptions.
Given what the user wants, generate a complete agent config.

Respond ONLY with JSON:
{
  "name": "Short agent name (2-3 words)",
  "instructions": "Detailed system prompt for this agent (2-3 sentences)",
  "tools": ["relevant_tools"],
  "suggested_schedule": null | { "pattern": "cron pattern", "description": "human readable" }
}

Available tools: web_search, read_url, send_email, create_calendar_event, create_reminder, run_code, write_task, update_graph_node
If the user mentions a recurring schedule (weekly, daily, etc), suggest a cron schedule.`,
      messages: [{ role: "user", content: description }],
      maxTokens: 300,
    });

    const stripped = result.replace(/```json\s*/g, "").replace(/```/g, "");
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    if (!parsed.name || !parsed.instructions) {
      return res.status(400).json({ error: "Could not parse agent config" });
    }

    res.json({
      name: parsed.name,
      instructions: parsed.instructions,
      tools: parsed.tools ?? [],
      suggestedSchedule: parsed.suggested_schedule ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── OPT-6: Agent Export / Import ───────────────────────────────────────────

// Export a custom agent as JSON (portable definition)
router.get("/custom/:id/export", (req, res) => {
  const agent = db.prepare("SELECT * FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const kvRows = db.prepare("SELECT key, value FROM agent_kv WHERE agent_id=?").all(agent.id) as any[];
  const stateSchema = kvRows.map((r: any) => ({ key: r.key, type: typeof JSON.parse(r.value) === "object" ? "json" : "string" }));

  res.json({
    version: "1.0",
    kind: "anchor_custom_agent",
    exportedAt: new Date().toISOString(),
    agent: {
      name: agent.name,
      instructions: agent.instructions,
      tools: JSON.parse(agent.tools),
      trigger_type: agent.trigger_type,
      trigger_config: JSON.parse(agent.trigger_config),
      model_preference: agent.model_preference,
    },
    state_schema: stateSchema,
  });
});

// Import a custom agent from JSON (with validation and name collision handling)
router.post("/custom/import", (req, res) => {
  const data = req.body;

  // Schema validation
  if (!data || data.kind !== "anchor_custom_agent") return res.status(400).json({ error: "Invalid format — expected anchor_custom_agent" });
  if (!data.agent || typeof data.agent.name !== "string" || typeof data.agent.instructions !== "string") {
    return res.status(400).json({ error: "Missing name or instructions" });
  }
  if (data.agent.name.length > 100 || data.agent.instructions.length > 10000) {
    return res.status(400).json({ error: "Name or instructions too long" });
  }

  // Name collision handling — auto-suffix if exists
  let finalName = data.agent.name;
  let suffix = 1;
  while (db.prepare("SELECT 1 FROM user_agents WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, finalName)) {
    suffix++;
    finalName = `${data.agent.name} (${suffix})`;
    if (suffix > 100) return res.status(400).json({ error: "Too many collisions" });
  }

  const id = nanoid();
  db.prepare("INSERT INTO user_agents (id, user_id, name, instructions, tools, trigger_type, trigger_config, model_preference) VALUES (?,?,?,?,?,?,?,?)")
    .run(
      id,
      DEFAULT_USER_ID,
      finalName,
      data.agent.instructions,
      JSON.stringify(Array.isArray(data.agent.tools) ? data.agent.tools : []),
      typeof data.agent.trigger_type === "string" ? data.agent.trigger_type : "manual",
      JSON.stringify(data.agent.trigger_config ?? {}),
      data.agent.model_preference ?? null
    );

  logExecution("Custom Agent", `Imported: ${finalName}`);
  res.json({ ok: true, id, name: finalName, renamed: finalName !== data.agent.name });
});

export default router;
