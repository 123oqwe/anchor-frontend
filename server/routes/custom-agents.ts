/**
 * Custom Agents — user-created specialized AI agents.
 * Each agent = persona overlay on Decision Agent (instructions + tools).
 */
import { Router } from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { text } from "../infra/compute/index.js";
import { serializeForPrompt } from "../graph/reader.js";
import { extractFromMessage } from "../cognition/extractor.js";
import { writeMemory } from "../memory/retrieval.js";
import { trackPlanDecision } from "../cognition/twin.js";
import { workspacePath } from "../execution/workspace.js";
import { listSkillsForAgent } from "../execution/skill-extractor.js";

const router = Router();

const AGENT_TEMPLATES = [
  { name: "Competitor Analyst", instructions: "You are a competitor analysis expert. Research and compare products, features, pricing, and market positioning. Be thorough and data-driven. Always cite sources.", tools: ["web_search", "read_url"] },
  { name: "Email Drafter", instructions: "You draft professional emails. Match the user's tone (check their communication preferences). Be concise. Always include a clear call-to-action.", tools: ["send_email"] },
  { name: "Code Reviewer", instructions: "You review code for bugs, security vulnerabilities, performance issues, and design problems. Be specific about line numbers and suggest fixes. Use execute_code to run snippets in your workspace when verifying a fix.", tools: ["execute_code", "read_url"] },
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
  const allowedTools: string[] = (() => { try { return JSON.parse(agent.tools) ?? []; } catch { return []; } })();

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

    // Branch: if agent has tools configured, route through ReAct loop so it can
    // actually call them. Otherwise, use plain text() for lower latency/cost.
    let result: string;
    let toolCalls: { name: string; input: any; output: string; success: boolean; latencyMs: number }[] = [];

    if (allowedTools.length > 0) {
      const { runCustomAgentReAct } = await import("../execution/custom-agent-react.js");
      const reactResult = await runCustomAgentReAct({
        agentId: agent.id,
        agentName: agent.name,
        systemPrompt,
        userMessage: message,
        allowedTools,
        runId,
      });
      result = reactResult.text || "(agent completed tool calls but produced no text output)";
      toolCalls = reactResult.toolCalls;
    } else {
      result = await text({
        task: "decision",
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
        maxTokens: 2000,
        runId,
        agentName: `Custom: ${agent.name}`,
      });
    }

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

    res.json({ id: runId, content: result, agentName: agent.name, toolCalls });
  } catch (err: any) {
    db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)")
      .run(nanoid(), DEFAULT_USER_ID, `Custom: ${agent.name}`, message.slice(0, 100), "failed", runId);
    res.status(500).json({ error: err.message });
  }
});

// ══ P12: agentskills.io export/import ══════════════════════════════════════

/**
 * Export a crystallized agent_skill as a SKILL.md file (agentskills.io format).
 * Frontmatter carries name/description/metadata; body wraps the code template
 * in a fenced block so humans can read it and other agents can re-parse it.
 */
router.get("/custom/:id/skills/:name/export", (req, res) => {
  const skill = db.prepare(
    "SELECT * FROM agent_skills WHERE agent_id=? AND name=?"
  ).get(req.params.id, req.params.name) as any;
  if (!skill) return res.status(404).json({ error: "Skill not found" });

  const agent = db.prepare("SELECT name FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;

  // Minimal YAML — single-line string values are safe for the fields we emit.
  const frontmatter = [
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,  // quote to survive colons/commas
    `license: Apache-2.0`,
    `metadata:`,
    `  author: anchor`,
    `  source_agent: ${agent?.name ?? "unknown"}`,
    `  lang: ${skill.lang}`,
    `  success_count: ${skill.success_count}`,
    `  origin: anchor_skill_extractor`,
    `  signature: ${skill.signature}`,
  ].join("\n");

  const body = [
    `# ${skill.name}`,
    ``,
    skill.description,
    ``,
    `## Code template`,
    ``,
    `\`\`\`${skill.lang}`,
    skill.template,
    `\`\`\``,
    ``,
    `_Crystallized by Anchor from ${skill.success_count} successful runs. Compatible with agentskills.io v1._`,
  ].join("\n");

  const content = `---\n${frontmatter}\n---\n\n${body}\n`;

  res.json({
    content,
    filename: `${skill.name}.SKILL.md`,
  });
});

/**
 * Import a SKILL.md — parse minimal YAML frontmatter + fenced code block,
 * insert into agent_skills for this agent. Name collisions auto-suffixed.
 */
router.post("/custom/:id/skills/import", (req, res) => {
  const agent = db.prepare("SELECT id FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const content = String(req.body?.content ?? "");
  if (!content) return res.status(400).json({ error: "content (SKILL.md) required" });

  const parsed = parseSkillMd(content);
  if (!parsed.name) return res.status(400).json({ error: "Frontmatter missing 'name'" });
  if (!parsed.template) return res.status(400).json({ error: "No fenced code block found" });

  const signature = parsed.signature || `imported_${nanoid(8)}`;

  // Idempotent: same (agent_id, signature) → bump success_count, don't duplicate.
  const existing = db.prepare(
    "SELECT id, name FROM agent_skills WHERE agent_id=? AND signature=?"
  ).get(req.params.id, signature) as any;
  if (existing) {
    db.prepare(
      "UPDATE agent_skills SET success_count=success_count+1, last_used_at=datetime('now') WHERE id=?"
    ).run(existing.id);
    return res.json({ id: existing.id, name: existing.name, alreadyExisted: true });
  }

  // Handle name collisions (different signature but same name) by suffixing.
  let finalName = parsed.name;
  let suffix = 1;
  while (db.prepare("SELECT 1 FROM agent_skills WHERE agent_id=? AND name=?").get(req.params.id, finalName)) {
    suffix++;
    finalName = `${parsed.name}_${suffix}`;
    if (suffix > 100) return res.status(400).json({ error: "Too many name collisions" });
  }

  const id = nanoid();
  db.prepare(
    "INSERT INTO agent_skills (id, agent_id, name, description, signature, template, lang, success_count, last_used_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))"
  ).run(
    id, req.params.id, finalName, parsed.description,
    signature,
    parsed.template, parsed.lang || "python",
    parsed.successCount ?? 0
  );
  res.json({ id, name: finalName });
});

/** Minimal SKILL.md parser — no YAML dep. Handles the shape we export + common cases. */
function parseSkillMd(md: string): {
  name?: string; description?: string; lang?: string;
  template?: string; signature?: string; successCount?: number;
} {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const out: any = {};
  if (fm) {
    const lines = fm[1].split("\n");
    for (const line of lines) {
      const m = line.match(/^(\s*)([a-zA-Z_][a-zA-Z_0-9]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const indent = m[1].length;
      const key = m[2];
      let value = m[3].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
      if (indent === 0) {
        if (key === "name") out.name = value;
        else if (key === "description") out.description = value;
      } else {
        // Nested under metadata:
        if (key === "lang") out.lang = value;
        else if (key === "success_count") out.successCount = Number(value) || 0;
        else if (key === "signature") out.signature = value;
      }
    }
  }
  // First fenced code block
  const code = md.match(/```([a-zA-Z]+)?\n([\s\S]*?)\n```/);
  if (code) {
    out.template = code[2];
    if (!out.lang && code[1]) out.lang = code[1];
  }
  return out;
}

// ══ P8: Agent Inspector ═════════════════════════════════════════════════════

/** List files in agent's workspace directory (non-recursive, with size + mtime). */
router.get("/custom/:id/workspace/files", (req, res) => {
  const agent = db.prepare("SELECT name FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const dir = workspacePath(agent.name);
  if (!fs.existsSync(dir)) return res.json({ path: dir, exists: false, files: [] });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.map((e) => {
      const fp = path.join(dir, e.name);
      let size = 0, mtime = "";
      try {
        const s = fs.statSync(fp);
        size = s.size;
        mtime = s.mtime.toISOString();
      } catch {}
      return { name: e.name, isDir: e.isDirectory(), size, mtime };
    });
    // Largest or newest first — feel: "what did the agent just do?"
    files.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
    res.json({ path: dir, exists: true, files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Read a single file from the agent's workspace (safety: path stays in dir). */
router.get("/custom/:id/workspace/file", (req, res) => {
  const agent = db.prepare("SELECT name FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const requested = String(req.query.path ?? "");
  if (!requested) return res.status(400).json({ error: "path query param required" });

  const dir = workspacePath(agent.name);
  const resolved = path.resolve(dir, requested);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    return res.status(403).json({ error: "path escapes workspace" });
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: "is a directory" });
    if (stat.size > 100_000) return res.status(413).json({ error: `file too large (${stat.size} bytes; 100KB cap)` });
    const content = fs.readFileSync(resolved, "utf-8");
    res.json({ path: requested, size: stat.size, mtime: stat.mtime.toISOString(), content });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/** Open the agent's workspace in Finder (Anchor-unique — this IS the user's Mac). */
router.post("/custom/:id/workspace/open", (req, res) => {
  const agent = db.prepare("SELECT name FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const dir = workspacePath(agent.name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "Workspace does not exist yet — run the agent once" });
  try {
    spawn("open", [dir], { detached: true, stdio: "ignore" }).unref();
    res.json({ ok: true, path: dir });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** List this agent's crystallized skills (from P3 skill-extractor). */
router.get("/custom/:id/skills", (req, res) => {
  const agent = db.prepare("SELECT id FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const skills = listSkillsForAgent(agent.id, 20);
  res.json(skills);
});

/** Recent runs — grouped by run_id, combining llm_calls + agent_executions + tool calls. */
router.get("/custom/:id/runs", (req, res) => {
  const agent = db.prepare("SELECT id, name FROM user_agents WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

  // Find recent run_ids for this agent
  const runIds = db.prepare(
    `SELECT DISTINCT run_id, MAX(created_at) as ts
       FROM agent_executions
     WHERE user_id=? AND agent LIKE ? AND run_id IS NOT NULL
     GROUP BY run_id ORDER BY ts DESC LIMIT ?`
  ).all(DEFAULT_USER_ID, `Custom: ${agent.name}%`, limit) as any[];

  const out = runIds.map((r) => {
    const execs = db.prepare(
      "SELECT agent, action, status, created_at as ts FROM agent_executions WHERE user_id=? AND run_id=? ORDER BY created_at ASC"
    ).all(DEFAULT_USER_ID, r.run_id) as any[];
    const llm = db.prepare(
      "SELECT model_id as model, latency_ms as latency, input_tokens as inTok, output_tokens as outTok, status, created_at as ts FROM llm_calls WHERE run_id=? ORDER BY created_at ASC"
    ).all(r.run_id) as any[];
    return {
      runId: r.run_id,
      startedAt: execs[0]?.ts ?? r.ts,
      execs,
      llm,
    };
  });
  res.json(out);
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

Available tools: web_search, read_url, send_email, create_calendar_event, create_reminder, execute_code, delegate, handoff, write_task, update_graph_node, agent_state_get, agent_state_set
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

// ── OPT-3: Agent Pipelines ─────────────────────────────────────────────────

// List pipelines
router.get("/pipelines", (_req, res) => {
  const rows = db.prepare("SELECT * FROM agent_pipelines WHERE user_id=? ORDER BY created_at DESC").all(DEFAULT_USER_ID) as any[];
  res.json(rows.map((p: any) => ({
    ...p,
    steps: JSON.parse(p.steps),
    trigger_config: JSON.parse(p.trigger_config),
  })));
});

// Create pipeline
router.post("/pipelines", (req, res) => {
  const { name, description, steps, trigger_type, trigger_config } = req.body;
  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: "name and non-empty steps required" });
  }
  if (steps.length > 10) return res.status(400).json({ error: "Max 10 steps per pipeline" });

  // Validate each step has agent_id and input_template
  for (const s of steps) {
    if (!s.agent_id || typeof s.input_template !== "string") {
      return res.status(400).json({ error: "Each step needs agent_id and input_template" });
    }
  }

  const id = nanoid();
  db.prepare(
    "INSERT INTO agent_pipelines (id, user_id, name, description, steps, trigger_type, trigger_config) VALUES (?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, name, description ?? "", JSON.stringify(steps), trigger_type ?? "manual", JSON.stringify(trigger_config ?? {}));
  res.json({ id });
});

// Run pipeline
router.post("/pipelines/:id/run", async (req, res) => {
  const { input } = req.body;
  if (typeof input !== "string") return res.status(400).json({ error: "input (string) required" });
  try {
    const { runPipeline } = await import("../orchestration/pipeline.js");
    const result = await runPipeline(req.params.id, input);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List runs
router.get("/pipelines/:id/runs", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM pipeline_runs WHERE pipeline_id=? ORDER BY started_at DESC LIMIT 30"
  ).all(req.params.id);
  res.json(rows.map((r: any) => ({ ...r, step_results: JSON.parse(r.step_results) })));
});

// Delete pipeline
router.delete("/pipelines/:id", (req, res) => {
  db.prepare("DELETE FROM agent_pipelines WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
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
