#!/usr/bin/env tsx
/**
 * Anchor MCP Server — stdio transport.
 *
 * Exposes the Human Graph + Timeline + Memory + Values + Portrait as MCP
 * tools so external MCP hosts (Claude Desktop, Cursor, Goose, Postman,
 * Continue.dev) can read Anchor state directly from user's Mac.
 *
 * Launched by:
 *   npx tsx server/mcp-bin/serve.ts
 *   OR registered in Claude Desktop config as:
 *     { "command": "npx", "args": ["tsx", "/abs/path/server/mcp-bin/serve.ts"] }
 *
 * Transport: stdio only (Claude Desktop's default for local servers).
 * Auth: this server runs as the user, reading the user's own local DB.
 *   There's no network surface to secure. If future HTTP transport is
 *   added, a local token file in ~/.anchor/mcp-auth.json will gate it.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";

// Tool definitions — JSON Schema, no zod at stdio layer
const TOOLS = [
  {
    name: "query_graph",
    description:
      "Query the user's Human Graph — people, projects, goals, values, relationships in 5 life domains. Filter by type, status, domain, label substring.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type filter: person | project | goal | value | identity | constraint | artifact | observation" },
        status: { type: "string", description: "Status filter: active | decaying | blocked | archived" },
        domain: { type: "string", description: "Domain filter: work | relationships | finance | health | growth" },
        labelContains: { type: "string", description: "Case-insensitive substring match on node label" },
        limit: { type: "number", description: "Max results (default 20, max 100)" },
      },
    },
  },
  {
    name: "query_timeline",
    description:
      "Query timestamped events from the user's life — git commits, calendar meetings, message sessions, emails. Optional nodeId scopes to events that touch a specific graph node (e.g. a project).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO timestamp — inclusive" },
        to: { type: "string", description: "ISO timestamp — exclusive" },
        source: { type: "string", description: "git | calendar | message | email | task" },
        nodeId: { type: "string", description: "Only events related to this graph node" },
        limit: { type: "number", description: "Max events (default 50, max 500)" },
      },
    },
  },
  {
    name: "query_memory",
    description:
      "Full-text search Anchor's memory store. Returns episodic (events), semantic (learned facts), working (recent context). Sorted by relevance + confidence.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        limit: { type: "number", description: "Max results (default 10, max 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_active_values",
    description:
      "List the user's active values — what they care about. Each has stated-vs-inferred provenance and a confidence score. Use when you need to understand what would resonate with or conflict with the user.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max values (default 20)" },
      },
    },
  },
  {
    name: "get_portrait",
    description:
      "Get the most recent Portrait — Oracle Council's 5-voice narrative + Compass synthesizer's headline about who the user is right now. Returns compact JSON of headline + paragraph + 3 key questions.",
    inputSchema: {
      type: "object",
      properties: {
        includeOracleNarratives: { type: "boolean", description: "Include full 5-oracle narratives (longer output)" },
      },
    },
  },
  {
    name: "what_changed",
    description:
      "Diff of the user's Human Graph between two timestamps. Returns new edges opened, edges closed (decayed or contradicted), weight changes, and new nodes. Use for 'what's different this week / month / quarter'.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO timestamp — inclusive (default: 7 days ago)" },
        to: { type: "string", description: "ISO timestamp — exclusive (default: now)" },
        nodeId: { type: "string", description: "Scope to edges/nodes touching this specific node" },
      },
    },
  },
  {
    name: "get_rhythm",
    description:
      "Compute the user's work rhythm fingerprint from their timeline — peak hour, peak day-of-week, longest streak, active days, events per week. Useful for 'when should I reach out' or 'when is user most focused'.",
    inputSchema: {
      type: "object",
      properties: {
        windowDays: { type: "number", description: "Lookback window in days (default 180)" },
        source: { type: "string", description: "Restrict to one source: git | calendar | message" },
      },
    },
  },
];

// Static UI resources (MCP Apps spec — Nov 2025)
const RESOURCES = [
  { uri: "anchor://portrait", name: "Current Portrait", mimeType: "text/markdown" },
  { uri: "anchor://values", name: "Active Values", mimeType: "text/markdown" },
  { uri: "anchor://recent-changes", name: "Last 7 days changes", mimeType: "text/markdown" },
];

// ── Tool dispatchers ───────────────────────────────────────────────────

async function dispatchTool(name: string, args: any): Promise<any> {
  switch (name) {
    case "query_graph": {
      const { queryGraph } = await import("../graph/reader.js");
      return queryGraph({
        type: args.type,
        status: args.status,
        domain: args.domain,
        labelContains: args.labelContains,
        limit: Math.min(100, args.limit ?? 20),
      });
    }
    case "query_timeline": {
      const { queryTimeline } = await import("../graph/timeline.js");
      return queryTimeline({
        from: args.from,
        to: args.to,
        source: args.source,
        nodeId: args.nodeId,
        limit: Math.min(500, args.limit ?? 50),
      });
    }
    case "query_memory": {
      const { searchMemories } = await import("../memory/retrieval.js");
      return searchMemories(args.query, Math.min(30, args.limit ?? 10));
    }
    case "get_active_values": {
      const { getActiveValues } = await import("../graph/reader.js");
      return getActiveValues(args.limit ?? 20);
    }
    case "get_portrait": {
      const { getLatestPortrait } = await import("../cognition/oracle-council.js");
      const portrait = getLatestPortrait();
      if (!portrait) return { error: "No portrait yet. Run inferProfile + runOracleCouncil first." };
      if (args.includeOracleNarratives) return portrait;
      return {
        compass: portrait.compass,
        generatedAt: portrait.generatedAt,
        oracleCount: portrait.oracles.length,
      };
    }
    case "what_changed": {
      const { computeChanges } = await import("../graph/what-changed.js");
      const from = args.from ?? new Date(Date.now() - 7 * 86400_000).toISOString();
      const to = args.to ?? new Date().toISOString();
      return computeChanges({ from, to, nodeId: args.nodeId });
    }
    case "get_rhythm": {
      const { computeRhythmFingerprint } = await import("../graph/timeline.js");
      return computeRhythmFingerprint({
        windowDays: args.windowDays ?? 180,
        source: args.source,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function dispatchResource(uri: string): Promise<{ mimeType: string; text: string }> {
  switch (uri) {
    case "anchor://portrait": {
      const { getLatestPortrait } = await import("../cognition/oracle-council.js");
      const p = getLatestPortrait();
      if (!p) return { mimeType: "text/markdown", text: "# Portrait\n\n_(not yet generated)_" };
      return {
        mimeType: "text/markdown",
        text:
`# ${p.compass.headline}

${p.compass.paragraph}

## Questions that matter
${p.compass.three_questions.map(q => `- ${q}`).join("\n")}

---

## Oracle Council
${p.oracles.map(o => `### ${o.icon} ${o.displayName}\n${o.narrative}`).join("\n\n")}

_generated: ${p.generatedAt}_`,
      };
    }
    case "anchor://values": {
      const { getActiveValues } = await import("../graph/reader.js");
      const vs = getActiveValues(30);
      if (vs.length === 0) return { mimeType: "text/markdown", text: "# Values\n\n_(none yet)_" };
      return {
        mimeType: "text/markdown",
        text:
`# Active Values (${vs.length})

${vs.map(v => `- **${v.label}** — ${v.stated ? "stated" : "inferred"} · confidence ${v.confidence.toFixed(2)}`).join("\n")}`,
      };
    }
    case "anchor://recent-changes": {
      const { computeChanges } = await import("../graph/what-changed.js");
      const from = new Date(Date.now() - 7 * 86400_000).toISOString();
      const to = new Date().toISOString();
      const c = computeChanges({ from, to });
      return {
        mimeType: "text/markdown",
        text:
`# Last 7 days

- **${c.summary.newRelationships}** new relationships
- **${c.summary.relationshipsEnded}** relationships closed
- **${c.summary.newProjects}** new projects/goals
- **${c.summary.newContacts}** new contacts
- **${c.summary.totalActiveEdges}** total active edges

## New nodes (${c.newNodes.length})
${c.newNodes.slice(0, 10).map((n: any) => `- [${n.type}] ${n.label}`).join("\n")}`,
      };
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

// ── Server bootstrap ───────────────────────────────────────────────────

export async function startMCPServer() {
  const server = new Server(
    { name: "anchor", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await dispatchTool(req.params.name, req.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: err?.message ?? "tool error" }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    try {
      const r = await dispatchResource(req.params.uri);
      return { contents: [{ uri: req.params.uri, mimeType: r.mimeType, text: r.text }] };
    } catch (err: any) {
      throw new Error(`Resource read failed: ${err?.message ?? "?"}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr is fine — MCP reserves stdout for JSON-RPC only.
  console.error(`[anchor-mcp] connected via stdio · ${TOOLS.length} tools · ${RESOURCES.length} resources`);
}

// Direct-run entry — only starts the server if invoked as a script.
if (import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1]) {
  startMCPServer().catch(err => {
    console.error("[anchor-mcp] fatal:", err);
    process.exit(1);
  });
}
