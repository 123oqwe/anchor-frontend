/**
 * API Key management — DB-first, env fallback.
 * Keys entered via UI are stored in SQLite and take precedence over .env.
 */

import { db } from "../db.js";
import { PROVIDERS, MODELS, type Provider, type Model, type Capability } from "./providers.js";

export function getApiKey(providerId: string): string | undefined {
  // DB first (set via UI)
  const row = db.prepare("SELECT api_key FROM api_keys WHERE provider_id = ?").get(providerId) as any;
  if (row?.api_key) return row.api_key;

  // Fallback to environment variable
  const provider = PROVIDERS.find(p => p.id === providerId);
  if (!provider) return undefined;
  return process.env[provider.envKey];
}

export function hasApiKey(providerId: string): boolean {
  return !!getApiKey(providerId);
}

export function setApiKey(providerId: string, key: string): void {
  const provider = PROVIDERS.find(p => p.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!key || key.trim().length < 8) throw new Error("API key too short");

  db.prepare(
    "INSERT INTO api_keys (provider_id, api_key, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(provider_id) DO UPDATE SET api_key=excluded.api_key, updated_at=excluded.updated_at"
  ).run(providerId, key.trim());
}

export function deleteApiKey(providerId: string): void {
  db.prepare("DELETE FROM api_keys WHERE provider_id = ?").run(providerId);
}

export function maskKey(key: string): string {
  if (key.length <= 12) return "•••••";
  return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

export interface KeyStatus {
  providerId: string;
  source: "db" | "env" | "none";
  masked?: string;
  updatedAt?: string;
}

export function getKeyStatus(providerId: string): KeyStatus {
  const row = db.prepare("SELECT api_key, updated_at FROM api_keys WHERE provider_id = ?").get(providerId) as any;
  if (row?.api_key) {
    return { providerId, source: "db", masked: maskKey(row.api_key), updatedAt: row.updated_at };
  }
  const provider = PROVIDERS.find(p => p.id === providerId);
  if (provider && process.env[provider.envKey]) {
    return { providerId, source: "env", masked: maskKey(process.env[provider.envKey]!) };
  }
  return { providerId, source: "none" };
}

export function getAllKeyStatuses(): Record<string, KeyStatus> {
  const result: Record<string, KeyStatus> = {};
  for (const p of PROVIDERS) {
    result[p.id] = getKeyStatus(p.id);
  }
  return result;
}

// ── Provider/Model helpers that need DB access ──────────────────────────────

export function hasProviderKey(providerId: string): boolean {
  return hasApiKey(providerId);
}

export function getModelsForCapability(cap: Capability): Model[] {
  return MODELS.filter(m => m.capabilities.includes(cap) && hasApiKey(m.provider));
}

export function getActiveProviders(): Provider[] {
  return PROVIDERS.filter(p => hasApiKey(p.id));
}

export function getAllProviderSlots(): { id: string; name: string; envKey: string; active: boolean }[] {
  return PROVIDERS.map(p => ({ id: p.id, name: p.name, envKey: p.envKey, active: hasApiKey(p.id) }));
}
