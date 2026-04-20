/**
 * Bridge HTTP API — localhost-only endpoint for subprocesses spawned by
 * execute_code to call Anchor's Bridge capabilities.
 *
 * Flow:
 *   subprocess (Python/Node code in agent workspace)
 *     → POST http://127.0.0.1:$PORT/local/bridge/dispatch
 *     → Bearer token in Authorization header
 *     → route verifies token, checks capability scope, calls dispatchCapability
 *     → result returned as JSON
 *
 * Why HTTP (not Unix socket)?
 *   Cross-platform (Unix sockets don't work on Windows if Anchor ever ports).
 *   Localhost TCP is already mediated by the OS firewall.
 *   HTTP has built-in tooling (curl to debug, fetch in client).
 *
 * This endpoint is ONLY bound to 127.0.0.1 via the existing Express server.
 * Anyone who can spawn a subprocess on the user's Mac can already do whatever
 * the bridge can — the token scoping is about limiting what a SPECIFIC agent
 * can do, not about network isolation.
 */
import { Router } from "express";
import { verifyToken, isBridgeAllowed } from "../execution/agent-tokens.js";
import { dispatchCapability } from "../bridges/registry.js";

const router = Router();

router.post("/dispatch", async (req, res) => {
  // Localhost guard — belt and suspenders. Express only binds to 127.0.0.1 by
  // default but if someone reconfigures, this keeps the route safe.
  const remote = req.ip || req.socket.remoteAddress || "";
  if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
    return res.status(403).json({ success: false, error: "Localhost only" });
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ success: false, error: "Missing bearer token" });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ success: false, error: "Invalid or expired token" });

  const { capability, input } = req.body ?? {};
  if (typeof capability !== "string") {
    return res.status(400).json({ success: false, error: "Missing capability" });
  }

  if (!isBridgeAllowed(payload, capability)) {
    return res.status(403).json({
      success: false,
      error: `Agent "${payload.agentName}" not allowed to call ${capability}. Allowed: ${payload.allowedBridges.join(", ")}`,
    });
  }

  try {
    const result = await dispatchCapability(capability, input ?? {}, {
      runId: payload.runId,
      agentId: payload.agentId,
      previousResults: [],
      stepIndex: 0,
      totalSteps: 1,
    } as any, "agent_chain");

    res.json({
      success: result.success,
      output: result.output,
      data: result.data ?? null,
      error: result.error ?? null,
      providerId: result.providerId ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List capabilities the current token can call (for subprocess discovery)
router.get("/capabilities", async (req, res) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid token" });

  const { getCapabilities } = await import("../bridges/registry.js");
  const all = getCapabilities();
  const allowed = all.filter(c => isBridgeAllowed(payload, c.name));
  res.json(allowed.map(c => ({
    name: c.name,
    description: c.description,
    inputSchema: c.inputSchema,
  })));
});

export default router;
