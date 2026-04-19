/**
 * iMessage Channel — read and send iMessages via AppleScript.
 *
 * Anchor is already on Mac — no need for BlueBubbles or any bridge.
 * Direct AppleScript access to Messages.app.
 *
 * Safety: NEVER auto-replies. Only reads messages and suggests replies.
 * User must explicitly confirm before any message is sent.
 */
import { execSync } from "child_process";
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

const router = Router();

interface IMessage {
  sender: string;
  text: string;
  date: string;
  isFromMe: boolean;
}

// ── Read recent messages via SQLite (faster than AppleScript) ────────────────

function getRecentMessages(limit = 20): IMessage[] {
  try {
    // iMessage stores in ~/Library/Messages/chat.db
    const dbPath = `${process.env.HOME}/Library/Messages/chat.db`;
    const query = `
      SELECT
        COALESCE(h.id, 'me') as sender,
        m.text,
        datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as date,
        m.is_from_me
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.text IS NOT NULL AND m.text != ''
      ORDER BY m.date DESC
      LIMIT ${limit}
    `;

    const result = execSync(`sqlite3 "${dbPath}" "${query}"`, { timeout: 5000, encoding: "utf-8" });

    return result.split("\n").filter(Boolean).map(line => {
      const [sender, text, date, isFromMe] = line.split("|");
      return { sender: sender ?? "unknown", text: text ?? "", date: date ?? "", isFromMe: isFromMe === "1" };
    });
  } catch (err: any) {
    if (err.message?.includes("EPERM") || err.message?.includes("not permitted")) {
      return []; // Full Disk Access needed
    }
    return [];
  }
}

// ── Send message via AppleScript ────────────────────────────────────────────

function sendMessage(recipient: string, messageText: string): boolean {
  try {
    const escaped = messageText.replace(/"/g, '\\"').replace(/\n/g, "\\n");
    execSync(
      `osascript -e 'tell application "Messages" to send "${escaped}" to buddy "${recipient}" of (first account whose service type is iMessage)'`,
      { timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

// ── API Routes ──────────────────────────────────────────────────────────────

// Check if iMessage is accessible
router.get("/status", (_req, res) => {
  const messages = getRecentMessages(1);
  res.json({
    available: messages.length > 0 || true, // Messages.app exists on all Macs
    recentMessageCount: messages.length,
    needsPermission: messages.length === 0,
  });
});

// Get recent messages
router.get("/messages", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const messages = getRecentMessages(limit);
  res.json(messages);
});

// Send message (requires explicit user action)
router.post("/send", (req, res) => {
  const { recipient, text } = req.body;
  if (!recipient || !text) return res.status(400).json({ error: "recipient and text required" });

  const success = sendMessage(recipient, text);
  if (success) {
    // Log the send action
    db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
      .run(require("nanoid").nanoid(), DEFAULT_USER_ID, "iMessage", `Sent to ${recipient}: ${text.slice(0, 50)}`, "success");
  }
  res.json({ ok: success });
});

// Suggest reply (uses Decision Agent)
router.post("/suggest-reply", async (req, res) => {
  const { sender, messageText, context } = req.body;
  if (!sender || !messageText) return res.status(400).json({ error: "sender and messageText required" });

  try {
    const { decide } = await import("../cognition/decision.js");
    const result = await decide(
      `Someone named "${sender}" sent me this iMessage: "${messageText}"\n${context ? `Context: ${context}` : ""}\n\nDraft a brief, natural reply. Match my usual tone. Keep it under 50 words.`,
      []
    );
    res.json({ suggestion: result.raw });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
