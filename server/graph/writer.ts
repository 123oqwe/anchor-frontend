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
  db.prepare(
    "INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, type, weight, metadata) VALUES (?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, fromNodeId, toNodeId, type, weight, metadata ?? null);
  return id;
}

export function deleteEdge(edgeId: string): boolean {
  return db.prepare("DELETE FROM graph_edges WHERE id=? AND user_id=?").run(edgeId, DEFAULT_USER_ID).changes > 0;
}

export function deleteEdgesBetween(fromId: string, toId: string): number {
  return db.prepare("DELETE FROM graph_edges WHERE user_id=? AND from_node_id=? AND to_node_id=?").run(DEFAULT_USER_ID, fromId, toId).changes;
}
