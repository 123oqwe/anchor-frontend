/**
 * Cortex — Complete provider & model registry.
 * Every provider has an env key slot. Fill the key → model auto-activates.
 */

// ── Provider Registry ───────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  envKey: string;
  protocol: "anthropic" | "openai-compat" | "google";
  baseURL?: string;
}

export const PROVIDERS: Provider[] = [
  // ── Tier 1: Major Cloud ──────────────────────────────────────────────────
  { id: "anthropic",   name: "Anthropic",       envKey: "ANTHROPIC_API_KEY",   protocol: "anthropic" },
  { id: "openai",      name: "OpenAI",          envKey: "OPENAI_API_KEY",      protocol: "openai-compat" },
  { id: "google",      name: "Google",          envKey: "GOOGLE_API_KEY",      protocol: "google" },

  // ── Tier 2: Chinese Frontier ─────────────────────────────────────────────
  { id: "deepseek",    name: "DeepSeek",        envKey: "DEEPSEEK_API_KEY",    protocol: "openai-compat", baseURL: "https://api.deepseek.com/v1" },
  { id: "qwen",        name: "Qwen (Alibaba)",  envKey: "QWEN_API_KEY",        protocol: "openai-compat", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { id: "zhipu",       name: "Zhipu (GLM)",     envKey: "ZHIPU_API_KEY",       protocol: "openai-compat", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "minimax",     name: "MiniMax",         envKey: "MINIMAX_API_KEY",     protocol: "openai-compat", baseURL: "https://api.minimax.chat/v1" },
  { id: "moonshot",    name: "Moonshot (Kimi)", envKey: "MOONSHOT_API_KEY",    protocol: "openai-compat", baseURL: "https://api.moonshot.ai/v1" },
  { id: "baidu",       name: "Baidu (ERNIE)",   envKey: "BAIDU_API_KEY",       protocol: "openai-compat", baseURL: "https://qianfan.baidubce.com/v2" },
  { id: "doubao",      name: "ByteDance (Doubao)", envKey: "DOUBAO_API_KEY",   protocol: "openai-compat", baseURL: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "stepfun",     name: "StepFun",         envKey: "STEPFUN_API_KEY",     protocol: "openai-compat", baseURL: "https://api.stepfun.com/v1" },
  { id: "yi",          name: "01.AI (Yi)",      envKey: "YI_API_KEY",          protocol: "openai-compat", baseURL: "https://api.lingyiwanwu.com/v1" },

  // ── Tier 3: Western Alternatives ─────────────────────────────────────────
  { id: "mistral",     name: "Mistral",         envKey: "MISTRAL_API_KEY",     protocol: "openai-compat", baseURL: "https://api.mistral.ai/v1" },
  { id: "xai",         name: "xAI (Grok)",      envKey: "XAI_API_KEY",         protocol: "openai-compat", baseURL: "https://api.x.ai/v1" },
  { id: "cohere",      name: "Cohere",          envKey: "COHERE_API_KEY",      protocol: "openai-compat", baseURL: "https://api.cohere.com/compatibility/v1" },
  { id: "ai21",        name: "AI21 (Jamba)",    envKey: "AI21_API_KEY",        protocol: "openai-compat", baseURL: "https://api.ai21.com/studio/v1" },
  { id: "reka",        name: "Reka",            envKey: "REKA_API_KEY",        protocol: "openai-compat", baseURL: "https://api.reka.ai/v1" },
  { id: "inflection",  name: "Inflection (Pi)", envKey: "INFLECTION_API_KEY",  protocol: "openai-compat", baseURL: "https://api.inflection.ai/v1" },

  // ── Tier 4: Inference Platforms (host open models fast & cheap) ───────────
  { id: "groq",        name: "Groq",            envKey: "GROQ_API_KEY",        protocol: "openai-compat", baseURL: "https://api.groq.com/openai/v1" },
  { id: "together",    name: "Together AI",     envKey: "TOGETHER_API_KEY",    protocol: "openai-compat", baseURL: "https://api.together.xyz/v1" },
  { id: "fireworks",   name: "Fireworks AI",    envKey: "FIREWORKS_API_KEY",   protocol: "openai-compat", baseURL: "https://api.fireworks.ai/inference/v1" },
  { id: "openrouter",  name: "OpenRouter",      envKey: "OPENROUTER_API_KEY",  protocol: "openai-compat", baseURL: "https://openrouter.ai/api/v1" },
  { id: "nvidia",      name: "NVIDIA NIM",      envKey: "NVIDIA_API_KEY",      protocol: "openai-compat", baseURL: "https://integrate.api.nvidia.com/v1" },

  // ── Tier 5: Media Generation ─────────────────────────────────────────────
  { id: "stability",   name: "Stability AI",    envKey: "STABILITY_API_KEY",   protocol: "openai-compat", baseURL: "https://api.stability.ai/v2beta" },
  { id: "replicate",   name: "Replicate",       envKey: "REPLICATE_API_KEY",   protocol: "openai-compat", baseURL: "https://api.replicate.com/v1" },
  { id: "fal",         name: "fal.ai",          envKey: "FAL_API_KEY",         protocol: "openai-compat", baseURL: "https://fal.run" },
  { id: "elevenlabs",  name: "ElevenLabs",      envKey: "ELEVENLABS_API_KEY",  protocol: "openai-compat", baseURL: "https://api.elevenlabs.io/v1" },
  { id: "runway",      name: "Runway",          envKey: "RUNWAY_API_KEY",      protocol: "openai-compat", baseURL: "https://api.dev.runwayml.com/v1" },
  { id: "luma",        name: "Luma AI",         envKey: "LUMA_API_KEY",        protocol: "openai-compat", baseURL: "https://api.lumalabs.ai/dream-machine/v1" },
  { id: "heygen",      name: "HeyGen",          envKey: "HEYGEN_API_KEY",      protocol: "openai-compat", baseURL: "https://api.heygen.com/v2" },
  { id: "suno",        name: "Suno",            envKey: "SUNO_API_KEY",        protocol: "openai-compat", baseURL: "https://studio-api.suno.ai/api" },
  { id: "ideogram",    name: "Ideogram",        envKey: "IDEOGRAM_API_KEY",    protocol: "openai-compat", baseURL: "https://api.ideogram.ai" },
  { id: "recraft",     name: "Recraft",         envKey: "RECRAFT_API_KEY",     protocol: "openai-compat", baseURL: "https://external.api.recraft.ai/v1" },
  { id: "flux",        name: "Black Forest Labs", envKey: "BFL_API_KEY",       protocol: "openai-compat", baseURL: "https://api.bfl.ml/v1" },
  { id: "meshy",       name: "Meshy (3D)",      envKey: "MESHY_API_KEY",       protocol: "openai-compat", baseURL: "https://api.meshy.ai/v2" },

  // ── Tier 6: Utility APIs ─────────────────────────────────────────────────
  { id: "deepgram",    name: "Deepgram (STT)",  envKey: "DEEPGRAM_API_KEY",    protocol: "openai-compat", baseURL: "https://api.deepgram.com/v1" },
  { id: "assemblyai",  name: "AssemblyAI (STT)", envKey: "ASSEMBLYAI_API_KEY", protocol: "openai-compat", baseURL: "https://api.assemblyai.com/v2" },
  { id: "cartesia",    name: "Cartesia (TTS)",  envKey: "CARTESIA_API_KEY",    protocol: "openai-compat", baseURL: "https://api.cartesia.ai" },
  { id: "perplexity",  name: "Perplexity",      envKey: "PERPLEXITY_API_KEY",  protocol: "openai-compat", baseURL: "https://api.perplexity.ai" },
  { id: "voyage",      name: "Voyage AI",       envKey: "VOYAGE_API_KEY",      protocol: "openai-compat", baseURL: "https://api.voyageai.com/v1" },
  { id: "jina",        name: "Jina AI",         envKey: "JINA_API_KEY",        protocol: "openai-compat", baseURL: "https://api.jina.ai/v1" },
];

// ── Capability Types ────────────────────────────────────────────────────────

export type Capability = "text" | "reasoning" | "vision" | "image_gen" | "video_gen" |
  "stt" | "tts" | "music" | "sound_fx" | "voice_clone" | "embeddings" |
  "avatar" | "3d_gen";

// ── Model Registry ──────────────────────────────────────────────────────────

export interface Model {
  id: string;
  provider: string;
  name: string;
  capabilities: Capability[];
  tier: "frontier" | "strong" | "balanced" | "fast" | "cheap";
}

export const MODELS: Model[] = [
  // ── Anthropic ────────────────────────────────────────────────────────────
  { id: "claude-opus-4-6",             provider: "anthropic", name: "Claude Opus 4.6",          capabilities: ["text", "reasoning", "vision"], tier: "frontier" },
  { id: "claude-sonnet-4-6",           provider: "anthropic", name: "Claude Sonnet 4.6",        capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "claude-haiku-4-5-20251001",   provider: "anthropic", name: "Claude Haiku 4.5",         capabilities: ["text", "vision"],              tier: "fast" },

  // ── OpenAI ───────────────────────────────────────────────────────────────
  { id: "gpt-4o",                      provider: "openai",   name: "GPT-4o",                    capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "gpt-4o-mini",                 provider: "openai",   name: "GPT-4o Mini",               capabilities: ["text", "vision"],              tier: "fast" },
  { id: "gpt-4.1",                     provider: "openai",   name: "GPT-4.1",                   capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "gpt-4.1-mini",               provider: "openai",   name: "GPT-4.1 Mini",              capabilities: ["text", "vision"],              tier: "fast" },
  { id: "gpt-4.1-nano",               provider: "openai",   name: "GPT-4.1 Nano",              capabilities: ["text"],                        tier: "cheap" },
  { id: "o4-mini",                     provider: "openai",   name: "o4-mini",                   capabilities: ["text", "reasoning"],           tier: "strong" },
  { id: "o3",                          provider: "openai",   name: "o3",                        capabilities: ["text", "reasoning"],           tier: "frontier" },
  { id: "o3-mini",                     provider: "openai",   name: "o3-mini",                   capabilities: ["text", "reasoning"],           tier: "balanced" },
  { id: "dall-e-3",                    provider: "openai",   name: "DALL-E 3",                  capabilities: ["image_gen"],                   tier: "strong" },
  { id: "gpt-image-1",                provider: "openai",   name: "GPT Image 1",               capabilities: ["image_gen"],                   tier: "frontier" },
  { id: "tts-1",                       provider: "openai",   name: "OpenAI TTS-1",              capabilities: ["tts"],                         tier: "fast" },
  { id: "tts-1-hd",                    provider: "openai",   name: "OpenAI TTS-1 HD",           capabilities: ["tts"],                         tier: "strong" },
  { id: "whisper-1",                   provider: "openai",   name: "Whisper",                   capabilities: ["stt"],                         tier: "strong" },
  { id: "text-embedding-3-large",      provider: "openai",   name: "Embedding 3 Large",         capabilities: ["embeddings"],                  tier: "strong" },
  { id: "text-embedding-3-small",      provider: "openai",   name: "Embedding 3 Small",         capabilities: ["embeddings"],                  tier: "fast" },

  // ── Google ───────────────────────────────────────────────────────────────
  { id: "gemini-2.5-pro-preview-06-05", provider: "google",  name: "Gemini 2.5 Pro",            capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "gemini-2.5-flash-preview-05-20", provider: "google", name: "Gemini 2.5 Flash",         capabilities: ["text", "vision"],              tier: "fast" },
  { id: "gemini-2.0-flash",            provider: "google",  name: "Gemini 2.0 Flash",           capabilities: ["text", "vision"],              tier: "cheap" },
  { id: "imagen-4",                    provider: "google",  name: "Imagen 4",                   capabilities: ["image_gen"],                   tier: "strong" },
  { id: "veo-3",                       provider: "google",  name: "Veo 3",                      capabilities: ["video_gen"],                   tier: "frontier" },
  { id: "text-embedding-004",          provider: "google",  name: "Google Embedding",           capabilities: ["embeddings"],                  tier: "balanced" },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  { id: "deepseek-chat",               provider: "deepseek", name: "DeepSeek V3",               capabilities: ["text"],                        tier: "cheap" },
  { id: "deepseek-reasoner",           provider: "deepseek", name: "DeepSeek R1",               capabilities: ["text", "reasoning"],           tier: "balanced" },

  // ── Qwen ─────────────────────────────────────────────────────────────────
  { id: "qwen-max",                    provider: "qwen",    name: "Qwen Max",                   capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "qwen-plus",                   provider: "qwen",    name: "Qwen Plus",                  capabilities: ["text", "vision"],              tier: "fast" },
  { id: "qwen-turbo",                  provider: "qwen",    name: "Qwen Turbo",                 capabilities: ["text"],                        tier: "cheap" },
  { id: "qwq-plus",                    provider: "qwen",    name: "QwQ Plus",                   capabilities: ["text", "reasoning"],           tier: "balanced" },

  // ── Mistral ──────────────────────────────────────────────────────────────
  { id: "mistral-large-latest",        provider: "mistral", name: "Mistral Large 3",            capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "mistral-small-latest",        provider: "mistral", name: "Mistral Small 3.1",          capabilities: ["text", "vision"],              tier: "fast" },
  { id: "codestral-latest",            provider: "mistral", name: "Codestral",                  capabilities: ["text"],                        tier: "balanced" },
  { id: "mistral-embed",              provider: "mistral", name: "Mistral Embed",               capabilities: ["embeddings"],                  tier: "balanced" },

  // ── xAI ──────────────────────────────────────────────────────────────────
  { id: "grok-3",                      provider: "xai",     name: "Grok 3",                     capabilities: ["text", "reasoning", "vision"], tier: "strong" },
  { id: "grok-3-mini",                 provider: "xai",     name: "Grok 3 Mini",                capabilities: ["text"],                        tier: "fast" },

  // ── Cohere ───────────────────────────────────────────────────────────────
  { id: "command-r-plus",              provider: "cohere",  name: "Command R+",                  capabilities: ["text"],                        tier: "strong" },
  { id: "command-r",                   provider: "cohere",  name: "Command R",                   capabilities: ["text"],                        tier: "fast" },
  { id: "embed-v4.0",                  provider: "cohere",  name: "Cohere Embed v4",             capabilities: ["embeddings"],                  tier: "strong" },

  // ── Zhipu ────────────────────────────────────────────────────────────────
  { id: "glm-4-plus",                  provider: "zhipu",   name: "GLM-4 Plus",                  capabilities: ["text", "vision"],              tier: "balanced" },
  { id: "glm-4-flash",                 provider: "zhipu",   name: "GLM-4 Flash",                 capabilities: ["text"],                        tier: "cheap" },

  // ── MiniMax ──────────────────────────────────────────────────────────────
  { id: "minimax-m2.7",                provider: "minimax", name: "MiniMax M2.7",                capabilities: ["text"],                        tier: "balanced" },

  // ── Moonshot ─────────────────────────────────────────────────────────────
  { id: "kimi-k2.5",                   provider: "moonshot", name: "Kimi K2.5",                  capabilities: ["text"],                        tier: "balanced" },

  // ── Baidu ────────────────────────────────────────────────────────────────
  { id: "ernie-4.5",                   provider: "baidu",   name: "ERNIE 4.5",                   capabilities: ["text"],                        tier: "balanced" },
  { id: "ernie-x1",                    provider: "baidu",   name: "ERNIE X1",                    capabilities: ["text", "reasoning"],           tier: "cheap" },

  // ── ByteDance ────────────────────────────────────────────────────────────
  { id: "doubao-seed-2.0-pro",         provider: "doubao",  name: "Doubao Seed 2.0 Pro",         capabilities: ["text"],                        tier: "balanced" },
  { id: "doubao-seed-2.0-mini",        provider: "doubao",  name: "Doubao Seed 2.0 Mini",        capabilities: ["text"],                        tier: "cheap" },

  // ── StepFun ──────────────────────────────────────────────────────────────
  { id: "step-3.5-flash",              provider: "stepfun", name: "Step 3.5 Flash",              capabilities: ["text"],                        tier: "cheap" },

  // ── Yi ───────────────────────────────────────────────────────────────────
  { id: "yi-large",                    provider: "yi",      name: "Yi Large",                    capabilities: ["text"],                        tier: "balanced" },

  // ── AI21 ─────────────────────────────────────────────────────────────────
  { id: "jamba-large-1.7",             provider: "ai21",    name: "Jamba Large 1.7",             capabilities: ["text"],                        tier: "balanced" },

  // ── Reka ─────────────────────────────────────────────────────────────────
  { id: "reka-core",                   provider: "reka",    name: "Reka Core",                   capabilities: ["text", "vision"],              tier: "balanced" },
  { id: "reka-flash",                  provider: "reka",    name: "Reka Flash",                  capabilities: ["text", "vision"],              tier: "fast" },

  // ── Groq (speed tier — same models, 10x faster) ──────────────────────────
  { id: "llama-4-scout-17b-16e-instruct",  provider: "groq", name: "Llama 4 Scout (Groq)",      capabilities: ["text", "vision"],              tier: "cheap" },
  { id: "llama-3.3-70b-versatile",          provider: "groq", name: "Llama 3.3 70B (Groq)",      capabilities: ["text"],                        tier: "fast" },
  { id: "whisper-large-v3",                 provider: "groq", name: "Whisper v3 (Groq)",          capabilities: ["stt"],                         tier: "cheap" },

  // ── Together AI ──────────────────────────────────────────────────────────
  { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", provider: "together", name: "Llama 4 Maverick", capabilities: ["text", "vision"], tier: "balanced" },
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",           provider: "together", name: "Llama 3.3 70B",    capabilities: ["text"],           tier: "fast" },

  // ── Perplexity ───────────────────────────────────────────────────────────
  { id: "sonar-pro",                   provider: "perplexity", name: "Sonar Pro",                capabilities: ["text"],                        tier: "strong" },
  { id: "sonar",                       provider: "perplexity", name: "Sonar",                    capabilities: ["text"],                        tier: "fast" },

  // ── ElevenLabs ───────────────────────────────────────────────────────────
  { id: "eleven_turbo_v2.5",           provider: "elevenlabs", name: "ElevenLabs Turbo v2.5",    capabilities: ["tts", "voice_clone"],           tier: "strong" },
  { id: "eleven_multilingual_v2",      provider: "elevenlabs", name: "ElevenLabs Multilingual",  capabilities: ["tts", "voice_clone"],           tier: "frontier" },
  { id: "eleven_sound_effects",        provider: "elevenlabs", name: "ElevenLabs Sound FX",      capabilities: ["sound_fx"],                     tier: "strong" },

  // ── Stability AI ─────────────────────────────────────────────────────────
  { id: "stable-diffusion-3.5-large",  provider: "stability", name: "SD 3.5 Large",              capabilities: ["image_gen"],                    tier: "strong" },
  { id: "stable-image-ultra",          provider: "stability", name: "Stable Image Ultra",         capabilities: ["image_gen"],                    tier: "frontier" },

  // ── Flux / BFL ───────────────────────────────────────────────────────────
  { id: "flux-2-pro",                  provider: "flux",      name: "FLUX.2 Pro",                 capabilities: ["image_gen"],                    tier: "frontier" },
  { id: "flux-1-schnell",              provider: "flux",      name: "FLUX.1 Schnell",             capabilities: ["image_gen"],                    tier: "fast" },

  // ── Ideogram ─────────────────────────────────────────────────────────────
  { id: "ideogram-3.0",                provider: "ideogram",  name: "Ideogram 3.0",               capabilities: ["image_gen"],                    tier: "strong" },

  // ── Recraft ──────────────────────────────────────────────────────────────
  { id: "recraft-v4",                  provider: "recraft",   name: "Recraft V4",                  capabilities: ["image_gen"],                    tier: "strong" },

  // ── Runway ───────────────────────────────────────────────────────────────
  { id: "gen-4-turbo",                 provider: "runway",    name: "Gen-4 Turbo",                 capabilities: ["video_gen"],                    tier: "frontier" },

  // ── Luma ─────────────────────────────────────────────────────────────────
  { id: "ray-3",                       provider: "luma",      name: "Luma Ray 3",                  capabilities: ["video_gen"],                    tier: "strong" },

  // ── Suno ─────────────────────────────────────────────────────────────────
  { id: "suno-v4",                     provider: "suno",      name: "Suno V4",                     capabilities: ["music"],                        tier: "strong" },

  // ── HeyGen ───────────────────────────────────────────────────────────────
  { id: "heygen-avatar-v2",            provider: "heygen",    name: "HeyGen Avatar V2",            capabilities: ["avatar"],                       tier: "strong" },

  // ── Meshy ────────────────────────────────────────────────────────────────
  { id: "meshy-4",                     provider: "meshy",     name: "Meshy 4",                     capabilities: ["3d_gen"],                       tier: "strong" },

  // ── Deepgram ─────────────────────────────────────────────────────────────
  { id: "nova-3",                      provider: "deepgram",  name: "Deepgram Nova-3",             capabilities: ["stt"],                          tier: "strong" },

  // ── Cartesia ─────────────────────────────────────────────────────────────
  { id: "sonic-2",                     provider: "cartesia",  name: "Cartesia Sonic 2",            capabilities: ["tts"],                          tier: "fast" },

  // ── Voyage ───────────────────────────────────────────────────────────────
  { id: "voyage-3",                    provider: "voyage",    name: "Voyage 3",                    capabilities: ["embeddings"],                   tier: "strong" },

  // ── Jina ─────────────────────────────────────────────────────────────────
  { id: "jina-embeddings-v3",          provider: "jina",      name: "Jina Embeddings v3",          capabilities: ["embeddings"],                   tier: "balanced" },

  // ── fal.ai (hosts many media models) ─────────────────────────────────────
  { id: "fal-minimax-hailuo-02",       provider: "fal",       name: "Hailuo 02 (via fal)",         capabilities: ["video_gen"],                    tier: "balanced" },
  { id: "fal-seedance-2.0",            provider: "fal",       name: "Seedance 2.0 (via fal)",      capabilities: ["video_gen"],                    tier: "balanced" },
  { id: "fal-hunyuan-video",           provider: "fal",       name: "HunyuanVideo (via fal)",      capabilities: ["video_gen"],                    tier: "cheap" },
  { id: "fal-pika-2.2",               provider: "fal",       name: "Pika 2.2 (via fal)",          capabilities: ["video_gen"],                    tier: "balanced" },
  { id: "fal-kling-3.0",              provider: "fal",       name: "Kling 3.0 (via fal)",         capabilities: ["video_gen"],                    tier: "strong" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getProvider(providerId: string): Provider | undefined {
  return PROVIDERS.find(p => p.id === providerId);
}

export function getModel(modelId: string): Model | undefined {
  return MODELS.find(m => m.id === modelId);
}

// Note: hasProviderKey, getModelsForCapability, getActiveProviders, getAllProviderSlots
// live in ./keys.ts to avoid circular imports (they need DB access via keys.ts).
