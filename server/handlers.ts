/**
 * Event handlers — agent functions triggered by bus events.
 */
import Anthropic from "@anthropic-ai/sdk";
import { bus, type AnchorEvent, type EditableStep, type StepChange } from "./events.js";
import { db, DEFAULT_USER_ID } from "./db.js";
import { nanoid } from "nanoid";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  // Fire Twin sidecar (async, non-blocking)
  twinLearnFromEdits(payload.changes).catch(err =>
    console.error("[Twin Sidecar] Error:", err.message)
  );

  // Run Execution Agent (ReAct loop)
  await runExecutionReAct(payload.user_steps);
}

// ── Execution Agent: ReAct Loop ──────────────────────────────────────────────
async function runExecutionReAct(steps: EditableStep[]) {
  console.log(`[Execution Agent] ReAct starting with ${steps.length} steps...`);
  log("Execution Agent", `ReAct: ${steps.length} steps to execute`);

  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "write_task",
      description: "Create a task in the user's Workspace",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Task title" },
          priority: { type: "string", enum: ["high", "medium", "low"], description: "Task priority" },
        },
        required: ["title"],
      },
    },
    {
      name: "update_graph_node",
      description: "Update a Human Graph node's status",
      input_schema: {
        type: "object" as const,
        properties: {
          label: { type: "string", description: "The node label to find and update" },
          new_status: { type: "string", enum: ["active", "done", "in-progress", "blocked"], description: "New status" },
        },
        required: ["label", "new_status"],
      },
    },
    {
      name: "record_outcome",
      description: "Record an execution outcome to memory",
      input_schema: {
        type: "object" as const,
        properties: {
          summary: { type: "string", description: "What was accomplished" },
        },
        required: ["summary"],
      },
    },
  ];

  function handleToolCall(name: string, input: any): string {
    switch (name) {
      case "write_task": {
        const project = db.prepare(
          "SELECT id FROM projects WHERE user_id=? ORDER BY created_at DESC LIMIT 1"
        ).get(DEFAULT_USER_ID) as any;
        if (!project) return "No project found to create task in.";
        db.prepare(
          "INSERT INTO tasks (id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?)"
        ).run(nanoid(), project.id, input.title, "todo", input.priority ?? "high", JSON.stringify(["auto", "react"]));
        log("Execution Agent", `Task created: "${input.title}"`);
        return `Task "${input.title}" created with priority ${input.priority ?? "high"}.`;
      }
      case "update_graph_node": {
        const node = db.prepare(
          "SELECT id, label, status FROM graph_nodes WHERE user_id=? AND label LIKE ?"
        ).get(DEFAULT_USER_ID, `%${input.label}%`) as any;
        if (!node) return `No graph node found matching "${input.label}".`;
        db.prepare("UPDATE graph_nodes SET status=?, updated_at=datetime('now') WHERE id=?")
          .run(input.new_status, node.id);
        log("Execution Agent", `Graph: "${node.label}" → ${input.new_status}`);
        bus.publish({ type: "GRAPH_UPDATED", payload: { nodeId: node.id, status: input.new_status, label: node.label } });
        return `Updated "${node.label}" from ${node.status} to ${input.new_status}.`;
      }
      case "record_outcome": {
        db.prepare(
          "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
        ).run(nanoid(), DEFAULT_USER_ID, "episodic", "Execution Outcome", input.summary, JSON.stringify(["execution", "auto"]), "Execution Agent", 0.9);
        log("Execution Agent", `Outcome recorded: ${input.summary.slice(0, 50)}`);
        return `Outcome recorded to memory.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  const stepsText = steps.map(s => `Step ${s.id}: ${s.content}${s.time_estimate ? ` (est: ${s.time_estimate})` : ""}`).join("\n");

  let messages: Anthropic.Messages.MessageParam[] = [{
    role: "user",
    content: `Execute this user-confirmed plan step by step. Use the tools for each step. After all steps, call record_outcome with a summary.\n\nPlan:\n${stepsText}`,
  }];

  const stepsResult: { step: string; status: string; result: string }[] = [];

  try {
    for (let turn = 0; turn < 10; turn++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: "You are Anchor's Execution Agent. Execute each step using the available tools. Think about what to do, act with a tool, observe the result, then continue. Be systematic.",
        tools,
        messages,
      });

      // Collect text and tool_use blocks
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolUses = assistantContent.filter((b: any) => b.type === "tool_use");
      if (toolUses.length === 0) break; // Agent is done

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const toolBlock = tu as Anthropic.Messages.ToolUseBlock;
        const result = handleToolCall(toolBlock.name, toolBlock.input);
        stepsResult.push({ step: toolBlock.name, status: "done", result });
        toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });

      if (response.stop_reason === "end_turn") break;
    }

    log("Execution Agent", `ReAct complete: ${stepsResult.length} tool calls`);
    console.log(`[Execution Agent] ReAct done. ${stepsResult.length} actions taken.`);

    // Emit EXECUTION_DONE → Twin learns from results
    bus.publish({
      type: "EXECUTION_DONE",
      payload: {
        steps_result: stepsResult,
        plan_summary: steps.map(s => s.content).join("; "),
      },
    });
  } catch (err: any) {
    console.error("[Execution Agent] ReAct error:", err.message);
    log("Execution Agent", `ReAct failed: ${err.message}`, "failed");
  }
}

// ── Twin Agent: Learn from User Edits (sidecar, async) ───────────────────────
async function twinLearnFromEdits(changes: StepChange[]) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const meaningful = changes.filter(c => c.type !== "kept");
  if (meaningful.length === 0) return;

  console.log("[Twin Sidecar] Learning from user edits...");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are Anchor's Twin Agent. You observe how the user modifies AI suggestions to learn their preferences.
Given a list of changes the user made to a suggested plan, extract ONE behavioral insight.
Respond ONLY with JSON: {"category":"string","insight":"string","confidence":0.0-1.0}
Categories: communication_preference, delegation_style, risk_tolerance, planning_detail, time_management, avoidance_pattern`,
      messages: [{
        role: "user",
        content: `User changes to the suggested plan:\n${meaningful.map(c => {
          if (c.type === "deleted") return `DELETED: "${c.before}"`;
          if (c.type === "modified") return `CHANGED: "${c.before}" → "${c.after}"`;
          if (c.type === "added") return `ADDED: "${c.content}"`;
          return "";
        }).join("\n")}`,
      }],
    });

    const text = (response.content[0] as any).text as string;
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare(
        "INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)"
      ).run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);
      log("Twin Agent", `Edit insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
      console.log("[Twin Sidecar] Edit insight saved.");
    }
  } catch (err: any) {
    console.error("[Twin Sidecar] Error:", err.message);
    log("Twin Agent", `Edit learning failed: ${err.message}`, "failed");
  }
}

// ── EXECUTION_DONE → Twin Agent learns from results ──────────────────────────
async function twinLearnFromResults(payload: { steps_result: any[]; plan_summary: string }) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  console.log("[Twin Agent] Learning from execution results...");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are Anchor's Twin Agent. Analyze execution results and extract ONE behavioral insight about patterns.
Respond ONLY with JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Plan: ${payload.plan_summary}\n\nResults:\n${payload.steps_result.map(s => `[${s.status}] ${s.step}: ${s.result}`).join("\n")}`,
      }],
    });

    const text = (response.content[0] as any).text as string;
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare(
        "INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)"
      ).run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);

      // Also write to memories (episodic) — execution result
      db.prepare(
        "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
      ).run(nanoid(), DEFAULT_USER_ID, "episodic", "Execution Result", `Plan: ${payload.plan_summary}. ${payload.steps_result.length} steps completed.`, JSON.stringify(["execution", "result"]), "Execution Agent", 0.9);

      log("Twin Agent", `Result insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Agent] Result learning error:", err.message);
    log("Twin Agent", `Result learning failed: ${err.message}`, "failed");
  }
}

// ── TWIN_UPDATED → Memory Agent ──────────────────────────────────────────────
function onTwinUpdated(payload: { insight: string }) {
  db.prepare(
    "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
  ).run(nanoid(), DEFAULT_USER_ID, "semantic", "Behavioral Pattern Detected", payload.insight, JSON.stringify(["twin", "auto-generated"]), "Twin Agent", 0.75);
  log("Memory Agent", "Semantic memory stored from Twin insight");
}

// ── GRAPH_UPDATED → Observation Agent ────────────────────────────────────────
function onGraphUpdated(payload: { nodeId: string; status: string; label: string }) {
  const date = new Date().toLocaleDateString("zh-CN");
  db.prepare(
    "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
  ).run(nanoid(), DEFAULT_USER_ID, "episodic", `Graph change: ${payload.label}`, `${date}: "${payload.label}" status changed to ${payload.status}.`, JSON.stringify(["graph", "auto", payload.status]), "Observation Agent", 0.95);

  const cascaded = db.prepare(
    "UPDATE graph_nodes SET status='todo', updated_at=datetime('now') WHERE user_id=? AND status='blocked'"
  ).run(DEFAULT_USER_ID);

  log("Observation Agent", `Graph change: "${payload.label}" → ${payload.status}${cascaded.changes > 0 ? `, ${cascaded.changes} unblocked` : ""}`);
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

// ── Wire all handlers ────────────────────────────────────────────────────────
export function startEventHandlers() {
  bus.on("event", (e: AnchorEvent) => {
    switch (e.type) {
      case "USER_CONFIRMED":  onUserConfirmed(e.payload);       break;
      case "EXECUTION_DONE":  twinLearnFromResults(e.payload);   break;
      case "TWIN_UPDATED":    onTwinUpdated(e.payload);          break;
      case "GRAPH_UPDATED":   onGraphUpdated(e.payload);         break;
      case "TASK_COMPLETED":  onTaskCompleted(e.payload);        break;
    }
  });
  console.log("⚡ Event handlers: USER_CONFIRMED → Execution(ReAct) + Twin(sidecar) | EXECUTION_DONE → Twin | GRAPH_UPDATED → Observation");
}
