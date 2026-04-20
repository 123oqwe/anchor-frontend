import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";

// Import DB (runs seed on startup)
import "./infra/storage/db.js";

// L5 Execution: register tools
import { registerBuiltinTools } from "./execution/tools.js";
import { registerDevTools } from "./execution/dev-tools.js";
// L8 Infrastructure: Hand + MCP
import { initHand } from "./infra/hand/index.js";
import { initMCP } from "./infra/mcp/index.js";

// Event bus handlers and cron jobs
import { startEventHandlers } from "./orchestration/handlers.js";
import { startCronJobs } from "./orchestration/cron.js";
import { startEventTriggers, startWatchersFromAgents } from "./orchestration/event-triggers.js";

// Route handlers
import userRoutes from "./routes/user.js";
import graphRoutes from "./routes/graph.js";
import memoryRoutes from "./routes/memory.js";
import workspaceRoutes from "./routes/workspace.js";
import twinRoutes from "./routes/twin.js";
import agentsRoutes from "./routes/agents.js";
import advisorRoutes from "./routes/advisor.js";
import adminRoutes from "./routes/admin.js";
import skillsRoutes from "./routes/skills.js";
import preferencesRoutes from "./routes/preferences.js";
import integrationsRoutes from "./routes/integrations.js";
import privacyRoutes from "./routes/privacy.js";
import notificationsRoutes from "./routes/notifications.js";
import cronsRoutes from "./routes/crons.js";
import customAgentsRoutes from "./routes/custom-agents.js";
import mcpRoutes from "./routes/mcp.js";
import imessageRoutes from "./integrations/imessage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());
  app.use(cookieParser());

  // ── API routes ────────────────────────────────────────────────────────────
  app.use("/api/user", userRoutes);
  app.use("/api/graph", graphRoutes);
  app.use("/api/memory", memoryRoutes);
  app.use("/api/workspace", workspaceRoutes);
  app.use("/api/twin", twinRoutes);
  app.use("/api/agents", agentsRoutes);
  app.use("/api/advisor", advisorRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/skills", skillsRoutes);
  app.use("/api/preferences", preferencesRoutes);
  app.use("/api/integrations", integrationsRoutes);
  app.use("/api/privacy", privacyRoutes);
  app.use("/api/notifications", notificationsRoutes);
  app.use("/api/crons", cronsRoutes);
  app.use("/api/agents", customAgentsRoutes);
  app.use("/api/mcp", mcpRoutes);
  app.use("/api/channels/imessage", imessageRoutes);

  // ── Static / SPA ──────────────────────────────────────────────────────────
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  // ── Start agent harness ───────────────────────────────────────────────────
  registerBuiltinTools();
  registerDevTools();       // OPT-1: dev tools (file IO, git, test, shell)
  await initHand();         // L8: Browser + Computer Use tools
  initMCP();                // L8: MCP server
  startEventHandlers();
  startCronJobs();
  startEventTriggers();                          // OPT-2: route events to Custom Agents
  startWatchersFromAgents().catch(() => {});     // OPT-2: start file/idle watchers if agents need them

  // ── WebSocket — real-time event push to frontend ───────────────────────────
  const wss = new WebSocketServer({ server, path: "/ws" });
  const wsClients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => wsClients.delete(ws));
  });

  // Forward bus events to all connected WebSocket clients
  const { bus } = await import("./orchestration/bus.js");
  bus.on("event", (e: any) => {
    const msg = JSON.stringify({ type: e.type, payload: e.payload });
    wsClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Anchor OS running on http://localhost:${port}/`);
    console.log(`🔌 WebSocket on ws://localhost:${port}/ws`);
  });

  // Telegram bot (if token configured)
  import("./integrations/telegram.js").then(m => m.startTelegram()).catch(() => {});
}

startServer().catch(console.error);

// Graceful shutdown — checkpoint SQLite WAL before exit
function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  try {
    const { db } = require("./infra/storage/db.js");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    console.log("[Shutdown] Database closed cleanly");
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
