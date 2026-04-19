/**
 * Integrations routes — OAuth connect/disconnect + scan triggers.
 */
import { Router, Request, Response } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import axios from "axios";
import { saveTokens, getTokens, deleteTokens, isConnected } from "../integrations/token-store.js";
import { runIngestion } from "../integrations/pipeline.js";
import { runLocalScan, getLocalScanStatus, hasConsent, grantConsent, revokeConsent } from "../integrations/local/index.js";

const router = Router();

// ── Local Scan (browser history + contacts + calendar) ─────────────────────

router.get("/local/status", (_req, res) => {
  res.json(getLocalScanStatus());
});

// Grant consent — must be called before first scan (GDPR)
router.post("/local/consent", (_req, res) => {
  grantConsent(DEFAULT_USER_ID);
  res.json({ ok: true, consented: true });
});

// Revoke consent — stops future scans
router.delete("/local/consent", (_req, res) => {
  revokeConsent(DEFAULT_USER_ID);
  res.json({ ok: true, consented: false });
});

// Onboarding scan — grants consent + starts scan in one step
// This is the "Allow — Scan My Data" button in Onboarding
router.post("/local/onboarding-scan", async (_req, res) => {
  grantConsent(DEFAULT_USER_ID);
  const status = getLocalScanStatus();
  res.json({ started: true, browsers: status.availableBrowsers });
  runLocalScan().catch(err => console.error("[LocalScan] Onboarding scan error:", err.message));
});

// Full scan — requires consent
router.post("/local/scan", async (_req, res) => {
  if (!hasConsent(DEFAULT_USER_ID)) {
    return res.status(403).json({ error: "Consent required. Call POST /api/integrations/local/consent first." });
  }
  res.json({ started: true });
  runLocalScan().catch(err => console.error("[LocalScan] Error:", err.message));
});

router.post("/local/scan/browser", async (_req, res) => {
  if (!hasConsent(DEFAULT_USER_ID)) return res.status(403).json({ error: "Consent required" });
  res.json({ started: true });
  runLocalScan({ browser: true, contacts: false, calendar: false }).catch(() => {});
});

router.post("/local/scan/contacts", async (_req, res) => {
  if (!hasConsent(DEFAULT_USER_ID)) return res.status(403).json({ error: "Consent required" });
  res.json({ started: true });
  runLocalScan({ browser: false, contacts: true, calendar: false }).catch(() => {});
});

router.post("/local/scan/calendar", async (_req, res) => {
  if (!hasConsent(DEFAULT_USER_ID)) return res.status(403).json({ error: "Consent required" });
  res.json({ started: true });
  runLocalScan({ browser: false, contacts: false, calendar: true }).catch(() => {});
});

// ── Finance tracking (manual input → runway calculation) ────────────────────

router.get("/finance", (_req, res) => {
  const { getFinanceSnapshot } = require("../integrations/local/finance.js");
  res.json(getFinanceSnapshot() ?? { balance: 0, monthlyBurn: 0, monthlyIncome: 0, runway: 0, categories: [], trend: [], risks: [] });
});

router.post("/finance", (req, res) => {
  const { balance, monthlyBurn, monthlyIncome, categories } = req.body;
  if (balance == null || monthlyBurn == null) return res.status(400).json({ error: "balance and monthlyBurn required" });
  const { saveFinanceSnapshot } = require("../integrations/local/finance.js");
  const snapshot = saveFinanceSnapshot({ balance, monthlyBurn, monthlyIncome, categories });
  res.json(snapshot);
});

router.post("/finance/expense", (req, res) => {
  const { category, amount, note } = req.body;
  if (!category || !amount) return res.status(400).json({ error: "category and amount required" });
  const { addExpense } = require("../integrations/local/finance.js");
  addExpense({ category, amount, note });
  res.json({ ok: true });
});

// ── People extraction (direct, no LLM) ─────────────────────────────────────

router.post("/local/scan/people", async (_req, res) => {
  const { extractAndSavePeople } = require("../integrations/local/people-extractor.js");
  const result = extractAndSavePeople();
  res.json(result);
});

// Cleanup junk nodes from old scans
router.post("/local/cleanup", (_req, res) => {
  const JUNK_TYPES = ["resource", "artifact", "observation", "external_context"];
  let removed = 0;
  for (const type of JUNK_TYPES) {
    const result = db.prepare("DELETE FROM graph_nodes WHERE user_id=? AND type=?").run(DEFAULT_USER_ID, type);
    removed += result.changes;
  }
  res.json({ ok: true, removed });
});

// ── Activity monitoring ─────────────────────────────────────────────────────

router.get("/activity/status", (_req, res) => {
  const { getActivityStatus } = require("../integrations/local/activity-monitor.js");
  res.json(getActivityStatus());
});

router.get("/activity/time", (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const { getTimeByApp, getTimeByProject, getPersonActivity } = require("../integrations/local/activity-monitor.js");
  res.json({
    byApp: getTimeByApp(hours),
    byProject: getTimeByProject(hours),
    personActivity: getPersonActivity(hours),
  });
});

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

// ── Connect: get Google OAuth consent URL ──────────────────────────────────

router.get("/google/connect", (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI must be set in .env" });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// ── OAuth callback: exchange code for tokens ───────────────────────────────

router.get("/google/callback", async (req: Request, res: Response) => {
  const { code } = req.query;
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const { access_token, refresh_token, expires_in, scope } = tokenRes.data;

    saveTokens(DEFAULT_USER_ID, "google", {
      access_token,
      refresh_token,
      expires_in: expires_in ?? 3600,
      scope,
    });

    // Trigger full scan in background
    runIngestion(DEFAULT_USER_ID, "full").catch(err =>
      console.error("[Integrations] Initial scan failed:", err.message)
    );

    // Redirect to settings page
    res.redirect("/settings?connected=google");
  } catch (err: any) {
    console.error("[Integrations] OAuth token exchange failed:", err.response?.data ?? err.message);
    res.status(500).json({ error: "Failed to exchange authorization code" });
  }
});

// ── Status ─────────────────────────────────────────────────────────────────

router.get("/status", (_req, res) => {
  const googleConnected = isConnected(DEFAULT_USER_ID, "google");
  const tokens = googleConnected ? getTokens(DEFAULT_USER_ID, "google") : null;

  const lastScan = db.prepare(
    "SELECT finished_at, status, events_fetched, nodes_created FROM ingestion_log WHERE user_id=? AND source='google' ORDER BY started_at DESC LIMIT 1"
  ).get(DEFAULT_USER_ID) as any;

  res.json({
    google: {
      connected: googleConnected,
      connectedAt: tokens?.created_at ?? null,
      lastScan: lastScan ? {
        at: lastScan.finished_at,
        status: lastScan.status,
        eventsFetched: lastScan.events_fetched,
        nodesCreated: lastScan.nodes_created,
      } : null,
    },
  });
});

// ── Disconnect ─────────────────────────────────────────────────────────────

router.delete("/google", (_req, res) => {
  deleteTokens(DEFAULT_USER_ID, "google");
  res.json({ ok: true });
});

// ── Manual scan trigger ────────────────────────────────────────────────────

router.post("/google/scan", async (_req, res) => {
  if (!isConnected(DEFAULT_USER_ID, "google")) {
    return res.status(400).json({ error: "Google not connected" });
  }

  // Fire and forget
  runIngestion(DEFAULT_USER_ID, "incremental").catch(err =>
    console.error("[Integrations] Manual scan failed:", err.message)
  );

  res.json({ started: true });
});

export default router;
