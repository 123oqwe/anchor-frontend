/**
 * L3 Cognition — Twin Agent.
 * Learns user preferences from (a) their edits to suggestions and (b) execution results.
 * Pure cognition — no orchestration, no execution.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { bus, type StepChange } from "../orchestration/bus.js";
import { text } from "../infra/compute/index.js";
import { writeMemory, writeTwinInsight } from "../memory/retrieval.js";
import { createNode } from "../graph/writer.js";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

export async function twinLearnFromEdits(changes: StepChange[]) {
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
      writeTwinInsight({ category: parsed.category ?? "behavior", insight: parsed.insight, confidence: parsed.confidence ?? 0.7 });
      // L1 writeback: Twin insight → graph node (preference or behavioral_pattern)
      const nodeType = (parsed.category ?? "").includes("preference") ? "preference" : "behavioral_pattern";
      createNode({ domain: "growth", label: parsed.insight.slice(0, 60), type: nodeType, status: "active", captured: "Twin Agent inference", detail: parsed.insight });
      log("Twin Agent", `Edit insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Sidecar] Error:", err.message);
    log("Twin Agent", `Edit learning failed: ${err.message}`, "failed");
  }
}

export async function twinLearnFromResults(payload: { steps_result: any[]; plan_summary: string }) {
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
      writeTwinInsight({ category: parsed.category ?? "behavior", insight: parsed.insight, confidence: parsed.confidence ?? 0.7 });
      writeMemory({ type: "episodic", title: "Execution Result", content: `Plan: ${payload.plan_summary}. ${payload.steps_result.length} steps.`, tags: ["execution", "result"], source: "Execution Agent", confidence: 0.9 });
      log("Twin Agent", `Result insight: ${parsed.insight.slice(0, 60)}`);
      bus.publish({ type: "TWIN_UPDATED", payload: { insight: parsed.insight } });
    }
  } catch (err: any) {
    console.error("[Twin Agent] Error:", err.message);
    log("Twin Agent", `Result learning failed: ${err.message}`, "failed");
  }
}
