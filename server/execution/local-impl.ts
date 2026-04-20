/**
 * Phase 1 local implementations of the three cloud-ready interfaces.
 *
 * When Phase 2 lands, add cloud-impl.ts next to this file with WebSocket-based
 * JobSource, syncing AgentRegistry, and proxied LlmRouter — nothing upstream
 * needs to change.
 */
import Anthropic from "@anthropic-ai/sdk";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { routeTask } from "../infra/compute/router.js";
import { getApiKey } from "../infra/compute/keys.js";
import { logCall } from "../infra/compute/telemetry.js";
import type {
  Job, JobResult, JobSource, AgentDef, AgentRegistry,
  LlmRouter, LlmCallOpts, LlmCallResult,
} from "./interfaces.js";

// ── Local AgentRegistry (reads user_agents SQLite table) ────────────────────

function rowToAgent(row: any): AgentDef {
  const parse = <T>(s: string | null | undefined, fallback: T): T => {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    instructions: row.instructions,
    tools: parse<string[]>(row.tools, []),
    allowedBridges: parse<string[]>(row.allowed_bridges, ["*"]),
    allowedDirs: parse<string[]>(row.allowed_dirs, []),
    networkPolicy: (row.network_policy ?? "bridge-only") as AgentDef["networkPolicy"],
    executionBackend: (row.execution_backend ?? "local") as AgentDef["executionBackend"],
    modelPreference: row.model_preference ?? null,
    triggerType: row.trigger_type ?? "manual",
    triggerConfig: parse<Record<string, any>>(row.trigger_config, {}),
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  };
}

export class LocalAgentRegistry implements AgentRegistry {
  async getAgent(id: string): Promise<AgentDef | null> {
    const row = db.prepare("SELECT * FROM user_agents WHERE id=?").get(id) as any;
    return row ? rowToAgent(row) : null;
  }
  async getAgentByName(userId: string, name: string): Promise<AgentDef | null> {
    const row = db.prepare("SELECT * FROM user_agents WHERE user_id=? AND name=?").get(userId, name) as any;
    return row ? rowToAgent(row) : null;
  }
  async listAgents(userId: string): Promise<AgentDef[]> {
    const rows = db.prepare("SELECT * FROM user_agents WHERE user_id=? ORDER BY created_at DESC").all(userId) as any[];
    return rows.map(rowToAgent);
  }
}

// ── Local JobSource (polls user_crons + API-triggered manual runs) ──────────
// Phase 1 stub — actual cron firing is still handled by user-cron-runtime.ts.
// This class exists so Phase 2 can replace it with a WebSocket-driven one.

export class LocalJobSource implements JobSource {
  async nextJob(): Promise<Job | null> {
    // Phase 1: jobs arrive via HTTP routes (/run) or cron runtime, not pulled here.
    return null;
  }
  async reportResult(result: JobResult): Promise<void> {
    db.prepare(
      "INSERT INTO agent_executions (id, user_id, agent, action, status, run_id) VALUES (?,?,?,?,?,?)"
    ).run(
      result.jobId, DEFAULT_USER_ID,
      `Custom: ${result.agentId}`,
      result.success ? result.output.slice(0, 100) : `FAILED: ${result.error?.slice(0, 80)}`,
      result.success ? "success" : "failed",
      result.runId,
    );
  }
}

// ── Local LlmRouter (uses user's own API keys via existing router) ──────────

export class LocalLlmRouter implements LlmRouter {
  async call(opts: LlmCallOpts): Promise<LlmCallResult> {
    const { model, capability } = routeTask(opts.task as any);
    const apiKey = getApiKey(model.provider);
    if (!apiKey) throw new Error(`No API key for ${model.provider}`);
    const anthropic = new Anthropic({ apiKey });

    const start = Date.now();
    try {
      const res = await anthropic.messages.create({
        model: model.id,
        max_tokens: opts.maxTokens ?? 1500,
        system: opts.system,
        ...(opts.tools ? { tools: opts.tools as any } : {}),
        messages: opts.messages,
      });

      logCall({
        task: opts.task as any, capability, modelId: model.id, providerId: model.provider,
        inputTokens: (res.usage as any)?.input_tokens,
        outputTokens: (res.usage as any)?.output_tokens,
        latencyMs: Date.now() - start, status: "success",
        runId: opts.runId, agentName: opts.agentName,
      });

      return {
        content: res.content as any[],
        stopReason: res.stop_reason ?? "end_turn",
        usage: {
          inputTokens: (res.usage as any)?.input_tokens,
          outputTokens: (res.usage as any)?.output_tokens,
        },
        modelId: model.id,
        providerId: model.provider,
      };
    } catch (err: any) {
      logCall({
        task: opts.task as any, capability, modelId: model.id, providerId: model.provider,
        latencyMs: Date.now() - start, status: "failed", error: err.message?.slice(0, 200),
        runId: opts.runId, agentName: opts.agentName,
      });
      throw err;
    }
  }
}

// ── Default singletons ──────────────────────────────────────────────────────

export const localAgentRegistry: AgentRegistry = new LocalAgentRegistry();
export const localJobSource: JobSource = new LocalJobSource();
export const localLlmRouter: LlmRouter = new LocalLlmRouter();
