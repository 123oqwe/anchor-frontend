import { Router } from "express";
import { setApiKey, deleteApiKey, getApiKey } from "../cortex/keys.js";
import { PROVIDERS } from "../cortex/providers.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

const router = Router();

// ── Save an API key ─────────────────────────────────────────────────────────
router.put("/providers/:id/key", (req, res) => {
  const { id } = req.params;
  const { key } = req.body;
  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "key required" });
  }
  try {
    setApiKey(id, key);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Delete an API key ───────────────────────────────────────────────────────
router.delete("/providers/:id/key", (req, res) => {
  deleteApiKey(req.params.id);
  res.json({ ok: true });
});

// ── Test a provider's key with a tiny call ──────────────────────────────────
router.post("/providers/:id/test", async (req, res) => {
  const { id } = req.params;
  const provider = PROVIDERS.find(p => p.id === id);
  if (!provider) return res.status(404).json({ error: "Provider not found" });

  const key = getApiKey(id);
  if (!key) return res.status(400).json({ error: "No key configured for this provider" });

  // Pick a minimal test model for each provider
  const testModels: Record<string, string> = {
    anthropic: "claude-haiku-4-5-20251001",
    openai: "gpt-4o-mini",
    google: "gemini-2.0-flash",
    deepseek: "deepseek-chat",
    qwen: "qwen-turbo",
    mistral: "mistral-small-latest",
    xai: "grok-3-mini",
    groq: "llama-3.3-70b-versatile",
    moonshot: "kimi-k2.5",
    zhipu: "glm-4-flash",
    together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    perplexity: "sonar",
    openrouter: "meta-llama/llama-3.3-70b-instruct",
    fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  };

  const modelId = testModels[id];
  if (!modelId) return res.status(400).json({ error: "No test model configured for this provider" });

  try {
    let model: any;
    switch (provider.protocol) {
      case "anthropic":
        model = createAnthropic({ apiKey: key })(modelId);
        break;
      case "google":
        model = createGoogleGenerativeAI({ apiKey: key })(modelId);
        break;
      case "openai-compat":
        model = createOpenAI({ apiKey: key, ...(provider.baseURL ? { baseURL: provider.baseURL } : {}) })(modelId);
        break;
    }

    const start = Date.now();
    const result = await generateText({
      model,
      messages: [{ role: "user", content: "Say 'ok' and nothing else." }],
      maxOutputTokens: 16,
    });
    const latency = Date.now() - start;

    res.json({
      ok: true,
      provider: provider.name,
      model: modelId,
      response: result.text.slice(0, 60),
      latencyMs: latency,
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err.message?.slice(0, 200) ?? "Unknown error",
    });
  }
});

export default router;
