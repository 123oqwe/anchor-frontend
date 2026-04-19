/**
 * Telegram Channel — talk to Anchor without opening a browser.
 *
 * Commands:
 *   /today — what matters now
 *   /status — energy, focus, stress
 *   /scan — trigger Mac scan
 *   (free text) — ask Decision Agent
 *
 * Setup: create bot via @BotFather, set TELEGRAM_BOT_TOKEN in .env
 */
import { Telegraf } from "telegraf";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { decide } from "../cognition/decision.js";

let bot: Telegraf | null = null;

export function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[Telegram] Disabled (set TELEGRAM_BOT_TOKEN to enable)");
    return;
  }

  bot = new Telegraf(token);

  // /today — most important thing right now
  bot.command("today", async (ctx) => {
    try {
      const urgent = db.prepare(
        "SELECT label, detail FROM graph_nodes WHERE user_id=? AND status IN ('delayed','overdue','decaying','blocked') ORDER BY CASE status WHEN 'overdue' THEN 0 WHEN 'delayed' THEN 1 ELSE 2 END LIMIT 1"
      ).get(DEFAULT_USER_ID) as any;

      if (urgent) {
        await ctx.reply(`🎯 *${urgent.label}*\n\n${urgent.detail ?? ""}`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply("✅ Everything looks on track. No urgent items.");
      }
    } catch (err: any) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // /status — current state
  bot.command("status", async (ctx) => {
    try {
      const state = db.prepare("SELECT energy, focus, stress FROM user_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
      const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;

      await ctx.reply(
        `📊 *Current State*\n\n⚡ Energy: ${state?.energy ?? "?"}/100\n🎯 Focus: ${state?.focus ?? "?"}/100\n😰 Stress: ${state?.stress ?? "?"}/100\n\n📌 ${nodeCount} nodes in your Human Graph`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // /scan — trigger local scan
  bot.command("scan", async (ctx) => {
    try {
      await ctx.reply("🔍 Scanning your Mac... this takes about 30 seconds.");
      const { runLocalScan } = await import("./local/index.js");
      const result = await runLocalScan();
      await ctx.reply(`✅ Scan complete: ${result.nodesCreated} new nodes created.`);
    } catch (err: any) {
      await ctx.reply(`Scan failed: ${err.message}`);
    }
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🦞 *Anchor OS*\n\n" +
      "/today — what matters most right now\n" +
      "/status — your current energy, focus, stress\n" +
      "/scan — scan your Mac for updates\n" +
      "Or just type anything to ask Anchor for advice.",
      { parse_mode: "Markdown" }
    );
  });

  // Free text → Decision Agent
  bot.on("text", async (ctx) => {
    const message = ctx.message.text;
    if (message.startsWith("/")) return; // ignore unknown commands

    try {
      await ctx.sendChatAction("typing");
      const result = await decide(message, []);
      const response = result.raw.slice(0, 4000); // Telegram has 4096 char limit
      await ctx.reply(response);
    } catch (err: any) {
      await ctx.reply(`Sorry, something went wrong: ${err.message?.slice(0, 200)}`);
    }
  });

  bot.launch().then(() => {
    console.log("🤖 Telegram bot connected");
  }).catch((err: any) => {
    console.error("[Telegram] Failed to start:", err.message);
  });

  // Graceful stop
  process.once("SIGINT", () => bot?.stop("SIGINT"));
  process.once("SIGTERM", () => bot?.stop("SIGTERM"));
}

export function isTelegramConnected(): boolean {
  return bot !== null;
}
