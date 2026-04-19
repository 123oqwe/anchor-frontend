/**
 * MCP Server Management — connect external MCP servers + expose Anchor as MCP.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";
import { registerTool } from "../execution/registry.js";

const router = Router();

// Status — list connected servers + exposed tools
router.get("/status", (_req, res) => {
  const servers = db.prepare("SELECT * FROM mcp_servers WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
  const { getAllTools } = require("../execution/registry.js");
  const anchorTools = getAllTools().map((t: any) => t.name);

  res.json({
    anchor: { exposedTools: anchorTools.length, tools: anchorTools },
    external: servers.map((s: any) => ({
      id: s.id, name: s.name, url: s.url, status: s.status,
      tools: JSON.parse(s.tools_json), lastConnected: s.last_connected,
    })),
  });
});

// Connect to external MCP server
router.post("/connect", async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: "name and url required" });

  try {
    // Discover tools via JSON-RPC tools/list
    const listRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    const listData = await listRes.json();
    const tools = listData.result?.tools ?? [];

    // Register each tool as a proxy in L5 registry
    for (const tool of tools) {
      registerTool({
        name: `mcp_${tool.name}`,
        description: `[MCP: ${name}] ${tool.description ?? ""}`,
        handler: "api" as any,
        actionClass: "agent_autonomous" as any,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        execute: async (input: any) => {
          try {
            const callRes = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: tool.name, arguments: input }, id: Date.now() }),
            });
            const callData = await callRes.json();
            const text = callData.result?.content?.[0]?.text ?? JSON.stringify(callData.result ?? {});
            return { success: !callData.result?.isError, output: text };
          } catch (err: any) {
            return { success: false, output: `MCP call failed: ${err.message}`, error: err.message };
          }
        },
      });
    }

    // Save to DB
    const id = nanoid();
    db.prepare("INSERT INTO mcp_servers (id, user_id, name, url, status, tools_json, last_connected) VALUES (?,?,?,?,?,?,datetime('now'))")
      .run(id, DEFAULT_USER_ID, name, url, "connected", JSON.stringify(tools.map((t: any) => t.name)));

    res.json({ id, connected: true, toolsDiscovered: tools.length, tools: tools.map((t: any) => t.name) });
  } catch (err: any) {
    // Save as disconnected
    const id = nanoid();
    db.prepare("INSERT INTO mcp_servers (id, user_id, name, url, status) VALUES (?,?,?,?,?)")
      .run(id, DEFAULT_USER_ID, name, url, "error");
    res.status(500).json({ error: `Failed to connect: ${err.message}` });
  }
});

// Disconnect
router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM mcp_servers WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

// Refresh tools
router.post("/:id/refresh", async (req, res) => {
  const server = db.prepare("SELECT * FROM mcp_servers WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!server) return res.status(404).json({ error: "Server not found" });

  try {
    const listRes = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    const listData = await listRes.json();
    const tools = listData.result?.tools ?? [];

    db.prepare("UPDATE mcp_servers SET status='connected', tools_json=?, last_connected=datetime('now') WHERE id=?")
      .run(JSON.stringify(tools.map((t: any) => t.name)), server.id);

    res.json({ refreshed: true, tools: tools.length });
  } catch (err: any) {
    db.prepare("UPDATE mcp_servers SET status='error' WHERE id=?").run(server.id);
    res.status(500).json({ error: err.message });
  }
});

export default router;
