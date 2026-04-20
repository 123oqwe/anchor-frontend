/**
 * Claude Code CLI provider (kind: cli).
 *
 * Spawns `claude -p "prompt"` — the non-interactive print mode. Returns
 * Claude Code's textual output. No persistent session. Complements the MCP
 * provider (which keeps claude running as a JSON-RPC server).
 *
 * Real path: relies on the user having Claude Code installed. Resolves to
 * $HOME/.local/bin/claude or whichever path `which claude` returns.
 */
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { runCli, hasBinary } from "./base.js";

interface DevDelegateInput {
  task: string;
  workingDir?: string;
  maxBudgetUsd?: number;
  effort?: "low" | "medium" | "high";
  allowedTools?: string[];          // comma-separated whitelist
  outputFormat?: "text" | "stream-json";
}

interface DevDelegateOutput {
  text: string;
  exitCode: number;
}

export const claudeCliProvider: ProviderDef<DevDelegateInput, DevDelegateOutput> = {
  id: "claude-cli",
  kind: "cli",
  capability: "dev.delegate",
  displayName: "Claude Code (CLI print)",
  platforms: ["macos", "windows", "linux"],
  requires: { binary: "claude" },
  concurrency: "parallel",
  rateLimit: { maxPerMinute: 10 },

  async healthCheck(): Promise<HealthStatus> {
    const has = await hasBinary("claude");
    if (!has) {
      return { healthy: false, reason: "`claude` CLI not on PATH (install Claude Code)", checkedAt: Date.now() };
    }
    // Cheap probe — `claude --version` returns in <300ms
    const r = await runCli("claude", ["--version"], { timeoutMs: 5_000 });
    if (r.exitCode !== 0) {
      return { healthy: false, reason: `claude --version failed: ${r.stderr.slice(0, 100)}`, checkedAt: Date.now() };
    }
    return { healthy: true, checkedAt: Date.now() };
  },

  async execute(input): Promise<ProviderResult<DevDelegateOutput>> {
    const args: string[] = ["-p", input.task];
    if (input.workingDir) args.push("--add-dir", input.workingDir);
    if (input.effort) args.push("--effort", input.effort);
    if (input.maxBudgetUsd) args.push("--max-budget-usd", String(input.maxBudgetUsd));
    if (input.allowedTools?.length) args.push("--allowed-tools", input.allowedTools.join(" "));

    const r = await runCli("claude", args, {
      timeoutMs: 15 * 60_000,  // dev tasks can be long
      maxBuffer: 50_000_000,
      cwd: input.workingDir,
    });

    if (r.exitCode !== 0) {
      return {
        success: false,
        output: `Claude CLI exited ${r.exitCode}: ${r.stderr.slice(0, 300) || r.stdout.slice(0, 300)}`,
        error: r.stderr.slice(0, 300) || r.stdout.slice(0, 300),
        errorKind: "retryable",
      };
    }

    const text = r.stdout.trim();
    return {
      success: true,
      output: text.slice(0, 2000),
      data: { text, exitCode: r.exitCode },
    };
  },
};
