import { Router } from "express";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { generateSelfPortrait } from "../cognition/self-portrait.js";
import { analyzeExecutionTraces } from "../cognition/gepa.js";
import { text } from "../infra/compute/index.js";
import { serializeForPrompt } from "../graph/reader.js";

const router = Router();

router.get("/status", (_req, res) => {
  const agents = ["Decision Agent", "Observation Agent", "Memory Agent", "Twin Agent", "Execution Agent", "Workspace Agent"];
  const result = agents.map(name => {
    const rows = db.prepare("SELECT status FROM agent_executions WHERE user_id=? AND agent=?").all(DEFAULT_USER_ID, name) as any[];
    const successes = rows.filter(r => r.status === "success").length;
    const failures = rows.filter(r => r.status === "failed").length;
    return { name, successes, failures };
  });
  res.json(result);
});

router.get("/executions", (_req, res) => {
  const rows = db.prepare("SELECT * FROM agent_executions WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(DEFAULT_USER_ID);
  res.json(rows);
});

router.post("/executions", (req, res) => {
  const { agent, action, status } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, agent, action, status ?? "success");
  res.json({ id });
});

router.get("/gepa", async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const analysis = await analyzeExecutionTraces(days);
    res.json(analysis);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/self-portrait", async (_req, res) => {
  try {
    const portrait = await generateSelfPortrait();
    res.json(portrait);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── OPT-7: Active Twin Insight — one-line actionable daily insight ─────────
// Pure SQL + scoring. Zero LLM calls. Picks TOP 1 from multiple signal sources.

router.get("/active-insight", (_req, res) => {
  try {
    // Cold start guard: need at least some data
    const firstMsg = db.prepare("SELECT MIN(created_at) as first FROM messages WHERE user_id=?").get(DEFAULT_USER_ID) as any;
    if (!firstMsg?.first) {
      return res.json({
        insight: "Welcome to Anchor. Start a conversation to begin building your Twin.",
        severity: "info",
        reason: "No data yet",
        source: "onboarding",
      });
    }
    const daysActive = (Date.now() - new Date(firstMsg.first).getTime()) / 86400000;
    if (daysActive < 3) {
      return res.json({
        insight: `Anchor is learning. ${Math.round(daysActive)} days of data so far.`,
        severity: "info",
        reason: "Accumulating baseline",
        source: "onboarding",
      });
    }

    const candidates: Array<{ insight: string; severity: string; reason: string; source: string; score: number; action?: any }> = [];

    // Signal 1: Decaying relationships (immediate action)
    const decaying = db.prepare(
      `SELECT id, label, julianday('now') - julianday(updated_at) as days
       FROM graph_nodes WHERE user_id=? AND type='person'
       AND julianday('now') - julianday(updated_at) > 21
       ORDER BY days DESC LIMIT 1`
    ).get(DEFAULT_USER_ID) as any;
    if (decaying) {
      candidates.push({
        insight: `You haven't touched "${decaying.label}" in ${Math.round(decaying.days)} days. Relationship decaying.`,
        severity: "warning",
        reason: "Behavioral decay detected via exponential decay model",
        source: "relationships",
        score: Math.min(100, Math.round(decaying.days * 2)),
        action: { label: "Reach out", route: `/graph/${decaying.id}` },
      });
    }

    // Signal 2: Goal vs Activity mismatch (say vs do)
    const goals = db.prepare(
      "SELECT label FROM graph_nodes WHERE user_id=? AND type='goal' AND status='active' LIMIT 3"
    ).all(DEFAULT_USER_ID) as any[];
    const recentActivity = db.prepare(
      `SELECT app_name, COUNT(*) as cnt FROM activity_captures
       WHERE user_id=? AND captured_at >= datetime('now', '-7 days')
       GROUP BY app_name ORDER BY cnt DESC LIMIT 5`
    ).all(DEFAULT_USER_ID) as any[];
    const topApp = recentActivity[0];
    if (goals.length > 0 && topApp) {
      const goalKeywords = goals.map((g: any) => g.label.toLowerCase()).join(" ");
      const appCoversGoal = goalKeywords.includes(topApp.app_name.toLowerCase()) ||
        /Cursor|VS Code|Xcode|Figma|Linear|Notion/i.test(topApp.app_name);
      if (!appCoversGoal && topApp.cnt > 30) {
        const topAppHours = Math.round(topApp.cnt * 5 / 60);
        candidates.push({
          insight: `You spent ${topAppHours}h in ${topApp.app_name} this week. Your goals don't mention it.`,
          severity: "warning",
          reason: "Say-vs-do gap: activity not aligned with stated goals",
          source: "say_vs_do",
          score: Math.min(90, topAppHours * 2),
        });
      }
    }

    // Signal 3: Overdue items
    const overdue = db.prepare(
      "SELECT label, id FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed') ORDER BY updated_at LIMIT 1"
    ).get(DEFAULT_USER_ID) as any;
    if (overdue) {
      candidates.push({
        insight: `"${overdue.label}" is overdue. Every day of delay compounds.`,
        severity: "critical",
        reason: "Node marked overdue or delayed",
        source: "overdue",
        score: 85,
        action: { label: "Address now", route: `/graph/${overdue.id}` },
      });
    }

    // Signal 4: Twin drift
    const recentInsights = db.prepare(
      "SELECT insight, confidence FROM twin_insights WHERE user_id=? AND created_at >= datetime('now', '-7 days') ORDER BY confidence DESC LIMIT 1"
    ).get(DEFAULT_USER_ID) as any;
    if (recentInsights && recentInsights.confidence > 0.75) {
      candidates.push({
        insight: recentInsights.insight.slice(0, 120),
        severity: "info",
        reason: `Twin learned this with ${Math.round(recentInsights.confidence * 100)}% confidence`,
        source: "twin",
        score: Math.round(recentInsights.confidence * 70),
      });
    }

    // Signal 5: Memory capacity pressure
    const memTotal = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
    if (memTotal > 170) {
      candidates.push({
        insight: `Memory at ${memTotal}/200. Dream Engine will prune tonight at 3am.`,
        severity: "info",
        reason: "Approaching capacity limit",
        source: "memory",
        score: 30,
      });
    }

    // Pick top by score
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];

    if (!top) {
      return res.json({
        insight: "All systems steady. Nothing urgent to flag right now.",
        severity: "info",
        reason: "No strong signals",
        source: "healthy",
      });
    }

    res.json(top);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── System Recommendations — pattern-based agent/cron/skill suggestions ────

router.get("/recommendations", async (_req, res) => {
  try {
    const recommendations: any[] = [];

    // 1. Check for repeated conversation topics → suggest agent
    const recentTopics = db.prepare(`
      SELECT content, COUNT(*) as cnt FROM messages
      WHERE user_id=? AND role='user' AND mode='personal'
      AND created_at >= datetime('now', '-14 days')
      GROUP BY substr(content, 1, 50) ORDER BY cnt DESC LIMIT 5
    `).all(DEFAULT_USER_ID) as any[];

    for (const t of recentTopics) {
      if (t.cnt >= 3) {
        const topic = t.content.slice(0, 60);
        // Check if agent already exists for this
        const exists = db.prepare("SELECT id FROM user_agents WHERE user_id=? AND instructions LIKE ?")
          .get(DEFAULT_USER_ID, `%${topic.split(" ").slice(0, 3).join("%")}%`);
        if (!exists) {
          recommendations.push({
            id: nanoid(),
            type: "agent",
            title: `Create agent for "${topic.slice(0, 30)}..."`,
            reason: `You've asked about this ${t.cnt} times in 2 weeks`,
            action: { type: "create_agent", name: topic.slice(0, 30), instructions: `You are an expert on: ${topic}. Help the user with this topic using their Human Graph context.` },
          });
        }
      }
    }

    // 2. Check for decaying relationships → suggest cron
    const decayingPeople = db.prepare(`
      SELECT label, julianday('now') - julianday(updated_at) as days
      FROM graph_nodes WHERE user_id=? AND type='person'
      AND julianday('now') - julianday(updated_at) > 14
      ORDER BY days DESC LIMIT 3
    `).all(DEFAULT_USER_ID) as any[];

    if (decayingPeople.length >= 2) {
      const existsCron = db.prepare("SELECT id FROM user_crons WHERE user_id=? AND name LIKE '%relationship%'").get(DEFAULT_USER_ID);
      if (!existsCron) {
        recommendations.push({
          id: nanoid(),
          type: "cron",
          title: "Weekly relationship check-in reminder",
          reason: `${decayingPeople.length} relationships are fading (${decayingPeople.map((p: any) => p.label).join(", ")})`,
          action: { type: "create_cron", name: "Relationship check-in", cron_pattern: "0 9 * * 1", action_type: "remind", action_config: { message: "Check in with fading relationships" } },
        });
      }
    }

    // 3. Check for uninstalled skill templates that match user behavior
    const installedSkills = db.prepare("SELECT name FROM skills WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
    const installedNames = new Set(installedSkills.map((s: any) => s.name));

    const TEMPLATES = [
      { name: "Weekly Review", trigger: "review", signal: "tasks" },
      { name: "Decision Journal", trigger: "decision", signal: "decisions" },
      { name: "Meeting Prep", trigger: "meeting", signal: "calendar" },
    ];

    for (const t of TEMPLATES) {
      if (installedNames.has(t.name)) continue;
      // Check if user has related activity
      const hasActivity = db.prepare(
        "SELECT COUNT(*) as c FROM messages WHERE user_id=? AND role='user' AND content LIKE ? AND created_at >= datetime('now', '-14 days')"
      ).get(DEFAULT_USER_ID, `%${t.trigger}%`) as any;
      if (hasActivity?.c >= 2) {
        recommendations.push({
          id: nanoid(),
          type: "skill",
          title: `Install "${t.name}" skill`,
          reason: `You've mentioned "${t.trigger}" ${hasActivity.c} times recently`,
          action: { type: "install_skill", templateName: t.name },
        });
      }
    }

    // 4. Check if user has high screen time but no activity monitor awareness
    const screenTime = db.prepare(
      "SELECT COUNT(*) as c FROM activity_captures WHERE user_id=? AND captured_at >= datetime('now', '-24 hours')"
    ).get(DEFAULT_USER_ID) as any;
    if (screenTime?.c > 100) { // 100 captures = ~8 hours
      const hasDigestionCron = db.prepare("SELECT id FROM user_crons WHERE user_id=? AND name LIKE '%break%' OR name LIKE '%rest%'").get(DEFAULT_USER_ID);
      if (!hasDigestionCron) {
        recommendations.push({
          id: nanoid(),
          type: "cron",
          title: "Break reminder every 2 hours",
          reason: `${Math.round(screenTime.c * 5 / 60)} hours of screen time today`,
          action: { type: "create_cron", name: "Take a break", cron_pattern: "0 */2 * * *", action_type: "remind", action_config: { message: "You've been working for 2 hours — take a 10-minute break" } },
        });
      }
    }

    res.json(recommendations.slice(0, 5));
  } catch (err: any) {
    res.json([]);
  }
});

// ── Accept a recommendation (one-click create) ────────────────────────────

router.post("/recommendations/accept", (req, res) => {
  const { action } = req.body;
  if (!action) return res.status(400).json({ error: "action required" });

  try {
    switch (action.type) {
      case "create_agent": {
        const id = nanoid();
        db.prepare("INSERT INTO user_agents (id, user_id, name, instructions, tools) VALUES (?,?,?,?,?)")
          .run(id, DEFAULT_USER_ID, action.name, action.instructions, "[]");
        logExecution("Recommendations", `Created agent: ${action.name}`);
        return res.json({ ok: true, created: "agent", id });
      }
      case "create_cron": {
        const id = nanoid();
        db.prepare("INSERT INTO user_crons (id, user_id, name, cron_pattern, action_type, action_config, source) VALUES (?,?,?,?,?,?,?)")
          .run(id, DEFAULT_USER_ID, action.name, action.cron_pattern, action.action_type, JSON.stringify(action.action_config ?? {}), "recommendation");
        logExecution("Recommendations", `Created cron: ${action.name}`);
        return res.json({ ok: true, created: "cron", id });
      }
      case "install_skill": {
        // Find template by name and install
        const existing = db.prepare("SELECT id FROM skills WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, action.templateName);
        if (existing) return res.json({ ok: true, message: "Already installed" });
        const id = nanoid();
        // Minimal skill — will be filled by template installer
        db.prepare("INSERT INTO skills (id, user_id, name, description, steps, trigger_pattern, source) VALUES (?,?,?,?,?,?,?)")
          .run(id, DEFAULT_USER_ID, action.templateName, `Recommended skill`, "[]", "", "recommendation");
        logExecution("Recommendations", `Installed skill: ${action.templateName}`);
        return res.json({ ok: true, created: "skill", id });
      }
      default:
        return res.status(400).json({ error: "Unknown action type" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
