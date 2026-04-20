/**
 * Anchor Kernel HTTP route — non-bridge RPCs for agent subprocess.
 *
 * Flow:
 *   subprocess (execute_code)
 *     → POST http://127.0.0.1:$PORT/local/anchor/kernel
 *     → Bearer token (same HMAC as /local/bridge)
 *     → body {method: "graph.query", args: {...}}
 *     → callKernel routes to handler, returns JSON
 *
 * No per-method scope here — any agent code that can run has full kernel
 * access (graph/memory/state are intrinsic to being an agent). Bridge scope
 * still lives at /local/bridge where it belongs.
 */
import { Router } from "express";
import { verifyToken } from "../execution/agent-tokens.js";
import { callKernel } from "../execution/kernel.js";

const router = Router();

router.post("/kernel", async (req, res) => {
  // Localhost guard — belt and suspenders (Express listens on all interfaces
  // by default; if someone exposes the port we shouldn't hand over the kernel).
  const remote = req.ip || req.socket.remoteAddress || "";
  if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
    return res.status(403).json({ success: false, error: "Localhost only" });
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ success: false, error: "Missing bearer token" });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ success: false, error: "Invalid or expired token" });

  const { method, args } = req.body ?? {};
  if (typeof method !== "string") {
    return res.status(400).json({ success: false, error: "Missing method" });
  }

  try {
    const result = await callKernel(method, args ?? {}, payload);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
