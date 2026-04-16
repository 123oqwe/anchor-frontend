/**
 * Cortex Router — capability + tier → best available model, with fallback.
 */

import { type Capability, type Model, MODELS, hasProviderKey } from "./providers.js";

export type ModelTier = "frontier" | "strong" | "balanced" | "fast" | "cheap";

// ── Tier priority order (descending quality) ────────────────────────────────

const TIER_ORDER: ModelTier[] = ["frontier", "strong", "balanced", "fast", "cheap"];

// ── Select best available model for a capability + preferred tier ────────────

export function selectModel(capability: Capability, preferredTier: ModelTier): Model {
  // Get all models with this capability that have an active API key
  const available = MODELS.filter(
    m => m.capabilities.includes(capability) && hasProviderKey(m.provider)
  );

  if (available.length === 0) {
    throw new Error(`No available model for capability "${capability}". Configure an API key for a provider that supports it.`);
  }

  // Try preferred tier first
  const exact = available.find(m => m.tier === preferredTier);
  if (exact) return exact;

  // Fallback: search adjacent tiers (prefer higher quality, then lower)
  const prefIdx = TIER_ORDER.indexOf(preferredTier);
  for (let dist = 1; dist < TIER_ORDER.length; dist++) {
    // Try higher quality first
    if (prefIdx - dist >= 0) {
      const higher = available.find(m => m.tier === TIER_ORDER[prefIdx - dist]);
      if (higher) return higher;
    }
    // Then lower quality
    if (prefIdx + dist < TIER_ORDER.length) {
      const lower = available.find(m => m.tier === TIER_ORDER[prefIdx + dist]);
      if (lower) return lower;
    }
  }

  // Should never reach here, but just in case
  return available[0];
}

// ── Get all candidates for a capability + tier (for fallback chain) ─────────

export function getCandidates(capability: Capability, preferredTier: ModelTier): Model[] {
  const available = MODELS.filter(
    m => m.capabilities.includes(capability) && hasProviderKey(m.provider)
  );

  // Sort: exact tier first, then by tier proximity
  const prefIdx = TIER_ORDER.indexOf(preferredTier);
  return available.sort((a, b) => {
    const distA = Math.abs(TIER_ORDER.indexOf(a.tier) - prefIdx);
    const distB = Math.abs(TIER_ORDER.indexOf(b.tier) - prefIdx);
    return distA - distB;
  });
}

// ── Task routing table ──────────────────────────────────────────────────────

export interface TaskRoute {
  capability: Capability;
  tier: ModelTier;
}

export const TASK_ROUTES: Record<string, TaskRoute> = {
  // Agent tasks
  decision:              { capability: "text",       tier: "strong" },
  general_chat:          { capability: "text",       tier: "balanced" },
  react_execution:       { capability: "text",       tier: "strong" },
  twin_edit_learning:    { capability: "text",       tier: "cheap" },
  twin_result_learning:  { capability: "text",       tier: "cheap" },
  morning_digest:        { capability: "text",       tier: "cheap" },
  weekly_reflection:     { capability: "text",       tier: "cheap" },
  deep_reasoning:        { capability: "reasoning",  tier: "frontier" },

  // Media tasks
  image_generation:      { capability: "image_gen",  tier: "strong" },
  video_generation:      { capability: "video_gen",  tier: "strong" },
  speech_to_text:        { capability: "stt",        tier: "strong" },
  text_to_speech:        { capability: "tts",        tier: "strong" },
  music_generation:      { capability: "music",      tier: "strong" },
  sound_effects:         { capability: "sound_fx",   tier: "strong" },
  voice_cloning:         { capability: "voice_clone", tier: "strong" },
  avatar_generation:     { capability: "avatar",     tier: "strong" },
  three_d_generation:    { capability: "3d_gen",     tier: "strong" },

  // Utility tasks
  embed:                 { capability: "embeddings", tier: "strong" },
  vision_analysis:       { capability: "vision",     tier: "strong" },
};

export function routeTask(task: string): { model: Model; capability: Capability; tier: ModelTier } {
  const route = TASK_ROUTES[task];
  if (!route) throw new Error(`Unknown task: "${task}". Register it in TASK_ROUTES.`);

  const model = selectModel(route.capability, route.tier);
  return { model, capability: route.capability, tier: route.tier };
}
