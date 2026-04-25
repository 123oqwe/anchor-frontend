/**
 * MCP management routes — configure external MCP servers, connect/disconnect,
 * discover tools. Inbound MCP (Anchor as client). Mount at /api/mcp.
 */
import { Router } from "express";
import {
  createServer, listServers, loadServer, deleteServer,
  connectServer, disconnectServer,
} from "../integrations/mcp/registry.js";

const router = Router();

router.get("/servers", (_req, res) => {
  res.json({ servers: listServers() });
});

router.get("/servers/:id", (req, res) => {
  const s = loadServer(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ server: s });
});

router.post("/servers", (req, res) => {
  const body = req.body ?? {};
  if (!body.name || typeof body.name !== "string") {
    return res.status(400).json({ error: "name required" });
  }
  const transport = body.transport ?? "stdio";
  if (transport === "stdio" && !body.command) {
    return res.status(400).json({ error: "command required for stdio transport" });
  }
  try {
    const server = createServer({
      name: body.name,
      transport,
      command: body.command,
      args: Array.isArray(body.args) ? body.args : [],
      env: typeof body.env === "object" && body.env !== null ? body.env : {},
      url: body.url,
      enabled: body.enabled !== false,
    });
    res.json({ server });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "create failed" });
  }
});

router.delete("/servers/:id", (req, res) => {
  const ok = deleteServer(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

router.post("/servers/:id/connect", async (req, res) => {
  const result = await connectServer(req.params.id);
  res.json(result);
});

router.post("/servers/:id/disconnect", (req, res) => {
  disconnectServer(req.params.id);
  res.json({ ok: true });
});

router.post("/servers/:id/refresh", async (req, res) => {
  disconnectServer(req.params.id);
  const result = await connectServer(req.params.id);
  res.json(result);
});

// Legacy/back-compat: /status — lists externally-connected servers & their tools.
router.get("/status", (_req, res) => {
  res.json({
    external: listServers().map(s => ({
      id: s.id, name: s.name, transport: s.transport,
      status: s.status, tools: s.tools.map(t => t.name),
      lastConnected: s.lastConnectedAt, lastError: s.lastError,
    })),
  });
});

export default router;
