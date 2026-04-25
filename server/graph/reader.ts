/**
 * L1 Human Graph — Reader.
 *
 * Read-only queries against the Human Graph.
 * This is the ONLY way L3 Cognition and L4 Orchestration should access graph data.
 * They call these functions, not raw SQL.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { type NodeType, type EdgeType, type Domain, DOMAIN_META } from "./ontology.js";

export interface NodeRecord {
  id: string;
  domain: string;
  label: string;
  type: string;
  status: string;
  captured: string;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

// ── Core queries ────────────────────────────────────────────────────────────

/** Get all nodes, grouped by domain. */
export function getFullGraph(): { domain: string; name: string; nodes: NodeRecord[] }[] {
  const nodes = db.prepare(
    "SELECT id, domain, label, type, status, captured, detail, created_at as createdAt, updated_at as updatedAt FROM graph_nodes WHERE user_id=? ORDER BY domain, created_at"
  ).all(DEFAULT_USER_ID) as NodeRecord[];

  const grouped: Record<string, NodeRecord[]> = {};
  for (const n of nodes) {
    if (!grouped[n.domain]) grouped[n.domain] = [];
    grouped[n.domain].push(n);
  }

  return Object.entries(grouped).map(([domain, domNodes]) => ({
    domain,
    name: (DOMAIN_META as any)[domain]?.name ?? domain,
    nodes: domNodes,
  }));
}

/** Get nodes filtered by domain. */
export function getNodesByDomain(domain: Domain): NodeRecord[] {
  return db.prepare(
    "SELECT id, domain, label, type, status, captured, detail, created_at as createdAt, updated_at as updatedAt FROM graph_nodes WHERE user_id=? AND domain=? ORDER BY created_at"
  ).all(DEFAULT_USER_ID, domain) as NodeRecord[];
}

/** Get nodes filtered by status. */
export function getNodesByStatus(...statuses: string[]): NodeRecord[] {
  const placeholders = statuses.map(() => "?").join(",");
  return db.prepare(
    `SELECT id, domain, label, type, status, captured, detail, created_at as createdAt, updated_at as updatedAt FROM graph_nodes WHERE user_id=? AND status IN (${placeholders}) ORDER BY created_at`
  ).all(DEFAULT_USER_ID, ...statuses) as NodeRecord[];
}

/** Get nodes filtered by type. */
export function getNodesByType(type: NodeType): NodeRecord[] {
  return db.prepare(
    "SELECT id, domain, label, type, status, captured, detail, created_at as createdAt, updated_at as updatedAt FROM graph_nodes WHERE user_id=? AND type=? ORDER BY created_at"
  ).all(DEFAULT_USER_ID, type) as NodeRecord[];
}

/** Find the highest-priority urgent node. */
export function getMostUrgentNode(): NodeRecord | null {
  return (db.prepare(
    "SELECT id, domain, label, type, status, captured, detail, created_at as createdAt, updated_at as updatedAt FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed','decaying') ORDER BY CASE status WHEN 'overdue' THEN 1 WHEN 'delayed' THEN 2 WHEN 'decaying' THEN 3 END, created_at LIMIT 1"
  ).get(DEFAULT_USER_ID) as NodeRecord) ?? null;
}

// ── Context serialization (for L3 Cognition prompt injection) ───────────────

/** Serialize graph into a text block that can be injected into an LLM system prompt. */
export function serializeForPrompt(): string {
  const domains = getFullGraph();
  if (domains.length === 0) return "No Human Graph data yet.";
  return domains.map(d =>
    `${d.name.toUpperCase()}:\n${d.nodes.map(n => `  - [${n.type}] ${n.label} (${n.status}): ${n.detail}`).join("\n")}`
  ).join("\n\n");
}

/** Serialize user state for prompt injection. */
export function serializeStateForPrompt(): string {
  const s = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  if (!s) return "";
  return `Current state — Energy: ${s.energy}/100, Focus: ${s.focus}/100, Stress: ${s.stress}/100`;
}

// ── Values ─────────────────────────────────────────────────────────────────

export interface ValueNode {
  id: string;
  label: string;
  stated: boolean;            // "stated" (explicit) vs "inferred" (behavior-derived)
  confidence: number;         // 0-1, parsed from detail
  lastReinforcementAt: string;
  detail: string;
  status: string;
}

/**
 * Returns active value nodes in descending confidence order. Agents call
 * this instead of scraping values out of the InferredProfile system-prompt
 * string — values are first-class graph entities now, not system-prompt
 * furniture.
 */
export function getActiveValues(limit = 20): ValueNode[] {
  const rows = db.prepare(
    `SELECT id, label, detail, status, updated_at
     FROM graph_nodes
     WHERE user_id=? AND type='value' AND status='active'
     ORDER BY updated_at DESC LIMIT ?`
  ).all(DEFAULT_USER_ID, limit) as any[];
  return rows.map(r => {
    const detail: string = r.detail ?? "";
    const stated = /source:\s*stated/i.test(detail);
    const confMatch = detail.match(/confidence:\s*([\d.]+)/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.6;
    return {
      id: r.id, label: r.label, detail, status: r.status,
      stated, confidence,
      lastReinforcementAt: r.updated_at,
    };
  }).sort((a, b) => b.confidence - a.confidence);
}

/** Serialize values for agent prompts — compact, not buried in profile JSON. */
export function serializeValuesForPrompt(limit = 10): string {
  const vs = getActiveValues(limit);
  if (vs.length === 0) return "";
  return "USER VALUES (first-class):\n" + vs.map(v =>
    `  - ${v.label}  [${v.stated ? "stated" : "inferred"} · conf ${v.confidence.toFixed(2)}]`
  ).join("\n");
}

// ── Parametric query ───────────────────────────────────────────────────────

export interface GraphQuery {
  type?: string | string[];            // NodeType filter (single or multiple)
  status?: string | string[];          // active, decaying, blocked, done...
  domain?: string | string[];
  captured?: string;                   // e.g. "profile-inference"
  labelContains?: string;              // substring match, case-insensitive
  detailContains?: string;
  connectedTo?: string;                // only nodes with edge to/from this nodeId
  edgeType?: string;                   // narrows connectedTo edges by type
  edgeDirection?: "from" | "to" | "either"; // default "either"
  minWeight?: number;                  // requires connectedTo; filters edge weight
  updatedSince?: string;               // ISO timestamp
  limit?: number;                      // default 50, max 200
  orderBy?: "created" | "updated" | "label" | "weight";
  order?: "asc" | "desc";
}

export interface QueryResultNode extends NodeRecord {
  matchedEdge?: {                      // present when connectedTo is set
    type: string;
    weight: number;
    direction: "from" | "to";
  };
}

/**
 * Parametric graph query. Agents call this instead of receiving a full graph
 * dump in their prompt — much smaller tokens, richer filters. Always returns
 * CURRENTLY-ACTIVE data (nodes + valid edges); historical versions are
 * reachable via getEdgeHistory on a specific pair.
 */
export function queryGraph(q: GraphQuery): QueryResultNode[] {
  const LIMIT = Math.min(200, Math.max(1, q.limit ?? 50));
  const wheres: string[] = ["n.user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];

  if (q.type) {
    const types = Array.isArray(q.type) ? q.type : [q.type];
    wheres.push(`n.type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  if (q.status) {
    const statuses = Array.isArray(q.status) ? q.status : [q.status];
    wheres.push(`n.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (q.domain) {
    const domains = Array.isArray(q.domain) ? q.domain : [q.domain];
    wheres.push(`n.domain IN (${domains.map(() => "?").join(",")})`);
    params.push(...domains);
  }
  if (q.captured) { wheres.push("n.captured = ?"); params.push(q.captured); }
  if (q.labelContains) { wheres.push("LOWER(n.label) LIKE ?"); params.push(`%${q.labelContains.toLowerCase()}%`); }
  if (q.detailContains) { wheres.push("LOWER(n.detail) LIKE ?"); params.push(`%${q.detailContains.toLowerCase()}%`); }
  if (q.updatedSince) { wheres.push("n.updated_at >= ?"); params.push(q.updatedSince); }

  const orderCol = q.orderBy === "label" ? "n.label"
                  : q.orderBy === "updated" ? "n.updated_at"
                  : q.orderBy === "weight" ? "matched_weight"
                  : "n.created_at";
  const orderDir = q.order === "asc" ? "ASC" : "DESC";

  // connectedTo: join against edges so we can return matchedEdge info and
  // optionally order by weight. direction=either means we UNION from+to.
  if (q.connectedTo) {
    const direction = q.edgeDirection ?? "either";
    const edgeWheres = ["e.user_id = ?", "e.valid_to IS NULL"];
    const edgeParams: any[] = [DEFAULT_USER_ID];

    if (q.edgeType) { edgeWheres.push("e.type = ?"); edgeParams.push(q.edgeType); }
    if (typeof q.minWeight === "number") { edgeWheres.push("e.weight >= ?"); edgeParams.push(q.minWeight); }

    const subqueries: string[] = [];
    const subqueryParams: any[] = [];
    if (direction === "from" || direction === "either") {
      // edges FROM connectedTo → neighbor is to_node_id
      subqueries.push(
        `SELECT e.to_node_id as neighbor_id, e.weight as matched_weight, e.type as matched_type, 'to' as matched_direction
         FROM graph_edges e WHERE ${edgeWheres.join(" AND ")} AND e.from_node_id = ?`
      );
      subqueryParams.push(...edgeParams, q.connectedTo);
    }
    if (direction === "to" || direction === "either") {
      subqueries.push(
        `SELECT e.from_node_id as neighbor_id, e.weight as matched_weight, e.type as matched_type, 'from' as matched_direction
         FROM graph_edges e WHERE ${edgeWheres.join(" AND ")} AND e.to_node_id = ?`
      );
      subqueryParams.push(...edgeParams, q.connectedTo);
    }
    const edgeUnion = subqueries.join(" UNION ALL ");

    const sql = `
      SELECT n.id, n.domain, n.label, n.type, n.status, n.captured, n.detail,
             n.created_at as createdAt, n.updated_at as updatedAt,
             m.matched_weight, m.matched_type, m.matched_direction
      FROM graph_nodes n
      JOIN (${edgeUnion}) m ON m.neighbor_id = n.id
      WHERE ${wheres.join(" AND ")}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...subqueryParams, ...params, LIMIT) as any[];
    return rows.map(r => ({
      id: r.id, domain: r.domain, label: r.label, type: r.type, status: r.status,
      captured: r.captured, detail: r.detail, createdAt: r.createdAt, updatedAt: r.updatedAt,
      matchedEdge: {
        type: r.matched_type,
        weight: r.matched_weight,
        direction: r.matched_direction,
      },
    }));
  }

  const sql = `
    SELECT n.id, n.domain, n.label, n.type, n.status, n.captured, n.detail,
           n.created_at as createdAt, n.updated_at as updatedAt
    FROM graph_nodes n
    WHERE ${wheres.join(" AND ")}
    ORDER BY ${orderCol === "matched_weight" ? "n.created_at" : orderCol} ${orderDir}
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, LIMIT) as QueryResultNode[];
}

/**
 * BFS shortest path between two nodes (undirected over active edges).
 * Returns an ordered list of node IDs including endpoints, or null if
 * unreachable within maxDepth.
 */
export function getNodePath(fromId: string, toId: string, maxDepth = 4): string[] | null {
  if (fromId === toId) return [fromId];
  const visited = new Set<string>([fromId]);
  let frontier: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
  const edgeStmt = db.prepare(
    `SELECT from_node_id as fromId, to_node_id as toId FROM graph_edges
     WHERE user_id=? AND valid_to IS NULL AND (from_node_id=? OR to_node_id=?)`
  );
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: Array<{ id: string; path: string[] }> = [];
    for (const { id, path } of frontier) {
      const edges = edgeStmt.all(DEFAULT_USER_ID, id, id) as any[];
      for (const e of edges) {
        const neighbor = e.fromId === id ? e.toId : e.fromId;
        if (visited.has(neighbor)) continue;
        if (neighbor === toId) return [...path, neighbor];
        visited.add(neighbor);
        next.push({ id: neighbor, path: [...path, neighbor] });
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  return null;
}

// ── Edge queries ────────────────────────────────────────────────────────────

export interface EdgeRecord {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  weight: number;
  metadata: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

/** Get all CURRENTLY-ACTIVE edges from a node (valid_to IS NULL). */
export function getEdgesFrom(nodeId: string, opts?: { includeHistorical?: boolean }): (EdgeRecord & { toLabel: string })[] {
  const activeClause = opts?.includeHistorical ? "" : " AND e.valid_to IS NULL";
  return db.prepare(`
    SELECT e.id, e.from_node_id as fromNodeId, e.to_node_id as toNodeId, e.type, e.weight, e.metadata,
           e.valid_from as validFrom, e.valid_to as validTo, n.label as toLabel
    FROM graph_edges e JOIN graph_nodes n ON e.to_node_id = n.id
    WHERE e.user_id=? AND e.from_node_id=?${activeClause}
  `).all(DEFAULT_USER_ID, nodeId) as any[];
}

/** Get all CURRENTLY-ACTIVE edges to a node (valid_to IS NULL). */
export function getEdgesTo(nodeId: string, opts?: { includeHistorical?: boolean }): (EdgeRecord & { fromLabel: string })[] {
  const activeClause = opts?.includeHistorical ? "" : " AND e.valid_to IS NULL";
  return db.prepare(`
    SELECT e.id, e.from_node_id as fromNodeId, e.to_node_id as toNodeId, e.type, e.weight, e.metadata,
           e.valid_from as validFrom, e.valid_to as validTo, n.label as fromLabel
    FROM graph_edges e JOIN graph_nodes n ON e.from_node_id = n.id
    WHERE e.user_id=? AND e.to_node_id=?${activeClause}
  `).all(DEFAULT_USER_ID, nodeId) as any[];
}

/** Get all currently-active edges (valid_to IS NULL). For full graph viz. */
export function getAllEdges(opts?: { includeHistorical?: boolean }): EdgeRecord[] {
  const activeClause = opts?.includeHistorical ? "" : " AND valid_to IS NULL";
  return db.prepare(
    `SELECT id, from_node_id as fromNodeId, to_node_id as toNodeId, type, weight, metadata,
            valid_from as validFrom, valid_to as validTo
     FROM graph_edges WHERE user_id=?${activeClause}`
  ).all(DEFAULT_USER_ID) as any[];
}

/**
 * Full version history for a (from, to[, type]) pair — returns all edges that
 * ever existed between these two nodes, oldest-first. Each row represents one
 * "version" of the relationship; valid_to=NULL means currently active.
 */
export function getEdgeHistory(
  fromNodeId: string,
  toNodeId: string,
  type?: string,
): EdgeRecord[] {
  const typeClause = type ? " AND type=?" : "";
  const params: any[] = [DEFAULT_USER_ID, fromNodeId, toNodeId];
  if (type) params.push(type);
  return db.prepare(
    `SELECT id, from_node_id as fromNodeId, to_node_id as toNodeId, type, weight, metadata,
            valid_from as validFrom, valid_to as validTo
     FROM graph_edges
     WHERE user_id=? AND from_node_id=? AND to_node_id=?${typeClause}
     ORDER BY valid_from ASC, created_at ASC`
  ).all(...params) as any[];
}

/** Serialize active edges for prompt injection (so Decision Agent knows dependencies). */
export function serializeEdgesForPrompt(): string {
  const edges = db.prepare(`
    SELECT f.label as from_label, t.label as to_label, e.type
    FROM graph_edges e
    JOIN graph_nodes f ON e.from_node_id = f.id
    JOIN graph_nodes t ON e.to_node_id = t.id
    WHERE e.user_id=? AND e.valid_to IS NULL
  `).all(DEFAULT_USER_ID) as any[];
  if (edges.length === 0) return "";
  return "RELATIONSHIPS:\n" + edges.map(e => `  ${e.from_label} —[${e.type}]→ ${e.to_label}`).join("\n");
}

// ── Time-travel queries — bi-temporal AS-OF semantics ──────────────────────
// These are the foundation primitive for P4's Killer Queries and for the
// frontend TimelineScrubber. Everything in Anchor's "what was true on date X"
// must route through here; never hand-roll a `valid_from <= ? AND ...` filter
// at the call site — that's how Snodgrass-style bi-temporality rots.

export interface AsOfOptions {
  /** When was the fact true in the world? (Valid time, TSQL2). Default: now. */
  validAt?: string;
  /** What did Anchor know at this point? (Transaction time). Default: now. */
  knownAt?: string;
}

/**
 * Fetch nodes that were valid at `validAt` AND known to Anchor by `knownAt`.
 * For current-state queries leave both undefined — degenerates to "active now".
 * For "3 months ago view" pass validAt=3-months-ago AND knownAt=3-months-ago
 * (both axes moved back — you're seeing the world as Anchor saw it then).
 * For "what did I know about X's state 3 months ago but learn since" pass
 * validAt=3-months-ago, knownAt=now (valid-time scope, transaction unchanged).
 */
export function queryNodesAsOf(opts: AsOfOptions = {}): QueryResultNode[] {
  const validAt = opts.validAt ?? null;
  const knownAt = opts.knownAt ?? null;

  const wheres: string[] = ["user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];

  if (validAt) {
    // Valid at `validAt` means: valid_from <= validAt AND (valid_to IS NULL OR valid_to > validAt)
    wheres.push("datetime(COALESCE(valid_from, created_at)) <= datetime(?)");
    wheres.push("(valid_to IS NULL OR datetime(valid_to) > datetime(?))");
    params.push(validAt, validAt);
  } else {
    wheres.push("valid_to IS NULL");
  }

  if (knownAt) {
    // Anchor must have known by knownAt — recorded_at <= knownAt
    wheres.push("datetime(COALESCE(recorded_at, created_at)) <= datetime(?)");
    params.push(knownAt);
  }

  const rows = db.prepare(`
    SELECT id, domain, label, type, status, captured, detail, created_at, updated_at,
           valid_from, valid_to, recorded_at
    FROM graph_nodes
    WHERE ${wheres.join(" AND ")}
    ORDER BY COALESCE(valid_from, created_at) DESC
  `).all(...params) as any[];

  return rows.map(r => ({
    id: r.id, domain: r.domain, label: r.label, type: r.type, status: r.status,
    captured: r.captured, detail: r.detail,
    createdAt: r.created_at, updatedAt: r.updated_at,
    validFrom: r.valid_from, validTo: r.valid_to, recordedAt: r.recorded_at,
  })) as QueryResultNode[];
}

/**
 * Fetch edges valid at `validAt`, known by `knownAt`. Same semantics as
 * queryNodesAsOf but for graph_edges. Edges already have valid_from/valid_to
 * in the current schema (migrated earlier), so this is a direct filter.
 */
export function queryEdgesAsOf(opts: AsOfOptions = {}): any[] {
  const validAt = opts.validAt ?? null;
  const knownAt = opts.knownAt ?? null;

  const wheres: string[] = ["e.user_id = ?"];
  const params: any[] = [DEFAULT_USER_ID];

  if (validAt) {
    wheres.push("datetime(COALESCE(e.valid_from, e.created_at)) <= datetime(?)");
    wheres.push("(e.valid_to IS NULL OR datetime(e.valid_to) > datetime(?))");
    params.push(validAt, validAt);
  } else {
    wheres.push("e.valid_to IS NULL");
  }

  if (knownAt) {
    wheres.push("datetime(e.created_at) <= datetime(?)");
    params.push(knownAt);
  }

  return db.prepare(`
    SELECT e.id, e.from_node_id, e.to_node_id, e.type, e.weight, e.metadata,
           e.valid_from, e.valid_to, e.created_at,
           f.label as from_label, t.label as to_label
    FROM graph_edges e
    JOIN graph_nodes f ON e.from_node_id = f.id
    JOIN graph_nodes t ON e.to_node_id = t.id
    WHERE ${wheres.join(" AND ")}
  `).all(...params) as any[];
}
