/**
 * AnchorHub — one Durable Object per user account.
 *
 * Uses Cloudflare's hibernation-safe WebSocket API (state.acceptWebSocket)
 * so connections survive DO eviction/restart without closing. Device metadata
 * is persisted to state.storage so we can reconstruct the device table on
 * every request regardless of whether the DO was just woken up.
 *
 * Per-account state:
 *   • state.getWebSockets(tag) — all accepted WS for a device
 *   • state.storage "device:<id>" — HelloMsg snapshot
 *   • state.storage "history" — recent CloudJob list (capped 500)
 */
import type {
  ClientMsg, HelloMsg, HeartbeatMsg, JobUpdateMsg, SyncAgentsMsg,
  DispatchMsg, DeviceSummary, CloudJob, RunRequest,
} from "./types";

const DEVICE_STALE_MS = 2 * 60_000;
const MAX_HISTORY = 500;

interface DeviceRecord {
  info: HelloMsg;
  lastSeen: number;
  connectedAt: number;
}

export class AnchorHub {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  // ── Request dispatch ──────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/ws/device/")) {
      const deviceId = path.split("/").pop()!;
      return this.handleWsUpgrade(request, deviceId);
    }

    if (path === "/api/devices" && request.method === "GET")    return this.json(await this.listDevices());
    if (path === "/api/agents"  && request.method === "GET")    return this.json(await this.aggregateAgents());
    if (path === "/api/jobs"    && request.method === "GET")    return this.json(await this.getHistory());
    if (path === "/api/run"     && request.method === "POST")   return this.json(await this.handleRunRequest(await request.json()));
    if (path === "/internal/cron-tick" && request.method === "POST") return this.json({ ticked: true });

    return new Response("Not found", { status: 404 });
  }

  // ── WebSocket — hibernation-safe ──────────────────────────────────────

  private async handleWsUpgrade(request: Request, deviceId: string): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    // Close any previous connection for this deviceId
    const prior = this.state.getWebSockets(deviceId);
    for (const w of prior) {
      try { w.close(1000, "replaced"); } catch {}
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [deviceId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by the runtime for every message on accepted WebSockets. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: ClientMsg;
    try { msg = JSON.parse(message); } catch { return this.send(ws, { type: "error", message: "bad json" }); }

    const tags = this.state.getTags(ws);
    const deviceId = tags[0];

    switch (msg.type) {
      case "hello":       await this.handleHello(ws, deviceId, msg); break;
      case "heartbeat":   await this.handleHeartbeat(ws, deviceId); break;
      case "job_update":  await this.handleJobUpdate(msg); break;
      case "sync_agents": await this.handleSyncAgents(deviceId, msg); break;
      default:            this.send(ws, { type: "error", message: "unknown msg type" });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Leave device record in storage (it may reconnect). Online status is
    // determined by lastSeen + whether any WS is tagged with the deviceId.
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> { /* no-op */ }

  // ── Message handlers ──────────────────────────────────────────────────

  private async handleHello(ws: WebSocket, deviceId: string, msg: HelloMsg): Promise<void> {
    const record: DeviceRecord = {
      info: msg,
      lastSeen: Date.now(),
      connectedAt: Date.now(),
    };
    await this.state.storage.put(`device:${deviceId}`, record);
    console.log(`[Hub] hello from ${deviceId} (${msg.platform} ${msg.kind}, ${Object.keys(msg.bridges).length} bridges)`);
    this.send(ws, { type: "ack", message: `registered ${deviceId}` });
  }

  private async handleHeartbeat(ws: WebSocket, deviceId: string): Promise<void> {
    const rec = await this.state.storage.get<DeviceRecord>(`device:${deviceId}`);
    if (rec) {
      rec.lastSeen = Date.now();
      await this.state.storage.put(`device:${deviceId}`, rec);
    }
    this.send(ws, { type: "pong" });
  }

  private async handleJobUpdate(msg: JobUpdateMsg): Promise<void> {
    const history = (await this.state.storage.get<CloudJob[]>("history")) ?? [];
    const idx = history.findIndex(j => j.id === msg.jobId);
    const now = new Date().toISOString();
    if (idx >= 0) {
      history[idx].state = msg.state;
      history[idx].updatedAt = now;
      if (msg.result) history[idx].result = msg.result;
      if (msg.error) history[idx].error = msg.error;
      history[idx].deviceId = msg.deviceId;
    } else {
      history.push({
        id: msg.jobId, deviceId: msg.deviceId,
        name: msg.jobId, actionType: "unknown",
        state: msg.state, createdAt: now, updatedAt: now,
        result: msg.result, error: msg.error,
      });
    }
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await this.state.storage.put("history", history);
  }

  private async handleSyncAgents(deviceId: string, msg: SyncAgentsMsg): Promise<void> {
    const rec = await this.state.storage.get<DeviceRecord>(`device:${deviceId}`);
    if (rec) {
      rec.info.agents = msg.agents as any;
      await this.state.storage.put(`device:${deviceId}`, rec);
    }
  }

  // ── Device iteration (reconstruct from storage each request) ──────────

  private async loadDevices(): Promise<Map<string, DeviceRecord>> {
    const map = new Map<string, DeviceRecord>();
    const stored = await this.state.storage.list({ prefix: "device:" });
    stored.forEach((value, key) => {
      const id = key.slice("device:".length);
      map.set(id, value as DeviceRecord);
    });
    return map;
  }

  private isOnline(deviceId: string, record: DeviceRecord): boolean {
    const now = Date.now();
    if (now - record.lastSeen > DEVICE_STALE_MS) return false;
    return this.state.getWebSockets(deviceId).length > 0;
  }

  private getWsFor(deviceId: string): WebSocket | null {
    const sockets = this.state.getWebSockets(deviceId);
    return sockets.length > 0 ? sockets[0] : null;
  }

  // ── Routing ───────────────────────────────────────────────────────────

  private async pickRunner(requiredBridge: string | null, explicitDeviceId?: string): Promise<{ deviceId: string; ws: WebSocket } | null> {
    const devices = await this.loadDevices();
    if (explicitDeviceId) {
      const rec = devices.get(explicitDeviceId);
      if (!rec || rec.info.kind !== "runner") return null;
      if (!this.isOnline(explicitDeviceId, rec)) return null;
      const ws = this.getWsFor(explicitDeviceId);
      return ws ? { deviceId: explicitDeviceId, ws } : null;
    }
    const candidates: { deviceId: string; rec: DeviceRecord; ws: WebSocket }[] = [];
    for (const [id, rec] of devices) {
      if (rec.info.kind !== "runner") continue;
      if (!this.isOnline(id, rec)) continue;
      if (requiredBridge && !rec.info.bridges[requiredBridge]) continue;
      const ws = this.getWsFor(id);
      if (!ws) continue;
      candidates.push({ deviceId: id, rec, ws });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const aP = a.rec.info.preferences?.primary ? 1 : 0;
      const bP = b.rec.info.preferences?.primary ? 1 : 0;
      if (aP !== bP) return bP - aP;
      return a.rec.connectedAt - b.rec.connectedAt;
    });
    return { deviceId: candidates[0].deviceId, ws: candidates[0].ws };
  }

  private async handleRunRequest(body: any): Promise<any> {
    const req = body as RunRequest;
    if (!req.agentName || !req.message) return { error: "agentName and message required", status: 400 };

    const runner = await this.pickRunner(null, req.deviceId);
    if (!runner) return { error: "No runner online", status: 503 };

    const jobId = `c-${crypto.randomUUID().slice(0, 12)}`;
    const dispatch: DispatchMsg = {
      type: "dispatch",
      jobId,
      source: "manual",
      actionType: "run_agent",
      actionConfig: { agent_name: req.agentName, message: req.message },
      name: `Cloud: ${req.agentName}`,
    };
    this.send(runner.ws, dispatch);

    // Optimistically record
    const history = (await this.state.storage.get<CloudJob[]>("history")) ?? [];
    const now = new Date().toISOString();
    history.push({
      id: jobId, deviceId: runner.deviceId,
      name: dispatch.name, actionType: "run_agent",
      state: "pending", createdAt: now, updatedAt: now,
    });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await this.state.storage.put("history", history);

    return { jobId, deviceId: runner.deviceId };
  }

  // ── Views ────────────────────────────────────────────────────────────

  private async listDevices(): Promise<DeviceSummary[]> {
    const devices = await this.loadDevices();
    const out: DeviceSummary[] = [];
    for (const [id, rec] of devices) {
      out.push({
        deviceId: id,
        kind: rec.info.kind,
        platform: rec.info.platform,
        online: this.isOnline(id, rec),
        lastSeen: new Date(rec.lastSeen).toISOString(),
        bridges: Object.keys(rec.info.bridges),
        agentCount: rec.info.agents?.length ?? 0,
      });
    }
    return out;
  }

  private async aggregateAgents(): Promise<{ agent: string; tools: string[]; devices: string[] }[]> {
    const devices = await this.loadDevices();
    const byName = new Map<string, { agent: string; tools: string[]; devices: string[] }>();
    for (const [id, rec] of devices) {
      if (!this.isOnline(id, rec)) continue;
      if (!rec.info.agents) continue;
      for (const a of rec.info.agents) {
        const entry = byName.get(a.name) ?? { agent: a.name, tools: a.tools ?? [], devices: [] };
        if (!entry.devices.includes(id)) entry.devices.push(id);
        byName.set(a.name, entry);
      }
    }
    return Array.from(byName.values());
  }

  private async getHistory(): Promise<CloudJob[]> {
    const history = (await this.state.storage.get<CloudJob[]>("history")) ?? [];
    return history.slice(-100).reverse();
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: any): void {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  private json(data: any): Response {
    const status = typeof data === "object" && data && typeof data.status === "number" ? data.status : 200;
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
