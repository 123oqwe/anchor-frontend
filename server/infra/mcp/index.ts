/**
 * L8 Infrastructure — MCP (Model Context Protocol) Server.
 *
 * Exposes Anchor's L5 tools as MCP-compatible endpoints.
 * External MCP clients (Claude Desktop, Cursor, VS Code) can
 * connect and use Anchor's tools.
 *
 * Also supports connecting TO external MCP servers to import their tools.
 *
 * Activation: set MCP_ENABLED=true in .env
 * Protocol: JSON-RPC 2.0 over stdio or HTTP
 */
import { getAllTools, type ToolDef } from "../../execution/registry.js";

let mcpEnabled = false;

export function initMCP(): boolean {
  if (process.env.MCP_ENABLED !== "true") {
    console.log("[MCP] Disabled (set MCP_ENABLED=true to enable)");
    return false;
  }
  mcpEnabled = true;
  console.log("[MCP] Server enabled — tools exposed via MCP protocol");
  return true;
}

// ── MCP tool listing (tools/list response) ──────────────────────────────────

export function getMCPToolList(): {
  tools: { name: string; description: string; inputSchema: any }[];
} {
  const tools = getAllTools();
  const anchorTools = getAnchorMCPTools();
  return {
    tools: [
      ...tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...anchorTools,
    ],
  };
}

// ── MCP tool call handler (tools/call) ──────────────────────────────────────

export async function handleMCPToolCall(
  name: string,
  args: any
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  // Anchor-specific tools (memory, activity, twin, graph)
  if (name.startsWith("anchor_")) {
    const text = await handleAnchorMCPTool(name, args);
    return { content: [{ type: "text", text }] };
  }

  // Standard execution tools
  const { executeTool } = await import("../../execution/registry.js");
  const result = await executeTool(name, args, undefined, "agent_chain");

  return {
    content: [{ type: "text", text: result.output }],
    isError: !result.success,
  };
}

// ── Anchor-specific MCP tools (memory, activity, twin) ─────────────────────
// These let external AI (Cursor, Claude Desktop) query Anchor's full context.

import { db, DEFAULT_USER_ID } from "../storage/db.js";

export function getAnchorMCPTools() {
  return [
    {
      name: "anchor_memory_search",
      description: "Search Anchor's memory system (working/episodic/semantic). Returns scored, relevant memories.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, type: { type: "string", description: "Memory type filter: working, episodic, semantic, or all", default: "all" }, limit: { type: "number", default: 10 } }, required: ["query"] },
    },
    {
      name: "anchor_activity_summary",
      description: "Get what the user has been doing recently — apps, screen time, meetings, content highlights.",
      inputSchema: { type: "object", properties: { hours: { type: "number", description: "Hours to look back", default: 24 } } },
    },
    {
      name: "anchor_twin_insights",
      description: "Get Twin Agent's behavioral insights about the user — what patterns it learned, contraindications, drift.",
      inputSchema: { type: "object", properties: { limit: { type: "number", default: 10 } } },
    },
    {
      name: "anchor_graph_query",
      description: "Query the user's Human Graph — people, goals, projects, risks, values across 5 life domains.",
      inputSchema: { type: "object", properties: { domain: { type: "string", description: "Filter by domain: work, relationships, finance, health, growth" }, type: { type: "string", description: "Filter by node type: person, goal, project, risk, etc." } } },
    },
  ];
}

export async function handleAnchorMCPTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "anchor_memory_search": {
      const q = (args.query ?? "").toLowerCase();
      const typeFilter = args.type && args.type !== "all" ? `AND type='${args.type}'` : "";
      const limit = Math.min(args.limit ?? 10, 30);
      const rows = db.prepare(
        `SELECT type, title, content, confidence, created_at FROM memories WHERE user_id=? ${typeFilter} AND (title LIKE ? OR content LIKE ?) ORDER BY confidence DESC, created_at DESC LIMIT ?`
      ).all(DEFAULT_USER_ID, `%${q}%`, `%${q}%`, limit) as any[];
      if (rows.length === 0) return `No memories found for "${args.query}"`;
      return rows.map((r: any) => `[${r.type}] ${r.title} (conf: ${r.confidence})\n${r.content.slice(0, 200)}`).join("\n---\n");
    }

    case "anchor_activity_summary": {
      const hours = Math.min(args.hours ?? 24, 168);
      const apps = db.prepare(
        `SELECT app_name, COUNT(*) as captures FROM activity_captures WHERE user_id=? AND captured_at >= datetime('now', '-${hours} hours') GROUP BY app_name ORDER BY captures DESC LIMIT 10`
      ).all(DEFAULT_USER_ID) as any[];
      const recent = db.prepare(
        `SELECT app_name, window_title, url FROM activity_captures WHERE user_id=? AND captured_at >= datetime('now', '-${hours} hours') AND window_title != '' ORDER BY captured_at DESC LIMIT 10`
      ).all(DEFAULT_USER_ID) as any[];
      const totalMin = apps.reduce((s: number, a: any) => s + a.captures * 5, 0);
      let result = `Screen time: ${Math.round(totalMin / 60)}h ${totalMin % 60}m (last ${hours}h)\n\n`;
      result += "Top apps:\n" + apps.map((a: any) => `  ${a.app_name}: ${a.captures * 5}min`).join("\n");
      result += "\n\nRecent:\n" + recent.map((r: any) => `  ${r.app_name}: ${r.window_title}${r.url ? ` (${r.url.slice(0, 50)})` : ""}`).join("\n");
      return result;
    }

    case "anchor_twin_insights": {
      const limit = Math.min(args.limit ?? 10, 20);
      const insights = db.prepare(
        "SELECT category, insight, confidence, trend, created_at FROM twin_insights WHERE user_id=? ORDER BY confidence DESC LIMIT ?"
      ).all(DEFAULT_USER_ID, limit) as any[];
      const contraindications = db.prepare(
        "SELECT label, detail FROM graph_nodes WHERE user_id=? AND type='constraint' AND captured LIKE '%Twin%' LIMIT 5"
      ).all(DEFAULT_USER_ID) as any[];
      let result = "Twin Insights:\n" + insights.map((i: any) => `  [${i.category}] ${i.insight} (conf: ${i.confidence})`).join("\n");
      if (contraindications.length > 0) {
        result += "\n\nContraindications (do NOT suggest):\n" + contraindications.map((c: any) => `  ${c.label}: ${c.detail}`).join("\n");
      }
      return result || "No twin insights yet.";
    }

    case "anchor_graph_query": {
      let where = "user_id=?";
      if (args.domain) where += ` AND domain='${args.domain}'`;
      if (args.type) where += ` AND type='${args.type}'`;
      const nodes = db.prepare(`SELECT label, type, domain, status, detail FROM graph_nodes WHERE ${where} ORDER BY updated_at DESC LIMIT 20`).all(DEFAULT_USER_ID) as any[];
      if (nodes.length === 0) return "No matching graph nodes.";
      return nodes.map((n: any) => `[${n.domain}/${n.type}] ${n.label} (${n.status}): ${(n.detail ?? "").slice(0, 100)}`).join("\n");
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// Update getMCPToolList to include Anchor-specific tools
const _originalGetToolList = getMCPToolList;

// ── External MCP server connections (future) ────────────────────────────────

interface ExternalMCPServer {
  name: string;
  url: string;
  tools: string[];
  status: "connected" | "disconnected" | "error";
}

const externalServers: ExternalMCPServer[] = [];

export function registerExternalMCP(name: string, url: string): void {
  externalServers.push({ name, url, tools: [], status: "disconnected" });
  console.log(`[MCP] External server registered: ${name} (${url})`);
}

export function getMCPStatus() {
  return {
    enabled: mcpEnabled,
    exposedTools: getAllTools().length,
    externalServers: externalServers.map(s => ({ name: s.name, url: s.url, status: s.status, tools: s.tools.length })),
  };
}

export function isMCPEnabled(): boolean {
  return mcpEnabled;
}
