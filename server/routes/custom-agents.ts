/**
 * Custom Agents — user-created specialized AI agents.
 * Each agent = persona overlay on Decision Agent (instructions + tools).
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { serializeForPrompt } from "../graph/reader.js";

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

  try {
    const graphContext = serializeForPrompt();
    const systemPrompt = `${agent.instructions}\n\nUser's Human Graph context:\n${graphContext}`;

    const result = await text({
      task: "decision",
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
      maxTokens: 2000,
    });

    // Log execution
    db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
      .run(nanoid(), DEFAULT_USER_ID, `Custom: ${agent.name}`, message.slice(0, 100), "success");

    res.json({ content: result, agentName: agent.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
