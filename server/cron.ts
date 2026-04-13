import { schedule } from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { db, DEFAULT_USER_ID } from "./db.js";
import { nanoid } from "nanoid";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── Every day 08:00 — Morning Digest (Observation Agent) ────────────────────
schedule("0 8 * * *", async () => {
  console.log("[Cron] Morning Digest starting...");
  if (!process.env.ANTHROPIC_API_KEY) { console.log("[Cron] No API key, skipping"); return; }

  try {
    const nodes = db.prepare(
      "SELECT label, status, detail FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed','decaying') ORDER BY status"
    ).all(DEFAULT_USER_ID) as any[];
    const state = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;

    if (!nodes.length) { console.log("[Cron] No items needing attention."); return; }

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: "You are Anchor's Morning Digest Agent. Write a 3-bullet daily briefing. Be direct and specific. No fluff.",
      messages: [{
        role: "user",
        content: `State: Energy ${state?.energy}/100, Focus ${state?.focus}/100, Stress ${state?.stress}/100\n\nItems needing attention:\n${nodes.map(n => `[${n.status}] ${n.label}: ${n.detail}`).join("\n")}`,
      }],
    });

    const content = (response.content[0] as any).text as string;
    db.prepare(
      "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
    ).run(
      nanoid(), DEFAULT_USER_ID, "working",
      `Morning Digest — ${new Date().toLocaleDateString()}`,
      content, JSON.stringify(["digest", "daily"]), "Observation Agent", 0.9
    );
    log("Observation Agent", "Morning digest generated");
    console.log("[Cron] Morning Digest done.");
  } catch (err: any) {
    console.error("[Cron] Morning Digest failed:", err.message);
    log("Observation Agent", "Morning digest failed", "failed");
  }
});

// ── Every 6 hours — Decay Checker (Observation Agent) ───────────────────────
schedule("0 */6 * * *", () => {
  try {
    const result = db.prepare(`
      UPDATE graph_nodes
      SET status='decaying', updated_at=datetime('now')
      WHERE user_id=?
        AND status IN ('active','opportunity')
        AND julianday('now') - julianday(updated_at) > 5
    `).run(DEFAULT_USER_ID);

    if (result.changes > 0) {
      log("Observation Agent", `Decay check: ${result.changes} nodes marked decaying`);
      console.log(`[Cron] Decay Checker: ${result.changes} nodes updated.`);
    }
  } catch (err: any) {
    console.error("[Cron] Decay Checker failed:", err.message);
  }
});

// ── Every Monday 09:00 — Weekly Twin Reflection ──────────────────────────────
schedule("0 9 * * 1", async () => {
  console.log("[Cron] Weekly Twin Reflection starting...");
  if (!process.env.ANTHROPIC_API_KEY) return;

  try {
    const execs = db.prepare(
      "SELECT agent, action, status FROM agent_executions WHERE user_id=? AND created_at >= datetime('now','-7 days') ORDER BY created_at"
    ).all(DEFAULT_USER_ID) as any[];
    const doneTasks = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE status='done' AND created_at >= datetime('now','-7 days')"
    ).get() as any;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are Anchor's Twin Agent doing weekly reflection. Extract ONE behavioral pattern.
Respond ONLY with valid JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Week summary: ${execs.length} agent executions, ${doneTasks?.c ?? 0} tasks completed, ${execs.filter((e: any) => e.status === "failed").length} failures.\n\nActivity:\n${execs.slice(-20).map((e: any) => `[${e.status}] ${e.agent}: ${e.action}`).join("\n")}`,
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
      log("Twin Agent", "Weekly reflection complete");
      console.log("[Cron] Twin weekly reflection done.");
    }
  } catch (err: any) {
    console.error("[Cron] Weekly reflection failed:", err.message);
    log("Twin Agent", "Weekly reflection failed", "failed");
  }
});

// ── Every day 22:00 — Stale Task Detector (Workspace Agent) ─────────────────
schedule("0 22 * * *", () => {
  try {
    const result = db.prepare(`
      UPDATE tasks SET status='blocked'
      WHERE status='in-progress'
        AND julianday('now') - julianday(created_at) > 7
    `).run();

    if (result.changes > 0) {
      log("Workspace Agent", `${result.changes} stale tasks marked blocked`);
      console.log(`[Cron] Stale Task Detector: ${result.changes} tasks blocked.`);
    }
  } catch (err: any) {
    console.error("[Cron] Stale Task Detector failed:", err.message);
  }
});

export function startCronJobs() {
  console.log("⏰ Cron jobs scheduled: Morning Digest(8am) | Decay Check(every 6h) | Twin Reflection(Mon 9am) | Stale Tasks(10pm)");
}
