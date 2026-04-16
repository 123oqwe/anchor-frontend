/**
 * Event handlers — agent functions triggered by bus events.
 */
import { type ModelMessage } from "ai";
import Anthropic from "@anthropic-ai/sdk";
import { bus, type AnchorEvent, type EditableStep, type StepChange } from "./events.js";
import { db, DEFAULT_USER_ID } from "./db.js";
import { nanoid } from "nanoid";
import { text } from "./cortex/index.js";
import { routeTask } from "./cortex/router.js";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── USER_CONFIRMED → Execution Agent (ReAct) + Twin Agent (sidecar) ─────────
async function onUserConfirmed(payload: {
  original_steps: EditableStep[];
  user_steps: EditableStep[];
  changes: StepChange[];
}) {
  twinLearnFromEdits(payload.changes).catch(err =>
    console.error("[Twin Sidecar] Error:", err.message)
  );
  await runExecutionReAct(payload.user_steps);
}

// ── Execution Agent: ReAct via Anthropic tool_use ─────────────────────────────
async function runExecutionReAct(steps: EditableStep[]) {
  console.log(`[Execution Agent] ReAct starting with ${steps.length} steps...`);
  log("Execution Agent", `ReAct: ${steps.length} steps`);

  const { model: routedModel } = routeTask("react_execution");
  const modelId = routedModel.id;
  console.log(`[Cortex] react_execution → ${routedModel.name} (${routedModel.provider})`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tools: Anthropic.Messages.Tool[] = [
    { name: "write_task", description: "Create a task in the user's Workspace",
      input_schema: { type: "object" as const, properties: { title: { type: "string" }, priority: { type: "string", enum: ["high","medium","low"] } }, required: ["title"] } },
    { name: "update_graph_node", description: "Update a Human Graph node's status",
      input_schema: { type: "object" as const, properties: { label: { type: "string" }, new_status: { type: "string", enum: ["active","done","in-progress","blocked"] } }, required: ["label","new_status"] } },
    { name: "record_outcome", description: "Record an execution outcome to memory",
      input_schema: { type: "object" as const, properties: { summary: { type: "string" } }, required: ["summary"] } },
  ];

  function handleToolCall(name: string, input: any): string {
    if (name === "write_task") {
      const project = db.prepare("SELECT id FROM projects WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
      if (!project) return "No project found.";
      db.prepare("INSERT INTO tasks (id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?)")
        .run(nanoid(), project.id, input.title, "todo", input.priority ?? "high", JSON.stringify(["auto", "react"]));
      log("Execution Agent", `Task: "${input.title}"`);
      return `Task "${input.title}" created (${input.priority ?? "high"}).`;
    }
    if (name === "update_graph_node") {
      const node = db.prepare("SELECT id, label, status FROM graph_nodes WHERE user_id=? AND label LIKE ?").get(DEFAULT_USER_ID, `%${input.label}%`) as any;
      if (!node) return `No node matching "${input.label}".`;
      db.prepare("UPDATE graph_nodes SET status=?, updated_at=datetime('now') WHERE id=?").run(input.new_status, node.id);
      log("Execution Agent", `Graph: "${node.label}" → ${input.new_status}`);
      bus.publish({ type: "GRAPH_UPDATED", payload: { nodeId: node.id, status: input.new_status, label: node.label } });
      return `"${node.label}": ${node.status} → ${input.new_status}.`;
    }
    if (name === "record_outcome") {
      db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, "episodic", "Execution Outcome", input.summary, JSON.stringify(["execution", "auto"]), "Execution Agent", 0.9);
      log("Execution Agent", `Outcome: ${input.summary.slice(0, 50)}`);
      return "Recorded.";
    }
    return "Unknown tool.";
  }

  const stepsText = steps.map(s => `Step ${s.id}: ${s.content}${s.time_estimate ? ` (est: ${s.time_estimate})` : ""}`).join("\n");
  const stepsResult: { step: string; status: string; result: string }[] = [];
  let messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: `Execute this plan:\n${stepsText}` }];

  try {
    for (let turn = 0; turn < 10; turn++) {
      const response = await anthropic.messages.create({
        model: modelId,
        max_tokens: 1024,
        system: "You are Anchor's Execution Agent. Execute each step using the available tools. After all steps, call record_outcome with a summary.",
        tools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b: any) => b.type === "tool_use") as Anthropic.Messages.ToolUseBlock[];
      if (toolUses.length === 0) break;

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const result = handleToolCall(tu.name, tu.input);
        stepsResult.push({ step: tu.name, status: "done", result });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
      if (response.stop_reason === "end_turn") break;
    }

    log("Execution Agent", `ReAct done: ${stepsResult.length} tool calls`);
    console.log(`[Execution Agent] ReAct done. ${stepsResult.length} actions.`);

    bus.publish({
      type: "EXECUTION_DONE",
      payload: { steps_result: stepsResult, plan_summary: steps.map(s => s.content).join("; ") },
    });
  } catch (err: any) {
    console.error("[Execution Agent] ReAct error:", err.message);
    log("Execution Agent", `ReAct failed: ${err.message}`, "failed");
  }
}

// ── Twin: Learn from User Edits (sidecar, async) ────────────────────────────
async function twinLearnFromEdits(changes: StepChange[]) {
  const meaningful = changes.filter(c => c.type !== "kept");
  if (meaningful.length === 0) return;
  console.log("[Twin Sidecar] Learning from user edits...");

  try {
    const result = await text({
      task: "twin_edit_learning",
      system: `You are Anchor's Twin Agent. Observe how the user modifies AI suggestions to learn preferences.\nGiven changes, extract ONE insight. Respond ONLY with JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Changes:\n${meaningful.map(c => {
          if (c.type === "deleted") return `DELETED: "${c.before}"`;
          if (c.type === "modified") return `CHANGED: "${c.before}" → "${c.after}"`;
          if (c.type === "added") return `ADDED: "${c.content}"`;
          return "";
        }).join("\n")}`,
      }],
      maxTokens: 200,
    });

    const jsonMatch = result.match(/\{[^}]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare("INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);
      log("Twin Agent", `Edit insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Sidecar] Error:", err.message);
    log("Twin Agent", `Edit learning failed: ${err.message}`, "failed");
  }
}

// ── Twin: Learn from Execution Results ───────────────────────────────────────
async function twinLearnFromResults(payload: { steps_result: any[]; plan_summary: string }) {
  console.log("[Twin Agent] Learning from execution results...");
  try {
    const result = await text({
      task: "twin_result_learning",
      system: `You are Anchor's Twin Agent. Analyze execution results, extract ONE insight.\nRespond ONLY with JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Plan: ${payload.plan_summary}\n\nResults:\n${payload.steps_result.map(s => `[${s.status}] ${s.step}: ${s.result}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    const jsonMatch = result.match(/\{[^}]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare("INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);
      db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, "episodic", "Execution Result", `Plan: ${payload.plan_summary}. ${payload.steps_result.length} steps.`, JSON.stringify(["execution", "result"]), "Execution Agent", 0.9);
      log("Twin Agent", `Result insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Agent] Error:", err.message);
    log("Twin Agent", `Result learning failed: ${err.message}`, "failed");
  }
}

// ── TWIN_UPDATED → Memory Agent ──────────────────────────────────────────────
function onTwinUpdated(payload: { insight: string }) {
  db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, "semantic", "Behavioral Pattern Detected", payload.insight, JSON.stringify(["twin", "auto-generated"]), "Twin Agent", 0.75);
  log("Memory Agent", "Semantic memory stored");
}

// ── GRAPH_UPDATED → Observation Agent ────────────────────────────────────────
function onGraphUpdated(payload: { nodeId: string; status: string; label: string }) {
  db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, "episodic", `Graph change: ${payload.label}`, `${new Date().toLocaleDateString("zh-CN")}: "${payload.label}" → ${payload.status}.`, JSON.stringify(["graph", "auto"]), "Observation Agent", 0.95);
  db.prepare("UPDATE graph_nodes SET status='todo', updated_at=datetime('now') WHERE user_id=? AND status='blocked'").run(DEFAULT_USER_ID);
  log("Observation Agent", `Graph: "${payload.label}" → ${payload.status}`);
}

// ── TASK_COMPLETED → Twin XP ─────────────────────────────────────────────────
function onTaskCompleted(payload: { taskId: string; title: string }) {
  const evo = db.prepare("SELECT xp, level FROM twin_evolution WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  if (!evo) return;
  const newXp = evo.xp + 5;
  db.prepare("UPDATE twin_evolution SET xp=?, level=?, updated_at=datetime('now') WHERE user_id=?")
    .run(newXp, Math.min(4, Math.floor(newXp / 100) + 1), DEFAULT_USER_ID);
  log("Twin Agent", `+5 XP: "${payload.title.slice(0, 40)}"`);
}

// ── Wire all ─────────────────────────────────────────────────────────────────
export function startEventHandlers() {
  bus.on("event", (e: AnchorEvent) => {
    switch (e.type) {
      case "USER_CONFIRMED":  onUserConfirmed(e.payload);      break;
      case "EXECUTION_DONE":  twinLearnFromResults(e.payload);  break;
      case "TWIN_UPDATED":    onTwinUpdated(e.payload);         break;
      case "GRAPH_UPDATED":   onGraphUpdated(e.payload);        break;
      case "TASK_COMPLETED":  onTaskCompleted(e.payload);       break;
    }
  });
  console.log("⚡ Event handlers: USER_CONFIRMED → Execution(ReAct) + Twin(sidecar) | EXECUTION_DONE → Twin | GRAPH_UPDATED → Observation");
}
