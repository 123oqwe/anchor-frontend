/**
 * Cached health checks — every dispatch calls this, so caching is critical.
 *
 * TTL 60s for unhealthy, 5min for healthy. Aggressive retry on fail so a
 * flaky provider comes back fast; stable provider isn't re-probed hot.
 */
import type { ProviderDef, HealthStatus } from "./types.js";

interface CacheEntry {
  result: HealthStatus;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const HEALTHY_TTL_MS = 5 * 60 * 1000;
const UNHEALTHY_TTL_MS = 60 * 1000;

export async function cachedHealthCheck(provider: ProviderDef): Promise<HealthStatus> {
  const cached = cache.get(provider.id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.result;

  let result: HealthStatus;
  try {
    result = await provider.healthCheck();
  } catch (err: any) {
    result = { healthy: false, reason: err.message?.slice(0, 200) ?? "health check threw", checkedAt: now };
  }
  result.checkedAt = now;
  cache.set(provider.id, {
    result,
    expiresAt: now + (result.healthy ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS),
  });
  return result;
}

export function invalidateHealth(providerId: string): void {
  cache.delete(providerId);
}

export function getHealthSnapshot(): Record<string, HealthStatus | null> {
  const out: Record<string, HealthStatus | null> = {};
  const now = Date.now();
  cache.forEach((entry, id) => {
    out[id] = entry.expiresAt > now ? entry.result : null;
  });
  return out;
}
