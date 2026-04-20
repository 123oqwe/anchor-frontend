/**
 * CLI provider base utilities — safe subprocess execution for bridge providers.
 *
 * Uses execFile (NOT shell) so argv is not interpreted; shell metacharacters
 * in arguments stay literal. This is the main reason we didn't give agents
 * a general-purpose shell in the first place.
 */
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { access } from "fs/promises";

const execFileAsync = promisify(execFile);

export interface CliRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;           // stdin content
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a command with args (no shell). Throws on non-zero exit unless captured. */
export async function runCli(
  command: string,
  args: string[],
  options: CliRunOptions = {}
): Promise<CliRunResult> {
  if (options.input !== undefined) {
    // For stdin input, use spawn (execFile doesn't support stdin well)
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      const timeout = options.timeoutMs
        ? setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} reject(new Error(`${command} timeout`)); }, options.timeoutMs)
        : null;
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("exit", (code) => {
        if (timeout) clearTimeout(timeout);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });
      proc.on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        reject(err);
      });
      proc.stdin.write(options.input);
      proc.stdin.end();
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 10_000_000,
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    // execFile throws on non-zero exit; surface stdout/stderr from the error
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      exitCode: err.code ?? 1,
    };
  }
}

/** Check if a binary exists on PATH (or at an absolute path). */
export async function hasBinary(nameOrPath: string): Promise<boolean> {
  if (nameOrPath.startsWith("/")) {
    try { await access(nameOrPath); return true; } catch { return false; }
  }
  try {
    const { stdout } = await execFileAsync("which", [nameOrPath], { timeout: 2000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
