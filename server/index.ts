import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";

// Import DB (runs seed on startup) — also bound so the SIGINT shutdown
// handler can close it cleanly. Was using require() previously, which
// throws under ESM and silently skipped the WAL checkpoint.
import { db } from "./infra/storage/db.js";

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
import { startUserCronRuntime } from "./orchestration/user-cron-runtime.js";
import { startTaskBrain } from "./orchestration/task-brain.js";
import { startSessionRunner } from "./orchestration/session-runner.js";
import { startCloudRelay } from "./cloud/relay-client.js";

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
import proposalsRoutes from "./routes/proposals.js";
import bridgesRoutes from "./routes/bridges.js";
import jobsRoutes from "./routes/jobs.js";
import hooksRoutes from "./routes/hooks.js";
import feedbackRoutes from "./routes/feedback.js";
import backupRoutes from "./routes/backup.js";
import voiceRoutes from "./routes/voice.js";
import workflowsRoutes from "./routes/workflows.js";
import mutationsRoutes from "./routes/mutations.js";
import profileRoutes from "./routes/profile.js";
import missionsRoutes from "./routes/missions.js";
import onboardingRoutes from "./routes/onboarding.js";
import bridgeLocalRoutes from "./routes/bridge-local.js";
import anchorKernelRoutes from "./routes/anchor-kernel.js";
import killerQueriesRoutes from "./routes/killer-queries.js";
import systemAgentsRoutes from "./routes/system-agents.js";
import syncRoutes from "./routes/sync.js";
import projectsLhRoutes from "./routes/projects-longhorizon.js";
import imessageRoutes from "./integrations/imessage.js";
import experimentsRoutes from "./routes/experiments.js";
import approvalsRoutes from "./routes/approvals.js";
import sessionsRoutes from "./routes/sessions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());
  app.use(cookieParser());

  // ── API routes ────────────────────────────────────────────────────────────
  app.use("/api/feedback", feedbackRoutes);
  app.use("/api/backup", backupRoutes);
  app.use("/api/voice", voiceRoutes);
  app.use("/api/workflows", workflowsRoutes);
  app.use("/api/mutations", mutationsRoutes);
  app.use("/api/profile", profileRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/graph", graphRoutes);
  app.use("/api/memory", memoryRoutes);
  app.use("/api/workspace", workspaceRoutes);
  app.use("/api/twin", twinRoutes);
  app.use("/api/agents/proposals", proposalsRoutes);
  // NOTE: agentsRoutes and customAgentsRoutes both mount on /api/agents but
  // own disjoint sub-trees (agentsRoutes: /status /executions /gepa /…;
  // customAgentsRoutes: /custom /pipelines /runs). The
  // "no path collisions on /api/agents mounts" invariant guards this.
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
  app.use("/api/bridges", bridgesRoutes);
  app.use("/api/jobs", jobsRoutes);                  // Task Brain ledger
  app.use("/api/hooks", hooksRoutes);                // P7: user hooks on events
  app.use("/api/missions", missionsRoutes);          // P11: swarm mission viewer
  app.use("/api/onboarding", onboardingRoutes);      // Portrait ceremony
  app.use("/api/killer", killerQueriesRoutes);       // P4: 4 structurally-differentiated analyses
  app.use("/api/system", systemAgentsRoutes);        // Phase 2: system agent + cron user overrides
  app.use("/api/sync", syncRoutes);                  // P6: scanner_events export/import between devices
  app.use("/api/projects-lh", projectsLhRoutes);     // P6: long-horizon project state (Anthropic harness pattern)
  app.use("/local/bridge", bridgeLocalRoutes);      // subprocess → bridge (token-scoped)
  app.use("/local/anchor", anchorKernelRoutes);     // subprocess → kernel (graph/memory/state/web/think)
  app.use("/api/channels/imessage", imessageRoutes);
  app.use("/api/experiments", experimentsRoutes);   // Sprint A — #7 prompt A/B
  app.use("/api/approvals", approvalsRoutes);       // Sprint B — #4 unified approval inbox
  app.use("/api/sessions", sessionsRoutes);         // Phase 1 of #2 — compiled plan sessions (read-only)

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
  startTaskBrain();                              // P4: agent_jobs ledger worker (claim/execute/retry)
  startSessionRunner();                          // Phase 2 of #2: action_steps state-machine (gated by ANCHOR_NEW_SESSION_RUNNER)
  startUserCronRuntime();                        // user_crons scheduler (enqueues to Task Brain on fire)
  startCloudRelay();                             // MVP2: opt-in outbound WS to Anchor Cloud (multi-device)

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

    // Crash recovery — any agent_runs stuck in 'running' state > 10 min old
    // are from a previous process. Mark them 'abandoned' so they don't
    // pollute status counts / metrics.
    import("./execution/checkpoint.js").then(m => {
      const n = m.recoverStaleRuns(10);
      if (n > 0) console.log(`[boot] recovered ${n} stale agent runs → marked abandoned`);
    }).catch(err => console.error("[boot] stale-run recovery failed:", err.message));

    // Connect configured MCP servers so their tools are registered and
    // available to custom agents. Non-blocking — individual server failures
    // don't prevent Anchor from serving requests.
    import("./integrations/mcp/registry.js").then(m => m.initMCPClient())
      .catch(err => console.error("[boot] MCP client init failed:", err.message));

    // OpenTelemetry GenAI semconv — gated by OTEL_ENABLED=true. When off,
    // all trace wrappers are no-ops so there's zero overhead.
    import("./infra/compute/otel.js").then(m => m.initOTel())
      .catch(err => console.error("[boot] OTel init failed:", err.message));

    // Workflow DAG engine — register handlers + workflows + schedule.
    // Runs alongside legacy cron until each legacy job is migrated.
    // Proposal handlers register BEFORE workflow handlers that may chain
    // proposals.evaluate_pending → applyProposal.
    Promise.all([
      import("./cognition/proposal-handlers.js"),
      import("./orchestration/workflow-handlers.js"),
      import("./orchestration/workflow-defs.js"),
      import("./orchestration/workflow.js"),
    ]).then(([ph, h, d, wf]) => {
      ph.registerBuiltinProposalHandlers();
      h.registerBuiltinHandlers();
      d.registerBuiltinWorkflows();
      d.scheduleWorkflows();
      wf.wireEventTriggers();
      console.log("[boot] workflow DAG + proposals online");
    }).catch(err => console.error("[boot] workflow init failed:", err.message));
  });

  // Telegram bot (if token configured)
  import("./integrations/telegram.js").then(m => m.startTelegram()).catch(() => {});
}

startServer().catch(console.error);

// Graceful shutdown — checkpoint SQLite WAL before exit
function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    console.log("[Shutdown] Database closed cleanly");
  } catch (err: any) {
    console.error("[Shutdown] DB close failed:", err?.message ?? err);
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
