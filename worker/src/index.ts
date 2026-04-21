/**
 * Anchor Cloud Relay — Cloudflare Worker entry.
 *
 * Routes:
 *   GET  /ws/device/:id   — WebSocket upgrade for a runner or viewer
 *   GET  /api/devices     — list online/offline devices + capabilities
 *   GET  /api/agents      — aggregated agents from all connected runners
 *   GET  /api/jobs        — recent job history (for mobile UI)
 *   POST /api/run         — trigger an agent ({agentName, message, deviceId?})
 *   GET  /mobile          — static HTML UI for phone/tablet
 *
 * Single-user MVP. Single Durable Object instance ("main"). Later: one DO
 * per user, sharded by account UUID from Clerk JWT.
 */
export { AnchorHub } from "./durable-object";

interface Env {
  ANCHOR_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUTH_TOKEN?: string;
}

const ACCOUNT_ID = "main"; // single-user MVP — one DO for Harry's account

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Mobile UI (static assets at /public/)
    if (path === "/" || path === "/mobile" || path === "/mobile/") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }
    if (path.startsWith("/mobile/")) {
      const sub = path.replace("/mobile", "");
      return env.ASSETS.fetch(new Request(new URL(sub || "/index.html", request.url), request));
    }

    // Simple bearer-token auth for API + WS (hardcoded single-user)
    // WS upgrade uses ?token=X since browsers can't set headers on WebSocket
    const authHeader = request.headers.get("Authorization") ?? "";
    const queryToken = url.searchParams.get("token");
    const token = authHeader.replace(/^Bearer\s+/i, "") || queryToken || "";
    if (env.AUTH_TOKEN && token !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Route everything else to the single DO
    const id = env.ANCHOR_HUB.idFromName(ACCOUNT_ID);
    const stub = env.ANCHOR_HUB.get(id);
    return stub.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Every minute — nudge the DO. It decides what (if anything) to fire.
    const id = env.ANCHOR_HUB.idFromName(ACCOUNT_ID);
    const stub = env.ANCHOR_HUB.get(id);
    await stub.fetch(
      new Request("https://internal/internal/cron-tick", { method: "POST" })
    );
  },
};
