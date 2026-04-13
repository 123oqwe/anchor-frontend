import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";

// Import DB (runs seed on startup)
import "./db.js";

// Event bus handlers and cron jobs
import { startEventHandlers } from "./handlers.js";
import { startCronJobs } from "./cron.js";

// Route handlers
import userRoutes from "./routes/user.js";
import graphRoutes from "./routes/graph.js";
import memoryRoutes from "./routes/memory.js";
import workspaceRoutes from "./routes/workspace.js";
import twinRoutes from "./routes/twin.js";
import agentsRoutes from "./routes/agents.js";
import advisorRoutes from "./routes/advisor.js";

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
  startEventHandlers();
  startCronJobs();

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Anchor OS running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
