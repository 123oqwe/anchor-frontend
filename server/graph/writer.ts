/**
 * L1 Human Graph — Writer.
 *
 * Mutation operations on the graph. Only L5 Execution and L4 Orchestration
 * (for system-triggered updates like decay) should call these.
 * All writes go through here — no raw SQL elsewhere.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { type NodeType, type EdgeType, type Domain } from "./ontology.js";

// ── Transaction-safe batch operations ───────────────────────────────────────

/** Run multiple graph mutations atomically. If any fails, all roll back. */
export function transact<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/** Optimistic concurrency: check updated_at before writing. Returns false if stale. */
export function updateNodeIfNotStale(nodeId: string, newStatus: string, expectedUpdatedAt: string): boolean {
  const result = db.prepare(
    "UPDATE graph_nodes SET status=?, updated_at=datetime('now') WHERE id=? AND user_id=? AND updated_at=?"
  ).run(newStatus, nodeId, DEFAULT_USER_ID, expectedUpdatedAt);
  return result.changes > 0;
}

// ── Node mutations ──────────────────────────────────────────────────────────

export interface CreateNodeInput {
  domain: Domain | string;
  label: string;
  type: NodeType | string;
  status: string;
  captured: string;
  detail: string;
}

export function createNode(input: CreateNodeInput): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, input.domain, input.label, input.type, input.status, input.captured, input.detail);
  return id;
}

export function updateNodeStatus(nodeId: string, newStatus: string): boolean {
  const result = db.prepare(
    "UPDATE graph_nodes SET status=?, updated_at=datetime('now') WHERE id=? AND user_id=?"
  ).run(newStatus, nodeId, DEFAULT_USER_ID);
  return result.changes > 0;
}

export function updateNodeDetail(nodeId: string, detail: string): boolean {
  const result = db.prepare(
    "UPDATE graph_nodes SET detail=?, updated_at=datetime('now') WHERE id=? AND user_id=?"
  ).run(detail, nodeId, DEFAULT_USER_ID);
  return result.changes > 0;
}

export function deleteNode(nodeId: string): boolean {
  const result = db.prepare(
    "DELETE FROM graph_nodes WHERE id=? AND user_id=?"
  ).run(nodeId, DEFAULT_USER_ID);
  return result.changes > 0;
}

// ── Batch operations (used by L4 cron / decay) ──────────────────────────────

/** Mark nodes as decaying if not updated in N days. */
export function markStaleAsDecaying(daysSinceUpdate: number): number {
  const result = db.prepare(`
    UPDATE graph_nodes SET status='decaying', updated_at=datetime('now')
    WHERE user_id=? AND status IN ('active','opportunity') AND julianday('now') - julianday(updated_at) > ?
  `).run(DEFAULT_USER_ID, daysSinceUpdate);
  return result.changes;
}

/** Unlock blocked nodes (cascade after a node becomes active). */
export function unlockBlockedNodes(): number {
  const result = db.prepare(
    "UPDATE graph_nodes SET status='todo', updated_at=datetime('now') WHERE user_id=? AND status='blocked'"
  ).run(DEFAULT_USER_ID);
  return result.changes;
}

// ── Edge mutations ──────────────────────────────────────────────────────────

export function createEdge(fromNodeId: string, toNodeId: string, type: EdgeType | string, weight = 1.0, metadata?: string): string {
  const id = nanoid();
  // valid_from = now (edge is currently active). valid_to stays NULL until closed.
  db.prepare(
    "INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, type, weight, metadata, valid_from) VALUES (?,?,?,?,?,?,?,datetime('now'))"
  ).run(id, DEFAULT_USER_ID, fromNodeId, toNodeId, type, weight, metadata ?? null);
  return id;
}

export function deleteEdge(edgeId: string): boolean {
  return db.prepare("DELETE FROM graph_edges WHERE id=? AND user_id=?").run(edgeId, DEFAULT_USER_ID).changes > 0;
}

export function deleteEdgesBetween(fromId: string, toId: string): number {
  return db.prepare("DELETE FROM graph_edges WHERE user_id=? AND from_node_id=? AND to_node_id=?").run(DEFAULT_USER_ID, fromId, toId).changes;
}

/**
 * Soft-close an edge: set valid_to=now. The row stays in the table so history
 * queries can see "this tie existed from X to Y". Prefer this over deleteEdge
 * for any meaningful relationship — hard delete loses the evolution trail.
 */
export function closeEdge(edgeId: string): boolean {
  return db.prepare(
    "UPDATE graph_edges SET valid_to=datetime('now') WHERE id=? AND user_id=? AND valid_to IS NULL"
  ).run(edgeId, DEFAULT_USER_ID).changes > 0;
}

/**
 * Soft-close contextual-ish edges that have not been re-confirmed by any
 * profile inference (or other edge-opening flow) in `maxAgeDays` — these
 * are relationships the scanner hasn't seen fresh evidence for in a long
 * time. Keeps the edge row for history (valid_to stamped), returns count.
 *
 * Applied only to types that represent "time-sensitive ties" — `contextual`
 * (person-to-person strength) and `supports` (identity → interest backing).
 * Structural edges like `depends_on` or `conflicts_with` are intentionally
 * excluded because they don't decay simply by not being re-mentioned.
 */
export function closeStaleEdges(maxAgeDays: number, types: string[] = ["contextual", "supports"]): number {
  const placeholders = types.map(() => "?").join(",");
  const result = db.prepare(
    `UPDATE graph_edges SET valid_to = datetime('now')
     WHERE user_id = ?
       AND valid_to IS NULL
       AND type IN (${placeholders})
       AND julianday('now') - julianday(valid_from) > ?`
  ).run(DEFAULT_USER_ID, ...types, maxAgeDays);
  return result.changes;
}

/**
 * Open a new version of a relationship: soft-close any currently-active edges
 * matching (from, to, type), then create a fresh edge. Returns the new edge id.
 * This is how relationship weight changes get recorded as history versions.
 */
export function replaceEdgeVersion(
  fromNodeId: string,
  toNodeId: string,
  type: EdgeType | string,
  weight: number,
  metadata?: string,
): string {
  return transact(() => {
    db.prepare(
      "UPDATE graph_edges SET valid_to=datetime('now') WHERE user_id=? AND from_node_id=? AND to_node_id=? AND type=? AND valid_to IS NULL"
    ).run(DEFAULT_USER_ID, fromNodeId, toNodeId, type);
    return createEdge(fromNodeId, toNodeId, type, weight, metadata);
  });
}
