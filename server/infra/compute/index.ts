/**
 * Cortex — Unified AI generation layer.
 *
 * 4 public functions:
 *   text()   — text generation (covers LLM, reasoning, translation, etc.)
 *   vision() — image understanding (send image + prompt, get text back)
 *   media()  — media generation (image, video, audio, music, 3D, avatar)
 *   embed()  — vector embeddings
 *
 * All functions auto-route to the best available model via the router.
 * Fallback: if first-choice model fails, tries the next candidate.
 */

import { generateText, streamText as aiStreamText, stepCountIs, type ModelMessage, type ToolSet, type GenerateTextResult } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getCandidates, routeTask, TASK_ROUTES } from "./router.js";
import { PROVIDERS, MODELS, type Model, type Capability } from "./providers.js";
import { getApiKey, getAllKeyStatuses, getModelsForCapability, getActiveProviders, getAllProviderSlots } from "./keys.js";
import { logCall, acquireRateLimit, getRouteOverride } from "./telemetry.js";

// ── Provider factory ────────────────────────────────────────────────────────

function createModelInstance(model: Model) {
  const provider = PROVIDERS.find(p => p.id === model.provider);
  if (!provider) throw new Error(`Provider not found: ${model.provider}`);

  const key = getApiKey(provider.id);
  if (!key) throw new Error(`API key not set for ${provider.name}`);

  switch (provider.protocol) {
    case "anthropic":
      return createAnthropic({ apiKey: key })(model.id);
    case "google":
      return createGoogleGenerativeAI({ apiKey: key })(model.id);
    case "openai-compat":
      return createOpenAI({
        apiKey: key,
        ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      })(model.id);
    default:
      throw new Error(`Unknown protocol: ${provider.protocol}`);
  }
}

// ── Fallback execution ──────────────────────────────────────────────────────

interface FnResult<T> {
  value: T;
  usage?: { inputTokens?: number; outputTokens?: number };
  responsePreview?: string;
}

async function withFallback<T>(
  task: string,
  fn: (model: Model) => Promise<FnResult<T>>,
  telemetryMeta?: { inputPreview?: string; runId?: string; agentName?: string }
): Promise<T> {
  const route = TASK_ROUTES[task];
  if (!route) throw new Error(`Unknown task: ${task}`);

  let candidates: Model[];
  const overrideId = getRouteOverride(task);
  if (overrideId) {
    const override = MODELS.find(m => m.id === overrideId);
    if (override) {
      candidates = [override, ...getCandidates(route.capability, route.tier).filter(m => m.id !== overrideId)];
      console.log(`[Cortex] ${task} manual override → ${override.name}`);
    } else {
      candidates = getCandidates(route.capability, route.tier);
    }
  } else {
    candidates = getCandidates(route.capability, route.tier);
  }

  if (candidates.length === 0) {
    throw new Error(`No model available for task "${task}" (capability: ${route.capability}). Add an API key.`);
  }

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const start = Date.now();
    try {
      await acquireRateLimit(model.provider);
      console.log(`[Cortex] ${task} → ${model.name} (${model.provider})`);
      const res = await fn(model);

      logCall({
        task,
        capability: route.capability,
        modelId: model.id,
        providerId: model.provider,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
        latencyMs: Date.now() - start,
        status: i > 0 ? "fallback" : "success",
        requestPreview: telemetryMeta?.inputPreview?.slice(0, 500),
        responsePreview: res.responsePreview?.slice(0, 500),
        runId: telemetryMeta?.runId,
        agentName: telemetryMeta?.agentName,
      });
      return res.value;
    } catch (err: any) {
      const msg = err.message?.slice(0, 200) ?? "Unknown error";
      console.error(`[Cortex] ${model.name} failed:`, msg);
      logCall({
        task,
        capability: route.capability,
        modelId: model.id,
        providerId: model.provider,
        latencyMs: Date.now() - start,
        status: "failed",
        error: msg,
        requestPreview: telemetryMeta?.inputPreview?.slice(0, 500),
        runId: telemetryMeta?.runId,
        agentName: telemetryMeta?.agentName,
      });
      if (i === candidates.length - 1) throw err;
    }
  }
  throw new Error("Unreachable");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Text generation — covers text LLM, reasoning, structured output.
 */
export async function text(opts: {
  task: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  runId?: string;       // OPT-4: trace correlation
  agentName?: string;   // OPT-4: which agent called this LLM
}): Promise<string> {
  const lastMsg = opts.messages[opts.messages.length - 1]?.content ?? "";
  return withFallback<string>(opts.task, async (model) => {
    const instance = createModelInstance(model);
    const result = await generateText({
      model: instance,
      system: opts.system,
      messages: opts.messages as ModelMessage[],
      maxOutputTokens: opts.maxTokens ?? 1024,
    });
    return {
      value: result.text,
      usage: {
        inputTokens: (result.usage as any)?.inputTokens ?? (result.usage as any)?.promptTokens,
        outputTokens: (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens,
      },
      responsePreview: result.text,
    };
  }, { inputPreview: lastMsg, runId: opts.runId, agentName: opts.agentName });
}

/**
 * Streaming text generation — returns an async iterable of text chunks.
 * Used by Advisor for real-time SSE responses.
 */
export async function textStream(opts: {
  task: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}): Promise<{ stream: AsyncIterable<string>; fullText: Promise<string> }> {
  const route = TASK_ROUTES[opts.task];
  if (!route) throw new Error(`Unknown task: ${opts.task}`);

  const candidates = getCandidates(route.capability, route.tier);
  if (candidates.length === 0) throw new Error(`No model available for task "${opts.task}"`);

  const model = candidates[0];
  const instance = createModelInstance(model);
  console.log(`[Cortex] ${opts.task} (stream) → ${model.name} (${model.provider})`);

  const result = aiStreamText({
    model: instance,
    system: opts.system,
    messages: opts.messages as ModelMessage[],
    maxOutputTokens: opts.maxTokens ?? 2500,
  });

  // Tee the stream: one side for caller to iterate, other side accumulates full text
  let fullTextResolve: (text: string) => void;
  const fullTextPromise = new Promise<string>((resolve) => { fullTextResolve = resolve; });
  let accumulated = "";

  const wrappedStream = (async function* () {
    for await (const chunk of result.textStream) {
      accumulated += chunk;
      yield chunk;
    }
    fullTextResolve!(accumulated);
  })();

  return {
    stream: wrappedStream,
    fullText: fullTextPromise,
  };
}

/**
 * Text generation with tool use — for ReAct loops.
 */
export async function textWithTools<T extends ToolSet>(opts: {
  task: string;
  system: string;
  messages: ModelMessage[];
  tools: T;
  maxSteps?: number;
  maxTokens?: number;
}): Promise<GenerateTextResult<T, never>> {
  return withFallback<GenerateTextResult<T, never>>(opts.task, async (model) => {
    const instance = createModelInstance(model);
    const result = await generateText({
      model: instance,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps ?? 10),
      maxOutputTokens: opts.maxTokens ?? 1024,
    });
    return {
      value: result as GenerateTextResult<T, never>,
      usage: {
        inputTokens: (result.usage as any)?.inputTokens ?? (result.usage as any)?.promptTokens,
        outputTokens: (result.usage as any)?.outputTokens ?? (result.usage as any)?.completionTokens,
      },
      responsePreview: result.text ?? "(tool-use response)",
    };
  });
}

/**
 * Vision — send image + prompt, get text analysis back.
 * Image is passed as base64 data URL or URL in the message content.
 */
export async function vision(opts: {
  task?: string;
  system: string;
  imageUrl: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const task = opts.task ?? "vision_analysis";
  return withFallback<string>(task, async (model) => {
    const instance = createModelInstance(model);
    const result = await generateText({
      model: instance,
      system: opts.system,
      messages: [{
        role: "user",
        content: [
          { type: "image", image: opts.imageUrl },
          { type: "text", text: opts.prompt },
        ],
      }] as any,
      maxOutputTokens: opts.maxTokens ?? 1024,
    });
    return {
      value: result.text,
      usage: {
        inputTokens: (result.usage as any)?.inputTokens,
        outputTokens: (result.usage as any)?.outputTokens,
      },
      responsePreview: result.text,
    };
  }, { inputPreview: opts.prompt });
}

/**
 * Embeddings — convert text to vector.
 */
export async function embed(opts: {
  text: string | string[];
  task?: string;
}): Promise<number[][]> {
  const task = opts.task ?? "embed";
  const route = TASK_ROUTES[task];
  if (!route) throw new Error(`Unknown task: ${task}`);

  const candidates = getCandidates(route.capability, route.tier);
  if (candidates.length === 0) throw new Error("No embedding model available. Add an API key.");

  const model = candidates[0];
  const provider = PROVIDERS.find(p => p.id === model.provider)!;
  const key = process.env[provider.envKey]!;

  // Use Vercel AI SDK embed
  const { embed: aiEmbed, embedMany } = await import("ai");
  const instance = createModelInstance(model);
  const texts = Array.isArray(opts.text) ? opts.text : [opts.text];

  if (texts.length === 1) {
    const result = await aiEmbed({ model: instance as any, value: texts[0] });
    return [result.embedding];
  } else {
    const result = await embedMany({ model: instance as any, values: texts });
    return result.embeddings;
  }
}

// ── Status / Introspection ──────────────────────────────────────────────────

/** Get ALL models for a capability, active + inactive, with their provider status */
export function getCapabilityRoster(capability: Capability) {
  const keyStatuses = getAllKeyStatuses();
  const models = MODELS
    .filter(m => m.capabilities.includes(capability))
    .map(m => {
      const provider = PROVIDERS.find(p => p.id === m.provider)!;
      const status = keyStatuses[m.provider];
      return {
        modelId: m.id,
        modelName: m.name,
        tier: m.tier,
        providerId: m.provider,
        providerName: provider.name,
        envKey: provider.envKey,
        active: status.source !== "none",
        keySource: status.source,
      };
    });

  // Unique providers for this capability
  const providerIds = Array.from(new Set(models.map(m => m.providerId)));
  const providers = providerIds.map(pid => {
    const p = PROVIDERS.find(x => x.id === pid)!;
    const status = keyStatuses[pid];
    return {
      id: pid,
      name: p.name,
      envKey: p.envKey,
      active: status.source !== "none",
      keySource: status.source,
      keyMasked: status.masked,
      modelCount: models.filter(m => m.providerId === pid).length,
    };
  });

  return { capability, models, providers };
}

export function getStatus() {
  const keyStatuses = getAllKeyStatuses();
  return {
    activeProviders: getActiveProviders().map(p => ({ id: p.id, name: p.name })),
    providerSlots: getAllProviderSlots().map(slot => ({
      ...slot,
      keySource: keyStatuses[slot.id]?.source ?? "none",
      keyMasked: keyStatuses[slot.id]?.masked,
      keyUpdatedAt: keyStatuses[slot.id]?.updatedAt,
    })),
    capabilities: (Object.keys(TASK_ROUTES) as string[]).map(task => {
      const route = TASK_ROUTES[task];
      const available = getModelsForCapability(route.capability);
      return {
        task,
        capability: route.capability,
        preferredTier: route.tier,
        availableModels: available.map(m => ({ id: m.id, name: m.name, provider: m.provider, tier: m.tier })),
        active: available.length > 0,
      };
    }),
  };
}

// Re-export for convenience
export { PROVIDERS, MODELS, type Capability, type Model } from "./providers.js";
export { TASK_ROUTES, routeTask } from "./router.js";
