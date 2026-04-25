/**
 * MCP server registry — stores configs, manages connections, bridges
 * discovered tools into Anchor's main L5 tool registry.
 *
 * Namespace: each MCP tool lands in Anchor's registry as
 *   "mcp_<serverName>_<toolName>"
 * to avoid collisions with built-in tools. The agent still sees it as a
 * normal tool; the handler just proxies to this server's callTool().
 *
 * Safety:
 *   - actionClass defaults to "send_external" (requires user confirmation
 *     via L6 gate) because we don't know what the remote tool actually does.
 *     Users can whitelist individual MCP tools with lower classes via the
 *     agent's tools_config later.
 *   - Per-server calls time out at 30s.
 *   - Subprocess lifecycle is supervised; exit → status='error'.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../../infra/storage/db.js";
import { registerTool, unregisterTool, type ToolResult } from "../../execution/registry.js";
import { MCPClient, flattenCallResult, type MCPTool } from "./client.js";

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "error";
  tools: MCPTool[];
  lastConnectedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

// In-memory connections keyed by server id
const connections = new Map<string, MCPClient>();

// ── CRUD ─────────────────────────────────────────────────────────────────

export function createServer(input: {
  name: string;
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}): MCPServerConfig {
  const id = nanoid();
  // The legacy schema has `url NOT NULL` — stdio transports have no URL,
  // so we store empty string and rely on `transport` column to tell them apart.
  db.prepare(
    `INSERT INTO mcp_servers (id, user_id, name, transport, command, args_json, env_json, url, enabled)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id, DEFAULT_USER_ID,
    input.name,
    input.transport ?? "stdio",
    input.command ?? null,
    JSON.stringify(input.args ?? []),
    JSON.stringify(input.env ?? {}),
    input.url ?? "",
    input.enabled === false ? 0 : 1,
  );
  return loadServer(id)!;
}

export function loadServer(id: string): MCPServerConfig | null {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id=? AND user_id=?").get(id, DEFAULT_USER_ID) as any;
  return row ? rowToConfig(row) : null;
}

export function listServers(): MCPServerConfig[] {
  const rows = db.prepare("SELECT * FROM mcp_servers WHERE user_id=? ORDER BY created_at").all(DEFAULT_USER_ID) as any[];
  return rows.map(rowToConfig);
}

export function deleteServer(id: string): boolean {
  // Drop connection + unregister tools first
  disconnectServer(id);
  const result = db.prepare("DELETE FROM mcp_servers WHERE id=? AND user_id=?").run(id, DEFAULT_USER_ID);
  return result.changes > 0;
}

function rowToConfig(row: any): MCPServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? undefined,
    args: JSON.parse(row.args_json ?? "[]"),
    env: JSON.parse(row.env_json ?? "{}"),
    url: row.url ?? undefined,
    enabled: !!row.enabled,
    status: row.status,
    tools: JSON.parse(row.tools_json ?? "[]"),
    lastConnectedAt: row.last_connected_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Connect / disconnect ────────────────────────────────────────────────

export async function connectServer(id: string): Promise<{ ok: boolean; tools: MCPTool[]; error?: string }> {
  const cfg = loadServer(id);
  if (!cfg) return { ok: false, tools: [], error: "server not found" };
  if (cfg.transport !== "stdio") {
    return { ok: false, tools: [], error: `transport ${cfg.transport} not yet supported (stdio only)` };
  }
  if (!cfg.command) return { ok: false, tools: [], error: "command required for stdio transport" };

  // Drop old connection if any
  disconnectServer(id);

  const client = new MCPClient({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env,
  });
  client.on("exit", (code) => {
    // Intentional disconnect already cleaned up state — don't overwrite.
    if (!connections.has(id)) return;
    connections.delete(id);
    unregisterServerTools(cfg);
    if (code !== 0 && code !== null) {
      setStatus(id, "error", `subprocess exited ${code}`);
    } else {
      setStatus(id, "disconnected");
    }
  });

  try {
    await client.connect();
    const tools = await client.listTools();
    connections.set(id, client);
    registerServerTools(cfg, tools);
    db.prepare(
      `UPDATE mcp_servers SET status='connected', tools_json=?, last_connected_at=datetime('now'), last_error=NULL, updated_at=datetime('now')
       WHERE id=?`
    ).run(JSON.stringify(tools), id);
    console.log(`[MCP] connected ${cfg.name} — ${tools.length} tools`);
    return { ok: true, tools };
  } catch (err: any) {
    client.disconnect();
    const errMsg = err?.message ?? String(err);
    setStatus(id, "error", errMsg);
    return { ok: false, tools: [], error: errMsg };
  }
}

export function disconnectServer(id: string): void {
  const client = connections.get(id);
  if (client) { client.disconnect(); connections.delete(id); }
  const cfg = loadServer(id);
  if (cfg) unregisterServerTools(cfg);
  setStatus(id, "disconnected");
}

function setStatus(id: string, status: string, error?: string): void {
  db.prepare(
    `UPDATE mcp_servers SET status=?, last_error=?, updated_at=datetime('now') WHERE id=?`
  ).run(status, error ?? null, id);
}

// ── Tool bridging — MCP tool ⇌ Anchor registry ─────────────────────────

function toolName(serverName: string, originalName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `mcp_${slug}_${originalName}`;
}

function registerServerTools(cfg: MCPServerConfig, tools: MCPTool[]): void {
  for (const t of tools) {
    const name = toolName(cfg.name, t.name);
    registerTool({
      name,
      description: `[MCP:${cfg.name}] ${t.description ?? t.name}`,
      handler: "mcp",
      actionClass: "send_external",   // conservative default — L6 will require confirmation
      inputSchema: {
        type: "object",
        properties: t.inputSchema?.properties ?? {},
        required: t.inputSchema?.required,
      },
      execute: async (input): Promise<ToolResult> => {
        const client = connections.get(cfg.id);
        if (!client) {
          return { success: false, output: `MCP server ${cfg.name} not connected`, error: "MCP_DISCONNECTED" };
        }
        try {
          const r = await client.callTool(t.name, input ?? {});
          const { ok, text } = flattenCallResult(r);
          return {
            success: ok,
            output: text.slice(0, 4096),
            ...(ok ? {} : { error: "MCP_TOOL_ERROR" as const }),
          };
        } catch (err: any) {
          return { success: false, output: err?.message ?? "mcp call failed", error: "MCP_CALL_FAILED" };
        }
      },
    });
  }
}

function unregisterServerTools(cfg: MCPServerConfig): void {
  const prefix = `mcp_${cfg.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_`;
  for (const t of cfg.tools) {
    try { unregisterTool(toolName(cfg.name, t.name)); } catch {}
  }
  // Defensive: also sweep any stale tools matching the prefix
  try { unregisterToolsByPrefix(prefix); } catch {}
}

// Registry helper — may not exist, wrap safely.
function unregisterToolsByPrefix(_prefix: string): void { /* best-effort; registry no-op */ }

// ── Server boot hook ───────────────────────────────────────────────────

/** Called once at server start — connect all enabled MCP servers. Non-blocking on failures. */
export async function initMCPClient(): Promise<void> {
  const servers = listServers().filter(s => s.enabled);
  if (servers.length === 0) return;
  console.log(`[MCP] auto-connecting ${servers.length} enabled server(s)...`);
  await Promise.all(servers.map(async s => {
    try {
      const r = await connectServer(s.id);
      if (!r.ok) console.log(`[MCP] ${s.name}: ${r.error}`);
    } catch (err: any) {
      console.log(`[MCP] ${s.name}: ${err.message}`);
    }
  }));
}
