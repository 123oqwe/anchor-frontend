/**
 * Wire protocol shared between Anchor Cloud Relay (Cloudflare DO) and
 * Anchor runners (Mac / Linux / future Windows). Also the shape the mobile
 * web UI consumes via HTTP.
 *
 * Design: DEVICE-AGNOSTIC. Runners declare their capabilities on hello and
 * the cloud routes tasks to whichever device can actually perform them.
 * Phones/iPads connect as viewers (no capabilities, read + trigger only).
 */

export type DeviceKind = "runner" | "viewer";

/** First message a device sends after WS connect. */
export interface HelloMsg {
  type: "hello";
  deviceId: string;              // stable per-device, user-chosen or auto (e.g. "mac-desktop-home")
  kind: DeviceKind;
  platform: "darwin" | "linux" | "win32" | "browser";
  version: string;
  /** Bridge capabilities this device can fulfill. Empty for viewers. */
  bridges: Record<string, string[]>;   // capabilityName -> providerIds
  /** Agents defined on this runner (so cloud can surface them to viewers). */
  agents?: { id: string; name: string; tools: string[] }[];
  /** User-set preferences (e.g. {primary: true} to prefer this device for routing). */
  preferences?: Record<string, any>;
}

/** Periodic liveness ping (every 30s). */
export interface HeartbeatMsg {
  type: "heartbeat";
  ts: number;
}

/** Cloud → runner: "execute this job now". */
export interface DispatchMsg {
  type: "dispatch";
  jobId: string;                 // cloud-generated
  source: "cron" | "manual" | "webhook";
  actionType: string;            // same as agent_jobs.action_type
  actionConfig: any;
  name: string;
  /** Idempotency key to dedup if local cron also fired the same job. */
  dedupKey?: string;
}

/** Runner → cloud: job state update during and after execution. */
export interface JobUpdateMsg {
  type: "job_update";
  jobId: string;
  deviceId: string;
  state: "claimed" | "running" | "succeeded" | "failed" | "retrying";
  attempts?: number;
  result?: string;               // summary on success
  error?: string;                // on failure
  durationMs?: number;
}

/** Runner → cloud: agent list updated (user added/edited an agent). */
export interface SyncAgentsMsg {
  type: "sync_agents";
  deviceId: string;
  agents: { id: string; name: string; tools: string[]; trigger_type?: string }[];
}

/** Cloud → device: error or acknowledgement. */
export interface ServerMsg {
  type: "error" | "ack" | "pong";
  message?: string;
  context?: any;
}

export type ClientMsg = HelloMsg | HeartbeatMsg | JobUpdateMsg | SyncAgentsMsg;
export type ServerOutbound = DispatchMsg | ServerMsg;

// ── HTTP API shapes ────────────────────────────────────────────────────────

export interface DeviceSummary {
  deviceId: string;
  kind: DeviceKind;
  platform: string;
  online: boolean;
  lastSeen: string;
  bridges: string[];             // flattened capability names
  agentCount: number;
}

export interface CloudJob {
  id: string;
  deviceId?: string;
  name: string;
  actionType: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

export interface RunRequest {
  agentName: string;
  message: string;
  deviceId?: string;             // optional: force a specific runner
}
