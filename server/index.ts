import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";

// Import DB (runs seed on startup)
import "./infra/storage/db.js";

// L5 Execution: register tools
import { registerBuiltinTools } from "./execution/tools.js";
// L8 Infrastructure: Hand + MCP
import { initHand } from "./infra/hand/index.js";
import { initMCP } from "./infra/mcp/index.js";

// Event bus handlers and cron jobs
import { startEventHandlers } from "./orchestration/handlers.js";
import { startCronJobs } from "./orchestration/cron.js";

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
  await initHand();         // L8: Browser + Computer Use tools
  initMCP();                // L8: MCP server
  startEventHandlers();
  startCronJobs();

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Anchor OS running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
