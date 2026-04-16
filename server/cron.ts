import { schedule } from "node-cron";
import { db, DEFAULT_USER_ID } from "./db.js";
import { nanoid } from "nanoid";
import { text } from "./cortex/index.js";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── Every day 08:00 — Morning Digest ────────────────────────────────────────
schedule("0 8 * * *", async () => {
  console.log("[Cron] Morning Digest starting...");
  try {
    const nodes = db.prepare(
      "SELECT label, status, detail FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed','decaying') ORDER BY status"
    ).all(DEFAULT_USER_ID) as any[];
    const state = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
    if (!nodes.length) return;

    const content = await text({
      task: "morning_digest",
      system: "You are Anchor's Morning Digest Agent. Write a 3-bullet daily briefing. Be direct and specific. No fluff.",
      messages: [{
        role: "user",
        content: `State: Energy ${state?.energy}/100, Focus ${state?.focus}/100, Stress ${state?.stress}/100\n\nItems needing attention:\n${nodes.map((n: any) => `[${n.status}] ${n.label}: ${n.detail}`).join("\n")}`,
      }],
      maxTokens: 400,
    });

    db.prepare(
      "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
    ).run(nanoid(), DEFAULT_USER_ID, "working", `Morning Digest — ${new Date().toLocaleDateString()}`, content, JSON.stringify(["digest", "daily"]), "Observation Agent", 0.9);
    log("Observation Agent", "Morning digest generated");
  } catch (err: any) {
    console.error("[Cron] Morning Digest failed:", err.message);
    log("Observation Agent", "Morning digest failed", "failed");
  }
});

// ── Every 6 hours — Decay Checker ───────────────────────────────────────────
schedule("0 */6 * * *", () => {
  try {
    const result = db.prepare(`
      UPDATE graph_nodes SET status='decaying', updated_at=datetime('now')
      WHERE user_id=? AND status IN ('active','opportunity') AND julianday('now') - julianday(updated_at) > 5
    `).run(DEFAULT_USER_ID);
    if (result.changes > 0) log("Observation Agent", `Decay check: ${result.changes} nodes marked decaying`);
  } catch (err: any) {
    console.error("[Cron] Decay Checker failed:", err.message);
  }
});

// ── Every Monday 09:00 — Weekly Twin Reflection ──────────────────────────────
schedule("0 9 * * 1", async () => {
  console.log("[Cron] Weekly Twin Reflection starting...");
  try {
    const execs = db.prepare(
      "SELECT agent, action, status FROM agent_executions WHERE user_id=? AND created_at >= datetime('now','-7 days') ORDER BY created_at"
    ).all(DEFAULT_USER_ID) as any[];
    const doneTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='done' AND created_at >= datetime('now','-7 days')").get() as any;

    const reflectionText = await text({
      task: "weekly_reflection",
      system: `You are Anchor's Twin Agent doing weekly reflection. Extract ONE behavioral pattern.\nRespond ONLY with valid JSON: {"category":"string","insight":"string","confidence":0.0-1.0}`,
      messages: [{
        role: "user",
        content: `Week: ${execs.length} executions, ${doneTasks?.c ?? 0} tasks done, ${execs.filter((e: any) => e.status === "failed").length} failures.\n\n${execs.slice(-20).map((e: any) => `[${e.status}] ${e.agent}: ${e.action}`).join("\n")}`,
      }],
      maxTokens: 200,
    });

    const jsonMatch = reflectionText.match(/\{[^}]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.insight) {
      db.prepare("INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)")
        .run(nanoid(), DEFAULT_USER_ID, parsed.category ?? "behavior", parsed.insight, parsed.confidence ?? 0.7);
      log("Twin Agent", "Weekly reflection complete");
    }
  } catch (err: any) {
    console.error("[Cron] Weekly reflection failed:", err.message);
    log("Twin Agent", "Weekly reflection failed", "failed");
  }
});

// ── Every day 22:00 — Stale Task Detector ────────────────────────────────────
schedule("0 22 * * *", () => {
  try {
    const result = db.prepare("UPDATE tasks SET status='blocked' WHERE status='in-progress' AND julianday('now') - julianday(created_at) > 7").run();
    if (result.changes > 0) log("Workspace Agent", `${result.changes} stale tasks marked blocked`);
  } catch (err: any) {
    console.error("[Cron] Stale Task Detector failed:", err.message);
  }
});

export function startCronJobs() {
  console.log("⏰ Cron jobs scheduled: Morning Digest(8am) | Decay Check(every 6h) | Twin Reflection(Mon 9am) | Stale Tasks(10pm)");
}
