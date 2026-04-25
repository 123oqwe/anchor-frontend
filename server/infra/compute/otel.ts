/**
 * OpenTelemetry GenAI semantic conventions — wrapper.
 *
 * Philosophy: keep SQLite (llm_calls, agent_executions) as the local truth;
 * re-emit the same events as OTel spans so any external observability
 * platform that speaks OTLP (Langfuse, Braintrust, Datadog, Honeycomb,
 * Grafana Tempo, Jaeger) works with zero platform-specific code.
 *
 * Activation: set OTEL_ENABLED=true in env. When disabled, all exported
 * helpers are no-ops so wrapping existing code costs nothing.
 *
 * OTEL_EXPORTER_OTLP_ENDPOINT: OTLP HTTP endpoint (default
 *   http://localhost:4318/v1/traces). Langfuse self-hosted accepts the
 *   OTLP protocol directly; cloud providers publish their own endpoints.
 *
 * Conventions: OpenTelemetry GenAI semantic conventions v1.40+.
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
import { trace, context, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";

const TRACER_NAME = "anchor.agent";
const SERVICE_NAME = "anchor-os";

let initialized = false;
let enabled = false;

/** Called by tests / external code to force wrappers into enabled mode
 *  (when an external trace provider has already been set up, e.g. the
 *  Langfuse SDK installs its own global provider). */
export function setOTelEnabled(v: boolean): void { enabled = v; initialized = true; }

export async function initOTel(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (process.env.OTEL_ENABLED !== "true") {
    console.log("[OTel] Disabled (set OTEL_ENABLED=true to enable)");
    return;
  }

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ?? "http://localhost:4318/v1/traces";

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": SERVICE_NAME,
        "service.version": process.env.npm_package_version ?? "0.0.0",
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
    });
    sdk.start();
    enabled = true;
    console.log(`[OTel] Enabled — exporting traces to ${endpoint}`);

    // Graceful shutdown so buffered spans flush on SIGTERM/SIGINT
    const shutdown = () => sdk.shutdown().catch(() => {}).then(() => process.exit(0));
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (err: any) {
    console.error("[OTel] init failed:", err?.message);
  }
}

/** Is OTel export active? Used for fast short-circuits. */
export function isOTelEnabled(): boolean { return enabled; }

function getTracer(): Tracer { return trace.getTracer(TRACER_NAME); }

// ── GenAI semconv attribute names ────────────────────────────────────────
// https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/

export const GenAIAttr = {
  SYSTEM: "gen_ai.system",                     // "anthropic" | "openai"
  OPERATION_NAME: "gen_ai.operation.name",     // "chat" | "text_completion" | "execute_tool"
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_READ_TOKENS: "gen_ai.usage.cache_read_input_tokens",
  USAGE_CACHE_CREATION_TOKENS: "gen_ai.usage.cache_creation_input_tokens",
  AGENT_ID: "gen_ai.agent.id",
  AGENT_NAME: "gen_ai.agent.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
} as const;

// ── Wrappers — generic startActiveSpan + outcome markers ────────────────

/** Wrap an async operation in an OTel span. No-op when OTel disabled. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, any>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn({} as any);  // no-op span object doesn't get recorded
  return getTracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ── Convenience wrappers shaped around Anchor's usage ───────────────────

export interface LLMCallAttrs {
  system: string;                     // "anthropic"
  model: string;
  maxTokens?: number;
  temperature?: number;
  runId?: string;
  agentName?: string;
}

export interface LLMCallResultAttrs {
  responseModel?: string;
  responseId?: string;
  finishReasons?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export async function withLLMSpan<T>(
  req: LLMCallAttrs,
  fn: (recordResult: (r: LLMCallResultAttrs) => void) => Promise<T>,
): Promise<T> {
  const initial: Record<string, any> = {
    [GenAIAttr.SYSTEM]: req.system,
    [GenAIAttr.OPERATION_NAME]: "chat",
    [GenAIAttr.REQUEST_MODEL]: req.model,
  };
  if (req.maxTokens !== undefined) initial[GenAIAttr.REQUEST_MAX_TOKENS] = req.maxTokens;
  if (req.temperature !== undefined) initial[GenAIAttr.REQUEST_TEMPERATURE] = req.temperature;
  if (req.runId) initial["anchor.run_id"] = req.runId;
  if (req.agentName) initial[GenAIAttr.AGENT_NAME] = req.agentName;

  return withSpan(`chat ${req.model}`, initial, async (span) => {
    const record = (r: LLMCallResultAttrs) => {
      if (!enabled) return;
      if (r.responseModel) span.setAttribute(GenAIAttr.RESPONSE_MODEL, r.responseModel);
      if (r.responseId) span.setAttribute(GenAIAttr.RESPONSE_ID, r.responseId);
      if (r.finishReasons) span.setAttribute(GenAIAttr.RESPONSE_FINISH_REASONS, r.finishReasons);
      if (r.inputTokens !== undefined) span.setAttribute(GenAIAttr.USAGE_INPUT_TOKENS, r.inputTokens);
      if (r.outputTokens !== undefined) span.setAttribute(GenAIAttr.USAGE_OUTPUT_TOKENS, r.outputTokens);
      if (r.cacheReadTokens !== undefined) span.setAttribute(GenAIAttr.USAGE_CACHE_READ_TOKENS, r.cacheReadTokens);
      if (r.cacheCreationTokens !== undefined) span.setAttribute(GenAIAttr.USAGE_CACHE_CREATION_TOKENS, r.cacheCreationTokens);
    };
    return fn(record);
  });
}

export async function withToolSpan<T>(
  toolName: string,
  attrs: { runId?: string; agentName?: string; toolCallId?: string; handler?: string; actionClass?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const initial: Record<string, any> = {
    [GenAIAttr.OPERATION_NAME]: "execute_tool",
    [GenAIAttr.TOOL_NAME]: toolName,
  };
  if (attrs.toolCallId) initial[GenAIAttr.TOOL_CALL_ID] = attrs.toolCallId;
  if (attrs.runId) initial["anchor.run_id"] = attrs.runId;
  if (attrs.agentName) initial[GenAIAttr.AGENT_NAME] = attrs.agentName;
  if (attrs.handler) initial["anchor.tool.handler"] = attrs.handler;
  if (attrs.actionClass) initial["anchor.tool.action_class"] = attrs.actionClass;
  return withSpan(`execute_tool ${toolName}`, initial, async () => fn());
}

export async function withAgentSpan<T>(
  attrs: { agentId: string; agentName: string; runId: string; missionId?: string; userMessage?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const initial: Record<string, any> = {
    [GenAIAttr.OPERATION_NAME]: "invoke_agent",
    [GenAIAttr.AGENT_ID]: attrs.agentId,
    [GenAIAttr.AGENT_NAME]: attrs.agentName,
    "anchor.run_id": attrs.runId,
  };
  if (attrs.missionId) initial["anchor.mission_id"] = attrs.missionId;
  if (attrs.userMessage) initial["anchor.user_message_preview"] = attrs.userMessage.slice(0, 200);
  return withSpan(`invoke_agent ${attrs.agentName}`, initial, async () => fn());
}

/** Export the context API so callers can inspect span hierarchy if needed. */
export { context, trace };
