import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

const router = Router();

const DOMAIN_META: Record<string, { name: string; icon: string; color: string; bgColor: string; borderColor: string }> = {
  work:          { name: "Work & Career",    icon: "Briefcase",    color: "text-blue-400",    bgColor: "bg-blue-500/10",    borderColor: "border-blue-500/20" },
  relationships: { name: "Relationships",    icon: "Users",        color: "text-purple-400",  bgColor: "bg-purple-500/10",  borderColor: "border-purple-500/20" },
  finance:       { name: "Finance",          icon: "DollarSign",   color: "text-emerald-400", bgColor: "bg-emerald-500/10", borderColor: "border-emerald-500/20" },
  growth:        { name: "Personal Growth",  icon: "GraduationCap",color: "text-amber-400",   bgColor: "bg-amber-500/10",   borderColor: "border-amber-500/20" },
  health:        { name: "Health & Wellbeing",icon: "Heart",       color: "text-rose-400",    bgColor: "bg-rose-500/10",    borderColor: "border-rose-500/20" },
};

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

export default router;
