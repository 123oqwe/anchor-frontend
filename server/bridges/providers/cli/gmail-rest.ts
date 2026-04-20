/**
 * Gmail REST provider (CLI kind — one-shot HTTPS, stateless).
 *
 * Real path: reads OAuth token from token-store, POSTs RFC822 email to
 * gmail.googleapis.com. No mocks, no fallbacks written into the provider —
 * any failure (no token, 401, 5xx) surfaces to the bridge dispatcher which
 * falls through to the next provider.
 */
import axios from "axios";
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { getFreshAccessToken, isConnected } from "../../../integrations/token-store.js";
import { DEFAULT_USER_ID } from "../../../infra/storage/db.js";

interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

interface SendEmailOutput {
  messageId: string;
  threadId: string;
}

function buildRfc822(input: SendEmailInput, from: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : "",
    input.bcc ? `Bcc: ${input.bcc}` : "",
    `Subject: ${input.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    input.body,
  ].filter(Boolean);
  return lines.join("\r\n");
}

function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const gmailRestProvider: ProviderDef<SendEmailInput, SendEmailOutput> = {
  id: "gmail-rest",
  kind: "cli",
  capability: "email.send",
  displayName: "Gmail (REST API)",
  platforms: ["macos", "windows", "linux"],
  requires: { oauth: "google" },
  concurrency: "parallel",
  rateLimit: { maxPerMinute: 60 },

  async healthCheck(): Promise<HealthStatus> {
    const connected = isConnected(DEFAULT_USER_ID, "google");
    if (!connected) {
      return { healthy: false, reason: "Google not connected — visit Settings → Integrations", checkedAt: Date.now() };
    }
    const token = await getFreshAccessToken(DEFAULT_USER_ID, "google");
    if (!token) {
      return { healthy: false, reason: "Google token invalid or refresh failed — reconnect", checkedAt: Date.now() };
    }
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input, _ctx): Promise<ProviderResult<SendEmailOutput>> {
    const token = await getFreshAccessToken(DEFAULT_USER_ID, "google");
    if (!token) {
      return {
        success: false, output: "No Google access token available",
        error: "NO_TOKEN", errorKind: "terminal",
      };
    }

    // Get the user's "from" address from profile endpoint
    let from = "me";
    try {
      const profile = await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10_000,
      });
      from = profile.data.emailAddress ?? "me";
    } catch {
      // fall through — server accepts "me" but From header won't be populated
    }

    const raw = base64urlEncode(buildRfc822(input, from));
    try {
      const res = await axios.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        { raw },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15_000 }
      );
      return {
        success: true,
        output: `Sent to ${input.to}: "${input.subject}" (messageId=${res.data.id})`,
        data: { messageId: res.data.id, threadId: res.data.threadId },
      };
    } catch (err: any) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message ?? err.message;
      const errorKind: "terminal" | "retryable" = status === 401 || status === 403 ? "terminal" : "retryable";
      return {
        success: false,
        output: `Gmail send failed: ${msg}`,
        error: msg, errorKind,
      };
    }
  },

  friendlyError(err) {
    if (err?.response?.status === 401) return "Gmail authorization expired. Reconnect in Settings → Integrations.";
    if (err?.response?.status === 403) return "Gmail send scope missing. Reconnect with email scope.";
    return err?.message ?? "Gmail send failed";
  },
};
