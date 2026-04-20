/**
 * Anchor Kernel — non-bridge methods callable from subprocess via HTTP.
 *
 * Bridge capabilities (email/calendar/browser) are PHYSICAL — they touch the
 * outside world. Kernel methods are INTERNAL — they touch Anchor's own data
 * (graph, memory, state, web fetch, sub-LLM). Both get exposed under the
 * `anchor.*` client namespace so agent code can use them uniformly.
 *
 * Why separate from bridge?
 *   • Bridge capabilities have providers / tiers / health / fallback chains.
 *     Kernel methods are single-implementation — they're just RPCs into the
 *     Anchor server's own memory/graph/LLM.
 *   • Bridge scope gate (allowed_bridges) doesn't apply — kernel access is
 *     intrinsic to being an agent. If you can run, you can query your KV.
 *
 * Each method receives the caller's TokenPayload (so agentId / runId / agentName
 * are available for logging and KV scoping) plus args from the request body.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { logExecution } from "../infra/storage/db.js";
import {
  getFullGraph, getNodesByType, getNodesByStatus, serializeForPrompt,
} from "../graph/reader.js";
import { searchMemories, writeMemory } from "../memory/retrieval.js";
import { text as llmText } from "../infra/compute/index.js";
import { executeTool } from "./registry.js";
import { nanoid } from "nanoid";
import type { TokenPayload } from "./agent-tokens.js";

// ── Per-run think() call counter (stops runaway sub-LLM loops) ─────────────

const thinkCountsByRun = new Map<string, number>();
const MAX_THINK_PER_RUN = 5;

function tickThink(runId: string): boolean {
  const prev = thinkCountsByRun.get(runId) ?? 0;
  if (prev >= MAX_THINK_PER_RUN) return false;
  thinkCountsByRun.set(runId, prev + 1);
  // Best-effort cleanup — entries older than 10 min get dropped on next tick
  if (thinkCountsByRun.size > 500) {
    thinkCountsByRun.clear();
  }
  return true;
}

// ── Method registry ─────────────────────────────────────────────────────────

export type KernelHandler = (args: any, caller: TokenPayload) => Promise<any>;

const handlers = new Map<string, KernelHandler>();

function register(method: string, handler: KernelHandler): void {
  handlers.set(method, handler);
}

export function hasKernelMethod(method: string): boolean {
  return handlers.has(method);
}

export async function callKernel(method: string, args: any, caller: TokenPayload): Promise<any> {
  const fn = handlers.get(method);
  if (!fn) throw new Error(`Unknown kernel method: ${method}`);
  return fn(args ?? {}, caller);
}

// ── graph.* ─────────────────────────────────────────────────────────────────

register("graph.query", async (args) => {
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);
  const q = String(args.query ?? "").toLowerCase();
  const type = args.type as string | undefined;
  const status = args.status as string | undefined;

  let nodes: any[];
  if (type) nodes = getNodesByType(type as any);
  else if (status) nodes = getNodesByStatus(status);
  else {
    // Default: all nodes, filter by query substring
    const domains = getFullGraph();
    nodes = domains.flatMap((d) => d.nodes);
  }

  if (q) {
    nodes = nodes.filter((n: any) =>
      String(n.label ?? "").toLowerCase().includes(q) ||
      String(n.detail ?? "").toLowerCase().includes(q)
    );
  }

  return nodes.slice(0, limit).map((n: any) => ({
    id: n.id, label: n.label, type: n.type, status: n.status, detail: n.detail,
  }));
});

register("graph.serialize", async () => {
  return { prompt: serializeForPrompt() };
});

// ── memory.* ────────────────────────────────────────────────────────────────

register("memory.search", async (args) => {
  const query = String(args.query ?? "").trim();
  if (!query) return [];
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 50);
  const mems = searchMemories(query, limit);
  return mems.map((m: any) => ({
    id: m.id, type: m.type, title: m.title,
    content: m.content, tags: m.tags, createdAt: m.createdAt,
  }));
});

register("memory.write", async (args, caller) => {
  const title = String(args.title ?? "").slice(0, 200);
  const content = String(args.content ?? "").slice(0, 10_000);
  if (!title && !content) throw new Error("memory.write requires title or content");
  const id = writeMemory({
    type: (args.type ?? "episodic") as any,
    title: title || content.slice(0, 60),
    content,
    tags: Array.isArray(args.tags) ? args.tags.slice(0, 10) : ["agent", caller.agentName],
    source: `Custom: ${caller.agentName}`,
    confidence: Number(args.confidence ?? 0.8),
  });
  return { id };
});

// ── state.* — per-agent KV (reuses agent_kv table) ──────────────────────────

register("state.get", async (args, caller) => {
  const key = String(args.key ?? "");
  if (!key) throw new Error("state.get requires key");
  const row = db.prepare("SELECT value FROM agent_kv WHERE agent_id=? AND key=?").get(caller.agentId, key) as any;
  return { value: row?.value ?? null };
});

register("state.set", async (args, caller) => {
  const key = String(args.key ?? "");
  const value = String(args.value ?? "");
  if (!key) throw new Error("state.set requires key");
  if (value.length > 10_240) throw new Error("value exceeds 10KB limit");

  // Enforce 100-key cap per agent (same as tools.ts agent_state_set)
  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_kv WHERE agent_id=?").get(caller.agentId) as any)?.c ?? 0;
  const exists = db.prepare("SELECT 1 FROM agent_kv WHERE agent_id=? AND key=?").get(caller.agentId, key);
  if (!exists && count >= 100) throw new Error("agent KV at 100-key limit");

  db.prepare("INSERT OR REPLACE INTO agent_kv (agent_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))")
    .run(caller.agentId, key, value);
  return { ok: true, bytes: value.length };
});

register("state.list", async (_args, caller) => {
  const rows = db.prepare("SELECT key, updated_at as updatedAt FROM agent_kv WHERE agent_id=? ORDER BY key").all(caller.agentId) as any[];
  return rows;
});

// ── web.* — reuse tools.ts implementations ──────────────────────────────────

register("web.search", async (args, caller) => {
  const ctx = { runId: caller.runId, agentId: caller.agentId, previousResults: [], stepIndex: 0, totalSteps: 1 } as any;
  const result = await executeTool("web_search", { query: String(args.query ?? "") }, ctx, "agent_chain");
  return { success: result.success, output: result.output, error: result.error };
});

register("web.read_url", async (args, caller) => {
  const ctx = { runId: caller.runId, agentId: caller.agentId, previousResults: [], stepIndex: 0, totalSteps: 1 } as any;
  const result = await executeTool("read_url", { url: String(args.url ?? "") }, ctx, "agent_chain");
  return { success: result.success, output: result.output, error: result.error };
});

// ── tasks.* ─────────────────────────────────────────────────────────────────

register("tasks.create", async (args, caller) => {
  const ctx = { runId: caller.runId, agentId: caller.agentId, previousResults: [], stepIndex: 0, totalSteps: 1 } as any;
  const result = await executeTool("write_task", {
    title: String(args.title ?? ""),
    priority: (args.priority ?? "high") as any,
  }, ctx, "agent_chain");
  return { success: result.success, output: result.output, data: result.data };
});

// ── think — sub-LLM call from agent code (capped per-run) ───────────────────

register("think", async (args, caller) => {
  if (!tickThink(caller.runId)) {
    throw new Error(`think() exceeded ${MAX_THINK_PER_RUN} calls for this run`);
  }
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("think requires prompt");
  const system = String(args.system ?? "You are a focused helper. Respond concisely.").slice(0, 2_000);
  const maxTokens = Math.min(Math.max(Number(args.maxTokens) || 500, 50), 2_000);

  const answer = await llmText({
    task: "decision",
    system,
    messages: [{ role: "user", content: prompt.slice(0, 8_000) }],
    maxTokens,
    runId: caller.runId,
    agentName: `${caller.agentName} (think)`,
  });

  logExecution(`Custom: ${caller.agentName}`, `think() → ${answer.slice(0, 80)}`);
  return { answer };
});

// ── Introspection: list available kernel methods ───────────────────────────

register("meta.list_methods", async () => {
  return Array.from(handlers.keys()).filter((k) => k !== "meta.list_methods");
});
