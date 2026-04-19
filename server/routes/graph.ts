import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

// Default domains — user can add custom ones
const DEFAULT_DOMAINS: Record<string, { name: string; icon: string; color: string; bgColor: string; borderColor: string }> = {
  work:          { name: "Work & Career",    icon: "Briefcase",    color: "text-blue-400",    bgColor: "bg-blue-500/10",    borderColor: "border-blue-500/20" },
  relationships: { name: "Relationships",    icon: "Users",        color: "text-purple-400",  bgColor: "bg-purple-500/10",  borderColor: "border-purple-500/20" },
  finance:       { name: "Finance",          icon: "DollarSign",   color: "text-emerald-400", bgColor: "bg-emerald-500/10", borderColor: "border-emerald-500/20" },
  growth:        { name: "Personal Growth",  icon: "GraduationCap",color: "text-amber-400",   bgColor: "bg-amber-500/10",   borderColor: "border-amber-500/20" },
  health:        { name: "Health & Wellbeing",icon: "Heart",       color: "text-rose-400",    bgColor: "bg-rose-500/10",    borderColor: "border-rose-500/20" },
};

// Ensure custom_domains table exists
try {
  db.exec(`CREATE TABLE IF NOT EXISTS custom_domains (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'Star', color TEXT NOT NULL DEFAULT 'text-gray-400',
    bg_color TEXT NOT NULL DEFAULT 'bg-gray-500/10', border_color TEXT NOT NULL DEFAULT 'border-gray-500/20'
  )`);
} catch {}

function getDomainMeta(): Record<string, any> {
  const custom = db.prepare("SELECT * FROM custom_domains WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
  const all = { ...DEFAULT_DOMAINS };
  for (const c of custom) {
    all[c.id] = { name: c.name, icon: c.icon, color: c.color, bgColor: c.bg_color, borderColor: c.border_color };
  }
  return all;
}

function healthScore(items: { status: string }[]) {
  if (!items.length) return 100;
  const weights: Record<string, number> = { active: 100, stable: 100, "in-progress": 80, evolving: 75, opportunity: 90, todo: 60, "not-started": 60, delayed: 30, decaying: 25, overdue: 15, worsening: 10, declining: 20, inactive: 30, blocked: 10, done: 100 };
  const avg = items.reduce((s, i) => s + (weights[i.status] ?? 50), 0) / items.length;
  return Math.round(avg);
}

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM graph_nodes WHERE user_id = ? ORDER BY domain, created_at").all(DEFAULT_USER_ID) as any[];

  const byDomain = new Map<string, any[]>();
  for (const row of rows) {
    if (!byDomain.has(row.domain)) byDomain.set(row.domain, []);
    byDomain.get(row.domain)!.push(row);
  }

  const DOMAIN_META = getDomainMeta();
  const domains = Object.entries(DOMAIN_META).map(([id, meta]) => {
    const items = byDomain.get(id) ?? [];
    return {
      id,
      ...meta,
      nodeCount: items.length,
      health: healthScore(items),
      items: items.map(({ id, label, type, status, captured, detail }) => ({ id, label, type, status, captured, detail })),
    };
  });

  // Include edges
  const edges = db.prepare(`
    SELECT e.id, e.from_node_id as fromId, e.to_node_id as toId, e.type, e.weight,
           f.label as fromLabel, t.label as toLabel
    FROM graph_edges e
    JOIN graph_nodes f ON e.from_node_id = f.id
    JOIN graph_nodes t ON e.to_node_id = t.id
    WHERE e.user_id=?
  `).all(DEFAULT_USER_ID);

  res.json({ domains, totalNodes: rows.length, edges });
});

router.post("/nodes", (req, res) => {
  const { domain, label, type, status, captured, detail } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, domain, label, type, status ?? "active", captured ?? "Manual entry", detail ?? "");
  res.json({ id });
});

// ── Single node detail (with edges, health, pagerank, memories) ─────────────

router.get("/nodes/:id", (req, res) => {
  const node = db.prepare(
    "SELECT id, domain, label, type, status, captured, detail, created_at as createdAt, updated_at as updatedAt FROM graph_nodes WHERE id=? AND user_id=?"
  ).get(req.params.id, DEFAULT_USER_ID) as any;

  if (!node) return res.status(404).json({ error: "Node not found" });

  // Edges
  const outgoing = db.prepare(
    "SELECT e.type, e.weight, n.label as toLabel, n.id as toId FROM graph_edges e JOIN graph_nodes n ON e.to_node_id=n.id WHERE e.from_node_id=? AND e.user_id=?"
  ).all(req.params.id, DEFAULT_USER_ID);
  const incoming = db.prepare(
    "SELECT e.type, e.weight, n.label as fromLabel, n.id as fromId FROM graph_edges e JOIN graph_nodes n ON e.from_node_id=n.id WHERE e.to_node_id=? AND e.user_id=?"
  ).all(req.params.id, DEFAULT_USER_ID);

  // Health (for person nodes — exponential decay)
  let health: number | null = null;
  if (node.type === "person" || node.type === "relationship") {
    const { relationshipHealth } = require("../graph/math/decay.js");
    const daysSince = (Date.now() - new Date(node.updatedAt).getTime()) / 86400000;
    health = Math.round(relationshipHealth(daysSince, 0) * 100);
  }

  // PageRank
  let importance: number | null = null;
  try {
    const { computePageRank } = require("../graph/math/pagerank.js");
    const allNodes = db.prepare("SELECT id FROM graph_nodes WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
    const allEdges = db.prepare("SELECT from_node_id as fromNodeId, to_node_id as toNodeId, type, weight FROM graph_edges WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
    const scores = computePageRank({ nodes: allNodes, edges: allEdges });
    importance = Math.round((scores.get(req.params.id) ?? 0) * 1000) / 10; // percentage
  } catch {}

  // Related memories
  const memories = db.prepare(
    "SELECT id, type, title, content, confidence, created_at as createdAt FROM memories WHERE user_id=? AND (content LIKE ? OR title LIKE ?) ORDER BY created_at DESC LIMIT 5"
  ).all(DEFAULT_USER_ID, `%${node.label.split(" ")[0]}%`, `%${node.label.split(" ")[0]}%`) as any[];

  res.json({ node, edges: { outgoing, incoming }, health, importance, relatedMemories: memories });
});

// ── Tasks related to this node ──────────────────────────────────────────────

router.get("/nodes/:id/tasks", (req, res) => {
  const node = db.prepare("SELECT label FROM graph_nodes WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!node) return res.status(404).json({ error: "Node not found" });

  // Find tasks whose title contains any word from node label (min 3 chars)
  const keywords = node.label.split(/[\s\/\-\(\)]+/).filter((w: string) => w.length >= 3);
  const tasks: any[] = [];
  for (const kw of keywords.slice(0, 3)) {
    const found = db.prepare(
      "SELECT t.id, t.title, t.status, t.priority, p.name as projectName FROM tasks t JOIN projects p ON t.project_id=p.id WHERE p.user_id=? AND t.title LIKE ? LIMIT 5"
    ).all(DEFAULT_USER_ID, `%${kw}%`) as any[];
    for (const t of found) {
      if (!tasks.find(x => x.id === t.id)) tasks.push(t);
    }
  }

  res.json(tasks);
});

// ── Ask Advisor about this specific node ────────────────────────────────────

router.post("/nodes/:id/ask", async (req, res) => {
  const node = db.prepare("SELECT label, type, domain, detail, status FROM graph_nodes WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!node) return res.status(404).json({ error: "Node not found" });

  const { message } = req.body;
  const contextMsg = `[Context: the user is looking at their ${node.type} "${node.label}" (${node.domain}, ${node.status}). Detail: ${node.detail ?? "none"}]\n\n${message ?? "What should I do next with this?"}`;

  try {
    const { decide } = require("../cognition/decision.js");
    const result = await decide(contextMsg, []);
    res.json({ content: result.raw, structured: result.structured });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/nodes/:id", (req, res) => {
  const { label, type, status, captured, detail } = req.body;
  db.prepare("UPDATE graph_nodes SET label=?, type=?, status=?, captured=?, detail=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
    .run(label, type, status, captured, detail, req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.delete("/nodes/:id", (req, res) => {
  db.prepare("DELETE FROM graph_nodes WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.get("/decision-today", (_req, res) => {
  // Find highest-priority delayed/overdue node
  const urgent = db.prepare(`
    SELECT * FROM graph_nodes
    WHERE user_id = ? AND status IN ('delayed','overdue','decaying','worsening','blocked')
    ORDER BY CASE status WHEN 'delayed' THEN 0 WHEN 'overdue' THEN 1 WHEN 'worsening' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END
    LIMIT 1
  `).get(DEFAULT_USER_ID) as any;

  if (urgent) {
    res.json({
      title: urgent.label,
      reason: urgent.detail,
      urgency: "high",
      source: "Decision Agent — priority inference + avoidance detection",
    });
  } else {
    res.json({
      title: "Review your Human Graph",
      reason: "Everything looks on track. Take a moment to review and update your graph.",
      urgency: "low",
      source: "Decision Agent",
    });
  }
});

// ── Custom domains ──────────────────────────────────────────────────────────

router.get("/domains", (_req, res) => {
  res.json(getDomainMeta());
});

router.post("/domains", (req, res) => {
  const { id, name, icon, color } = req.body;
  if (!id || !name) return res.status(400).json({ error: "id and name required" });
  db.prepare(
    "INSERT INTO custom_domains (id, user_id, name, icon, color, bg_color, border_color) VALUES (?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, name, icon ?? "Star", color ?? "text-gray-400", `bg-${color?.split("-")[1] ?? "gray"}-500/10`, `border-${color?.split("-")[1] ?? "gray"}-500/20`);
  res.json({ ok: true });
});

router.delete("/domains/:id", (req, res) => {
  db.prepare("DELETE FROM custom_domains WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// ── Quick add (natural language → node, minimal friction) ───────────────────

router.post("/quick-add", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  // Use graph extractor to parse natural language into a node
  try {
    const { extractFromMessage } = await import("../cognition/extractor.js");
    extractFromMessage(text);
    res.json({ ok: true, message: "Processing... node will appear in graph shortly." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import / Export ─────────────────────────────────────────────────────────

router.get("/export", (_req, res) => {
  const nodes = db.prepare("SELECT * FROM graph_nodes WHERE user_id=?").all(DEFAULT_USER_ID);
  const edges = db.prepare("SELECT * FROM graph_edges WHERE user_id=?").all(DEFAULT_USER_ID);
  const memories = db.prepare("SELECT * FROM memories WHERE user_id=?").all(DEFAULT_USER_ID);
  const insights = db.prepare("SELECT * FROM twin_insights WHERE user_id=?").all(DEFAULT_USER_ID);
  const skills = db.prepare("SELECT * FROM skills WHERE user_id=?").all(DEFAULT_USER_ID);

  res.json({
    version: "1.0",
    exportedAt: new Date().toISOString(),
    graph: { nodes, edges },
    memories,
    insights,
    skills,
  });
});

router.post("/import", (req, res) => {
  const data = req.body;
  if (!data?.graph?.nodes) return res.status(400).json({ error: "Invalid import format" });

  let imported = { nodes: 0, edges: 0, memories: 0, insights: 0, skills: 0 };

  const tx = db.transaction(() => {
    // Import nodes (skip duplicates)
    for (const n of data.graph.nodes) {
      const exists = db.prepare("SELECT id FROM graph_nodes WHERE id=?").get(n.id);
      if (!exists) {
        db.prepare("INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(n.id, DEFAULT_USER_ID, n.domain, n.label, n.type, n.status, n.captured ?? "Imported", n.detail ?? "", n.created_at ?? new Date().toISOString(), n.updated_at ?? new Date().toISOString());
        imported.nodes++;
      }
    }
    // Import edges
    for (const e of (data.graph.edges ?? [])) {
      const exists = db.prepare("SELECT id FROM graph_edges WHERE id=?").get(e.id);
      if (!exists) {
        db.prepare("INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, type, weight) VALUES (?,?,?,?,?,?)")
          .run(e.id, DEFAULT_USER_ID, e.from_node_id, e.to_node_id, e.type, e.weight ?? 1.0);
        imported.edges++;
      }
    }
    // Import memories
    for (const m of (data.memories ?? [])) {
      const exists = db.prepare("SELECT id FROM memories WHERE id=?").get(m.id);
      if (!exists) {
        db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)")
          .run(m.id, DEFAULT_USER_ID, m.type, m.title, m.content, typeof m.tags === "string" ? m.tags : JSON.stringify(m.tags ?? []), m.source ?? "Imported", m.confidence ?? 0.8);
        imported.memories++;
      }
    }
    // Import insights
    for (const i of (data.insights ?? [])) {
      const exists = db.prepare("SELECT id FROM twin_insights WHERE id=?").get(i.id);
      if (!exists) {
        db.prepare("INSERT INTO twin_insights (id, user_id, category, insight, confidence) VALUES (?,?,?,?,?)")
          .run(i.id, DEFAULT_USER_ID, i.category, i.insight, i.confidence ?? 0.7);
        imported.insights++;
      }
    }
    // Import skills
    for (const s of (data.skills ?? [])) {
      const exists = db.prepare("SELECT id FROM skills WHERE id=?").get(s.id);
      if (!exists) {
        db.prepare("INSERT INTO skills (id, user_id, name, description, steps, trigger_pattern) VALUES (?,?,?,?,?,?)")
          .run(s.id, DEFAULT_USER_ID, s.name, s.description ?? "", typeof s.steps === "string" ? s.steps : JSON.stringify(s.steps ?? []), s.trigger_pattern ?? "");
        imported.skills++;
      }
    }
  });

  tx();
  res.json({ ok: true, imported });
});

export default router;
