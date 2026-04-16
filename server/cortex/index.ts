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

import { generateText, stepCountIs, type ModelMessage, type ToolSet, type GenerateTextResult } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getCandidates, routeTask, TASK_ROUTES } from "./router.js";
import { PROVIDERS, type Model, type Capability } from "./providers.js";
import { getApiKey, getAllKeyStatuses, getModelsForCapability, getActiveProviders, getAllProviderSlots } from "./keys.js";

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

async function withFallback<T>(task: string, fn: (model: Model) => Promise<T>): Promise<T> {
  const route = TASK_ROUTES[task];
  if (!route) throw new Error(`Unknown task: ${task}`);

  const candidates = getCandidates(route.capability, route.tier);
  if (candidates.length === 0) {
    throw new Error(`No model available for task "${task}" (capability: ${route.capability}). Add an API key.`);
  }

  for (let i = 0; i < candidates.length; i++) {
    try {
      console.log(`[Cortex] ${task} → ${candidates[i].name} (${candidates[i].provider})`);
      return await fn(candidates[i]);
    } catch (err: any) {
      console.error(`[Cortex] ${candidates[i].name} failed:`, err.message?.slice(0, 100));
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
}): Promise<string> {
  return withFallback(opts.task, async (model) => {
    const instance = createModelInstance(model);
    const result = await generateText({
      model: instance,
      system: opts.system,
      messages: opts.messages as ModelMessage[],
      maxOutputTokens: opts.maxTokens ?? 1024,
    });
    return result.text;
  });
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
  return withFallback(opts.task, async (model) => {
    const instance = createModelInstance(model);
    return generateText({
      model: instance,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps ?? 10),
      maxOutputTokens: opts.maxTokens ?? 1024,
    });
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
  return withFallback(task, async (model) => {
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
    return result.text;
  });
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
