/**
 * Per-agent scoped bearer tokens for the localhost Bridge HTTP API.
 *
 * Why: execute_code spawns subprocess. That subprocess needs to call Bridge
 * (email.send, etc) but must NOT see raw OAuth tokens or the Anchor DB. Issue
 * a short-lived HMAC-signed token scoped to (agentId, runId, allowedBridges).
 * Subprocess presents token → Bridge HTTP route verifies + scopes call.
 *
 * Format: base64url(payload) + "." + base64url(hmac_sha256(secret, payload))
 *
 * NOT a full JWT — no alg/header flexibility, no kid rotation, no aud. Just
 * the minimum needed for a token that never leaves the local machine.
 */
import crypto from "crypto";

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 min

let SECRET = process.env.ANCHOR_TOKEN_SECRET;
if (!SECRET) {
  // Stable across process lifetime (but random per boot — tokens die on restart).
  // Production: set ANCHOR_TOKEN_SECRET in .env for stable tokens across restarts.
  SECRET = crypto.randomBytes(32).toString("hex");
}

export interface TokenPayload {
  agentId: string;
  agentName: string;
  runId: string;
  missionId: string;          // P6: mission scope for shared blackboard
  allowedBridges: string[];   // ["*"] means any capability
  expiresAt: number;          // unix ms
}

export function mintToken(p: Omit<TokenPayload, "expiresAt">): string {
  const payload: TokenPayload = { ...p, expiresAt: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET!).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac("sha256", SECRET!).update(body).digest("base64url");
  // Constant-time compare to avoid timing side channels (even though this is localhost).
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expect, "base64url");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) return null;
    if (!Array.isArray(payload.allowedBridges)) return null;
    // Backfill missionId for tokens minted before P6 (defensive)
    if (typeof payload.missionId !== "string") payload.missionId = payload.runId;
    return payload;
  } catch { return null; }
}

export function isBridgeAllowed(payload: TokenPayload, capability: string): boolean {
  if (payload.allowedBridges.includes("*")) return true;
  return payload.allowedBridges.includes(capability);
}
