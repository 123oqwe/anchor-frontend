import { Router } from "express";
import { setApiKey, deleteApiKey, getApiKey } from "../infra/compute/keys.js";
import { getRegistryInfo } from "../execution/registry.js";
import { getPermissionStatus, activateLockdown, deactivateLockdown, isLocked, setTrustLevel } from "../permission/gate.js";
import { type PermissionLevel, type ActionClass } from "../permission/levels.js";
import { PROVIDERS, MODELS } from "../infra/compute/providers.js";
import { getCapabilityRoster } from "../infra/compute/index.js";
import {
  getCostSummary, getPerformanceSummary, getRecentCalls, getCallDetail,
  getRouteOverride, setRouteOverride, clearRouteOverride, getAllOverrides,
} from "../infra/compute/telemetry.js";
import { TASK_ROUTES } from "../infra/compute/router.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

const router = Router();

// ── Get full roster for a capability (active + inactive models/providers) ───
router.get("/capability/:cap", (req, res) => {
  try {
    const roster = getCapabilityRoster(req.params.cap as any);
    res.json(roster);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

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

// ── Telemetry: costs + performance ──────────────────────────────────────────

router.get("/costs", (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  res.json(getCostSummary(days));
});

router.get("/performance", (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  res.json(getPerformanceSummary(days));
});

router.get("/calls", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  res.json(getRecentCalls(limit));
});

router.get("/calls/:id", (req, res) => {
  const call = getCallDetail(req.params.id);
  if (!call) return res.status(404).json({ error: "Not found" });
  res.json(call);
});

// ── Route overrides ─────────────────────────────────────────────────────────

router.get("/overrides", (_req, res) => {
  res.json(getAllOverrides());
});

router.put("/overrides/:task", (req, res) => {
  const { modelId } = req.body;
  if (!modelId) return res.status(400).json({ error: "modelId required" });
  const task = req.params.task;
  if (!TASK_ROUTES[task]) return res.status(400).json({ error: "Unknown task" });
  if (!MODELS.find(m => m.id === modelId)) return res.status(400).json({ error: "Unknown model" });
  setRouteOverride(task, modelId);
  res.json({ ok: true });
});

router.delete("/overrides/:task", (req, res) => {
  clearRouteOverride(req.params.task);
  res.json({ ok: true });
});

// ── Tool registry ───────────────────────────────────────────────────────────

router.get("/tools", (_req, res) => {
  res.json(getRegistryInfo());
});

// ── Permission status ───────────────────────────────────────────────────────

router.get("/permissions", (_req, res) => {
  res.json({ ...getPermissionStatus(), lockdown: isLocked() });
});

router.post("/permissions/lockdown", (_req, res) => {
  activateLockdown();
  res.json({ ok: true, lockdown: true });
});

router.delete("/permissions/lockdown", (_req, res) => {
  deactivateLockdown();
  res.json({ ok: true, lockdown: false });
});

router.put("/permissions/trust/:actionClass", (req, res) => {
  const { level } = req.body;
  setTrustLevel(req.params.actionClass as ActionClass, level as PermissionLevel);
  res.json({ ok: true });
});

export default router;
