/**
 * Execution layer — cloud-ready interfaces.
 *
 * These three abstractions decouple the runner (agent loop + tool exec) from:
 *   • JobSource     — where pending jobs come from (local DB poll, or WebSocket
 *                     push from a cloud control plane in Phase 2).
 *   • AgentRegistry — where agent definitions live (local SQLite, or cloud
 *                     sync in Phase 2 so user can edit agents from phone/web).
 *   • LlmRouter     — who calls the LLM (local with user's own API key, or
 *                     cloud proxy that holds the key so device never sees it).
 *
 * Phase 1: all three back-ends are local. Phase 2: swap to cloud impls without
 * touching the ReAct loop, execute_code, or delegate code paths.
 */

// ── Job dispatch ────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  agentId: string;
  input: string;
  scheduledAt: string;
  source: "manual" | "cron" | "trigger" | "channel";
}

export interface JobResult {
  jobId: string;
  agentId: string;
  runId: string;
  success: boolean;
  output: string;
  toolCalls?: { name: string; success: boolean; latencyMs: number }[];
  durationMs: number;
  error?: string;
}

export interface JobSource {
  /** Pull the next pending job, or null if queue is empty. */
  nextJob(): Promise<Job | null>;
  /** Report completion (success or failure) so the source can update state. */
  reportResult(result: JobResult): Promise<void>;
}

// ── Agent definition ────────────────────────────────────────────────────────

export interface AgentDef {
  id: string;
  userId: string;
  name: string;
  instructions: string;
  tools: string[];               // whitelisted tool names
  allowedBridges: string[];      // e.g. ["email.send","calendar.create_event"] or ["*"]
  allowedDirs: string[];         // extra dirs beyond agent workspace (abs or ~/...)
  networkPolicy: "none" | "bridge-only" | "open";
  executionBackend: "local";     // Phase 2 will add "cloud-dispatch"
  modelPreference?: string | null;
  triggerType: string;
  triggerConfig: Record<string, any>;
  enabled: boolean;
  createdAt: string;
}

export interface AgentRegistry {
  getAgent(id: string): Promise<AgentDef | null>;
  getAgentByName(userId: string, name: string): Promise<AgentDef | null>;
  listAgents(userId: string): Promise<AgentDef[]>;
}

// ── LLM router ──────────────────────────────────────────────────────────────

export interface LlmCallOpts {
  task: string;
  system: string;
  messages: any[];          // Anthropic.Messages.MessageParam[]
  tools?: any[];            // Anthropic tool defs
  maxTokens?: number;
  runId?: string;
  agentName?: string;
}

export interface LlmCallResult {
  content: any[];           // Anthropic content blocks
  stopReason: string;
  usage: { inputTokens?: number; outputTokens?: number };
  modelId: string;
  providerId: string;
}

export interface LlmRouter {
  call(opts: LlmCallOpts): Promise<LlmCallResult>;
}
