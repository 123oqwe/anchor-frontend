/**
 * macOS Shortcuts CLI provider (kind: cli).
 *
 * Calls `shortcuts run "Anchor Send Email" --input-path <tmpfile>`.
 * The Shortcut itself must be installed in the user's Shortcuts.app — we ship
 * .shortcut files in server/bridges/macos-shortcuts/ that the user imports once.
 *
 * The Shortcut internally uses AppleScript to talk to Mail/Calendar/Reminders.
 * This wrapper:
 *   - Avoids Anchor concatenating AppleScript strings (escape hole closed)
 *   - Lets the user audit/edit the automation in Shortcuts.app
 *   - Degrades cleanly: if Shortcut not installed, healthCheck fails → bridge
 *     falls through to the next provider (e.g., raw AppleScript or Gmail REST)
 */
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { ProviderDef, ProviderResult, HealthStatus } from "../../types.js";
import { runCli, hasBinary } from "./base.js";

interface ShortcutSpec<Input> {
  shortcutName: string;              // e.g. "Anchor Send Email"
  capability: string;
  displayName: string;
  actionClassLabel: string;
  buildInput: (input: Input) => string;  // JSON or plain text fed as --input-path
  timeoutMs?: number;
}

async function listShortcuts(): Promise<string[]> {
  try {
    const r = await runCli("shortcuts", ["list"], { timeoutMs: 5_000 });
    return r.stdout.split("\n").map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Factory that builds a Shortcuts-CLI-based provider for a specific Shortcut. */
export function makeShortcutsProvider<Input = any, Output = any>(
  providerId: string,
  capabilityName: string,
  spec: ShortcutSpec<Input>
): ProviderDef<Input, Output> {
  return {
    id: providerId,
    kind: "cli",
    capability: capabilityName,
    displayName: `${spec.displayName} (macOS Shortcuts)`,
    platforms: ["macos"],
    requires: { binary: "shortcuts", shortcuts: [spec.shortcutName] },
    concurrency: "serial",  // Shortcuts.app runs one at a time reliably

    async healthCheck(): Promise<HealthStatus> {
      if (process.platform !== "darwin") {
        return { healthy: false, reason: "macOS only", checkedAt: Date.now() };
      }
      const has = await hasBinary("shortcuts");
      if (!has) return { healthy: false, reason: "`shortcuts` CLI not found", checkedAt: Date.now() };
      const installed = await listShortcuts();
      if (!installed.includes(spec.shortcutName)) {
        return {
          healthy: false,
          reason: `Shortcut "${spec.shortcutName}" not installed. Import from Settings → Integrations → Install Anchor Shortcuts.`,
          checkedAt: Date.now(),
        };
      }
      return { healthy: true, checkedAt: Date.now() };
    },

    async execute(input): Promise<ProviderResult<Output>> {
      const dir = await mkdtemp(path.join(tmpdir(), "anchor-sc-"));
      const inPath = path.join(dir, "input.json");
      const outPath = path.join(dir, "output.txt");
      try {
        const payload = spec.buildInput(input);
        await writeFile(inPath, payload, "utf-8");

        const res = await runCli(
          "shortcuts",
          ["run", spec.shortcutName, "--input-path", inPath, "--output-path", outPath],
          { timeoutMs: spec.timeoutMs ?? 30_000 }
        );

        if (res.exitCode !== 0) {
          return {
            success: false,
            output: `Shortcut "${spec.shortcutName}" exited ${res.exitCode}: ${res.stderr.slice(0, 300)}`,
            error: res.stderr.slice(0, 300),
            errorKind: "retryable",
          };
        }

        return {
          success: true,
          output: `Ran Shortcut "${spec.shortcutName}" (${res.stdout.slice(0, 200) || "no stdout"})`,
          data: { exitCode: 0, stdout: res.stdout } as any,
        };
      } catch (err: any) {
        return {
          success: false, output: `Shortcut run failed: ${err.message}`,
          error: err.message, errorKind: "retryable",
        };
      } finally {
        // Best-effort cleanup
        await unlink(inPath).catch(() => {});
        await unlink(outPath).catch(() => {});
      }
    },
  };
}

// ── Concrete providers ──────────────────────────────────────────────────────

export const appleMailShortcutsProvider = makeShortcutsProvider<
  { to: string; subject: string; body: string; cc?: string; bcc?: string },
  { exitCode: number; stdout: string }
>("applemail-shortcuts", "email.send", {
  shortcutName: "Anchor Send Email",
  capability: "email.send",
  displayName: "Apple Mail",
  actionClassLabel: "send_external",
  buildInput: (i) => JSON.stringify({ to: i.to, subject: i.subject, body: i.body, cc: i.cc, bcc: i.bcc }),
  timeoutMs: 30_000,
});
