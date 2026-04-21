/**
 * Cloud Relay Client — Mac / Linux / (future Windows) runners open an outbound
 * WebSocket to the Anchor Cloud Relay (Cloudflare DO) so tasks can be pushed
 * from cloud even when the device is behind NAT / firewall.
 *
 * Lifecycle:
 *   1. On boot, if ANCHOR_CLOUD_URL is set, connect.
 *   2. Send hello { deviceId, platform, bridges, agents }
 *   3. Heartbeat every 30s
 *   4. Listen for dispatch → enqueue via Task Brain
 *   5. On job state change, push job_update back
 *   6. On disconnect, reconnect with exponential backoff (1s, 5s, 30s, 2m cap)
 *
 * This file is the ONLY piece of Anchor that opens an outbound network socket
 * to someone else's service. Everything else is local or bound to localhost.
 * Opt-in via env ANCHOR_CLOUD_URL.
 */
import WebSocket from "ws";
import os from "os";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { getProviders } from "../bridges/registry.js";
import { enqueueJob } from "../orchestration/task-brain.js";
import { bus } from "../orchestration/bus.js";

const HEARTBEAT_MS = 30_000;
const BACKOFF_SCHEDULE_MS = [1_000, 5_000, 30_000, 120_000];

interface RelayConfig {
  cloudUrl: string;
  authToken?: string;
  deviceId: string;
  primary: boolean;
}

let activeClient: RelayClient | null = null;

export function startCloudRelay(): void {
  const cloudUrl = process.env.ANCHOR_CLOUD_URL;
  if (!cloudUrl) return; // opt-in: no env = no relay
  const deviceId = process.env.ANCHOR_DEVICE_ID || autoDeviceId();
  const authToken = process.env.ANCHOR_CLOUD_TOKEN;
  const primary = process.env.ANCHOR_DEVICE_PRIMARY !== "false";

  activeClient = new RelayClient({ cloudUrl, authToken, deviceId, primary });
  activeClient.connect();
  console.log(`☁️  Cloud Relay started — deviceId="${deviceId}" primary=${primary} → ${cloudUrl}`);

  // Route Task Brain state transitions back to cloud so the mobile UI sees them.
  bus.on("event", (e: any) => {
    if (e.type !== "NOTIFICATION") return;
    const id = e.payload?.id ?? "";
    // Only forward our own job notifications (job-ok-* / job-fail-*).
    // Everything else is bus chatter not relevant to cloud viewers.
    const m = id.match(/^job-(ok|fail)-(.+)$/);
    if (!m) return;
    activeClient?.pushJobUpdate({
      type: "job_update",
      jobId: m[2],
      deviceId: deviceId,
      state: m[1] === "ok" ? "succeeded" : "failed",
      result: e.payload?.body?.slice(0, 300),
    });
  });
}

export function getCloudRelayStatus(): { connected: boolean; deviceId: string; url?: string } | null {
  if (!activeClient) return null;
  return { connected: activeClient.connected, deviceId: activeClient.deviceId, url: activeClient.cloudUrl };
}

// ── Auto device id ──────────────────────────────────────────────────────────

function autoDeviceId(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return `${os.platform()}-${host}`.slice(0, 48);
}

// ── RelayClient ─────────────────────────────────────────────────────────────

class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayConfig;
  private backoffIdx = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  connected = false;

  constructor(cfg: RelayConfig) { this.config = cfg; }

  get deviceId(): string { return this.config.deviceId; }
  get cloudUrl(): string { return this.config.cloudUrl; }

  connect(): void {
    if (this.stopped) return;
    const baseUrl = this.config.cloudUrl.replace(/\/$/, "");
    const tokenQ = this.config.authToken ? `?token=${encodeURIComponent(this.config.authToken)}` : "";
    const wsUrl = `${baseUrl}/ws/device/${encodeURIComponent(this.config.deviceId)}${tokenQ}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err: any) {
      this.scheduleReconnect(err?.message);
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.backoffIdx = 0;
      this.sendHello();
      this.startHeartbeat();
      console.log(`[CloudRelay] connected`);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {}
    });

    ws.on("close", (code, reason) => {
      this.connected = false;
      this.stopHeartbeat();
      console.log(`[CloudRelay] disconnected (${code} ${reason?.toString()})`);
      this.scheduleReconnect(`closed ${code}`);
    });

    ws.on("error", (err) => {
      console.error("[CloudRelay] error:", err.message);
      // close will fire next; don't schedule reconnect here (avoid double)
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(1000, "stopping"); } catch {}
  }

  pushJobUpdate(update: any): void {
    this.send(update);
  }

  // ── Protocol ────────────────────────────────────────────────────────

  private sendHello(): void {
    const providers = getProviders();
    const bridges: Record<string, string[]> = {};
    for (const p of providers) {
      if (!bridges[p.capability]) bridges[p.capability] = [];
      bridges[p.capability].push(p.id);
    }

    const agents = (db.prepare(
      "SELECT id, name, tools, trigger_type FROM user_agents WHERE user_id=? AND enabled=1"
    ).all(DEFAULT_USER_ID) as any[]).map((a: any) => ({
      id: a.id,
      name: a.name,
      tools: safeParse<string[]>(a.tools, []),
      trigger_type: a.trigger_type,
    }));

    this.send({
      type: "hello",
      deviceId: this.config.deviceId,
      kind: "runner",
      platform: os.platform(),
      version: "mvp2-1",
      bridges,
      agents,
      preferences: { primary: this.config.primary },
    });
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "dispatch":
        this.handleDispatch(msg);
        break;
      case "ack":
      case "pong":
        break;
      case "error":
        console.error("[CloudRelay] server error:", msg.message);
        break;
    }
  }

  private handleDispatch(msg: any): void {
    console.log(`[CloudRelay] dispatch ${msg.jobId} → ${msg.actionType} (${msg.name})`);

    // Push immediate "claimed" ack so the UI reacts fast
    this.send({
      type: "job_update",
      jobId: msg.jobId,
      deviceId: this.config.deviceId,
      state: "claimed",
    });

    try {
      enqueueJob({
        source: "channel",
        sourceId: msg.jobId,
        actionType: msg.actionType,
        actionConfig: msg.actionConfig ?? {},
        name: msg.name ?? `Cloud dispatch ${msg.jobId}`,
      });
    } catch (err: any) {
      this.send({
        type: "job_update",
        jobId: msg.jobId,
        deviceId: this.config.deviceId,
        state: "failed",
        error: err.message?.slice(0, 300),
      });
    }
  }

  // ── Connection bookkeeping ─────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private scheduleReconnect(why?: string): void {
    if (this.stopped) return;
    const delay = BACKOFF_SCHEDULE_MS[Math.min(this.backoffIdx, BACKOFF_SCHEDULE_MS.length - 1)];
    this.backoffIdx++;
    console.log(`[CloudRelay] reconnect in ${delay}ms${why ? ` (${why})` : ""}`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(msg: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)); } catch {}
  }
}

function safeParse<T>(s: any, fallback: T): T {
  if (typeof s !== "string") return s ?? fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
