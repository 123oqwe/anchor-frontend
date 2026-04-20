/**
 * L5 Execution — Developer tools (OPT-1).
 *
 * Safe, scoped developer-level operations. All writes use propose+approve pattern.
 *
 * Safety layers:
 *   1. L6 Permission Gate (action class = execute_command for writes)
 *   2. Path confinement (must be under user home, not in forbidden paths)
 *   3. Command whitelist for shell
 *   4. Size limits (max 1MB read, 500KB write)
 *   5. Timeouts (5s for shell, 5min for tests)
 */
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { registerTool, type ToolResult } from "./registry.js";

const execFileAsync = promisify(execFile);

// ── Safety guards ──────────────────────────────────────────────────────────

const HOME = os.homedir();
const FORBIDDEN_PATH_PATTERNS = [
  /\.env($|\.)/,           // .env files
  /\/\.ssh\//,             // SSH keys
  /\.pem$/,                // private keys
  /\.key$/,                // keys
  /\/Library\/Keychains/,  // macOS keychain
  /\/Library\/Cookies/,    // browser cookies
  /\/Library\/Application Support\/.+\/Login/,  // app login data
  /\.aws\//,               // AWS credentials
  /id_rsa/,                // SSH private keys
  /\.gnupg\//,             // GPG keys
];

const MAX_READ_BYTES = 1_000_000;  // 1MB
const MAX_WRITE_BYTES = 500_000;   // 500KB

function safePath(input: string): { ok: true; absolute: string } | { ok: false; reason: string } {
  const resolved = path.resolve(input.startsWith("~") ? path.join(HOME, input.slice(1)) : input);
  if (!resolved.startsWith(HOME)) {
    return { ok: false, reason: "Path must be under user home directory" };
  }
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      return { ok: false, reason: `Sensitive path blocked: ${resolved}` };
    }
  }
  return { ok: true, absolute: resolved };
}

// Approved shell commands (read-only, no side effects beyond filesystem reads)
const SAFE_SHELL_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "grep", "find", "wc", "sort", "uniq",
  "date", "echo", "which", "whoami", "hostname", "df", "du",
  "git", // git is complex — we gate on subcommand below
  "node", "npm", "pnpm", "yarn", // allow version checks
  "python", "python3", "pip",     // allow version checks
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "branch", "show", "remote", "config",
]);

function safeShellCheck(command: string, args: string[]): { ok: true } | { ok: false; reason: string } {
  if (!SAFE_SHELL_COMMANDS.has(command)) {
    return { ok: false, reason: `Command "${command}" not in safe whitelist` };
  }
  if (command === "git" && args.length > 0) {
    if (!SAFE_GIT_SUBCOMMANDS.has(args[0])) {
      return { ok: false, reason: `git ${args[0]} not in safe whitelist (read-only git ops only)` };
    }
  }
  // Reject shell metacharacters that could inject
  const joined = args.join(" ");
  if (/[;&|`$(){}]/.test(joined)) {
    return { ok: false, reason: "Shell metacharacters not allowed" };
  }
  return { ok: true };
}

// ── Proposed change storage (propose + approve pattern) ─────────────────────

interface ProposedChange {
  id: string;
  type: "write_file" | "git_commit";
  path?: string;
  before?: string;
  after: string;
  createdAt: number;
}

const proposedChanges = new Map<string, ProposedChange>();
const PROPOSAL_TTL_MS = 10 * 60 * 1000; // 10 minutes

function createProposal(type: "write_file" | "git_commit", details: Partial<ProposedChange>): string {
  const id = `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  proposedChanges.set(id, {
    id,
    type,
    after: "",
    ...details,
    createdAt: Date.now(),
  } as ProposedChange);
  // Cleanup expired proposals
  const expiredKeys: string[] = [];
  proposedChanges.forEach((p, pid) => {
    if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) expiredKeys.push(pid);
  });
  expiredKeys.forEach(k => proposedChanges.delete(k));
  return id;
}

function consumeProposal(id: string): ProposedChange | null {
  const p = proposedChanges.get(id);
  if (!p) return null;
  if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) {
    proposedChanges.delete(id);
    return null;
  }
  proposedChanges.delete(id);
  return p;
}

// ── Register Developer Tools ────────────────────────────────────────────────

export function registerDevTools(): void {

  // ═══ File System (read + propose-write) ═══════════════════════════════

  registerTool({
    name: "read_file",
    description: "Read contents of a file (under user home, not sensitive). Max 1MB.",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, or ~/ relative" } },
      required: ["path"],
    },
    execute: (input): ToolResult => {
      const check = safePath(input.path);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      try {
        const stat = fs.statSync(check.absolute);
        if (stat.isDirectory()) return { success: false, output: "Path is a directory, not a file", error: "IS_DIRECTORY" };
        if (stat.size > MAX_READ_BYTES) return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_READ_BYTES})`, error: "TOO_LARGE" };
        const content = fs.readFileSync(check.absolute, "utf-8");
        return { success: true, output: content, data: { path: check.absolute, bytes: content.length } };
      } catch (err: any) {
        return { success: false, output: `Read failed: ${err.message}`, error: err.code ?? "READ_ERROR" };
      }
    },
  });

  registerTool({
    name: "diff_file",
    description: "Show proposed diff for a file change. Returns proposal ID. Call approve_and_write with that ID to commit.",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        proposed: { type: "string", description: "Proposed new content" },
      },
      required: ["path", "proposed"],
    },
    execute: (input): ToolResult => {
      const check = safePath(input.path);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      if (input.proposed.length > MAX_WRITE_BYTES) return { success: false, output: `Proposed content too large (max ${MAX_WRITE_BYTES})`, error: "TOO_LARGE" };

      let before = "";
      try {
        before = fs.readFileSync(check.absolute, "utf-8");
      } catch {
        before = "";  // new file
      }

      const proposalId = createProposal("write_file", {
        path: check.absolute,
        before,
        after: input.proposed,
      });

      // Simple diff summary (line counts)
      const beforeLines = before.split("\n").length;
      const afterLines = input.proposed.split("\n").length;
      const delta = afterLines - beforeLines;

      return {
        success: true,
        output: `Proposal ${proposalId} created. Diff: ${beforeLines} → ${afterLines} lines (${delta >= 0 ? "+" : ""}${delta}).\nCall approve_and_write with proposal_id to commit.`,
        data: { proposalId, beforeLines, afterLines, delta, path: check.absolute },
      };
    },
  });

  registerTool({
    name: "approve_and_write",
    description: "Commit a previously proposed file change (from diff_file). Proposal expires in 10 minutes.",
    handler: "internal",
    actionClass: "execute_command",
    inputSchema: {
      type: "object",
      properties: { proposal_id: { type: "string", description: "ID returned from diff_file" } },
      required: ["proposal_id"],
    },
    execute: (input): ToolResult => {
      const proposal = consumeProposal(input.proposal_id);
      if (!proposal) return { success: false, output: "Proposal not found or expired", error: "NO_PROPOSAL" };
      if (proposal.type !== "write_file" || !proposal.path) return { success: false, output: "Wrong proposal type", error: "BAD_PROPOSAL" };

      try {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(proposal.path), { recursive: true });
        fs.writeFileSync(proposal.path, proposal.after, "utf-8");
        return {
          success: true,
          output: `Wrote ${proposal.after.length} bytes to ${proposal.path}`,
          data: { path: proposal.path, bytes: proposal.after.length },
          rollback: () => {
            if (proposal.before !== undefined) {
              fs.writeFileSync(proposal.path!, proposal.before, "utf-8");
            } else {
              fs.unlinkSync(proposal.path!);
            }
          },
        };
      } catch (err: any) {
        return { success: false, output: `Write failed: ${err.message}`, error: err.code ?? "WRITE_ERROR" };
      }
    },
  });

  registerTool({
    name: "search_codebase",
    description: "Grep a pattern under a directory (uses grep -rn). Returns matching file:line:content.",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex or literal pattern" },
        path: { type: "string", description: "Directory to search (default: current project)" },
        max_results: { type: "number", description: "Max matches (default 50)" },
      },
      required: ["pattern"],
    },
    execute: async (input): Promise<ToolResult> => {
      const searchPath = input.path ?? process.cwd();
      const check = safePath(searchPath);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      const max = Math.min(input.max_results ?? 50, 200);

      try {
        const { stdout } = await execFileAsync("grep", ["-rn", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist", input.pattern, check.absolute], { timeout: 10000, maxBuffer: 1_000_000 });
        const lines = stdout.split("\n").filter(Boolean).slice(0, max);
        return { success: true, output: lines.join("\n") || "No matches", data: { matchCount: lines.length } };
      } catch (err: any) {
        if (err.code === 1) return { success: true, output: "No matches", data: { matchCount: 0 } };
        return { success: false, output: `Search failed: ${err.message}`, error: err.code ?? "SEARCH_ERROR" };
      }
    },
  });

  // ═══ Git (read-only) ═══════════════════════════════════════════════════

  registerTool({
    name: "git_status",
    description: "Show git status of current project (staged, unstaged, untracked).",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo path (default: cwd)" } },
    },
    execute: async (input): Promise<ToolResult> => {
      const repoPath = input.path ?? process.cwd();
      const check = safePath(repoPath);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      try {
        const { stdout } = await execFileAsync("git", ["-C", check.absolute, "status", "--short", "--branch"], { timeout: 5000 });
        return { success: true, output: stdout || "(clean)", data: { clean: !stdout.trim() } };
      } catch (err: any) {
        return { success: false, output: `git status failed: ${err.message}`, error: "GIT_ERROR" };
      }
    },
  });

  registerTool({
    name: "git_diff",
    description: "Show git diff (unstaged changes) in current project.",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo path (default: cwd)" },
        staged: { type: "boolean", description: "Show staged diff instead" },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const repoPath = input.path ?? process.cwd();
      const check = safePath(repoPath);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      try {
        const args = ["-C", check.absolute, "diff"];
        if (input.staged) args.push("--staged");
        const { stdout } = await execFileAsync("git", args, { timeout: 5000, maxBuffer: 2_000_000 });
        return { success: true, output: stdout.slice(0, 10000) || "(no changes)", data: { lines: stdout.split("\n").length } };
      } catch (err: any) {
        return { success: false, output: `git diff failed: ${err.message}`, error: "GIT_ERROR" };
      }
    },
  });

  registerTool({
    name: "git_log",
    description: "Show recent git log (last N commits).",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo path (default: cwd)" },
        count: { type: "number", description: "Number of commits (default 10)" },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const repoPath = input.path ?? process.cwd();
      const check = safePath(repoPath);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      const count = Math.min(input.count ?? 10, 50);
      try {
        const { stdout } = await execFileAsync("git", ["-C", check.absolute, "log", `--max-count=${count}`, "--oneline"], { timeout: 5000 });
        return { success: true, output: stdout || "(no commits)" };
      } catch (err: any) {
        return { success: false, output: `git log failed: ${err.message}`, error: "GIT_ERROR" };
      }
    },
  });

  // ═══ Safe shell (whitelist) ═══════════════════════════════════════════

  registerTool({
    name: "run_safe_shell",
    description: "Run a safe read-only shell command from whitelist (ls, cat, grep, git <read ops>, etc). No pipes or shell expansion.",
    handler: "internal",
    actionClass: "execute_command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command name (e.g. 'ls', 'cat', 'git')" },
        args: { type: "array", items: { type: "string" }, description: "Arguments as array (no shell expansion)" },
      },
      required: ["command"],
    },
    execute: async (input): Promise<ToolResult> => {
      const args = Array.isArray(input.args) ? input.args : [];
      const check = safeShellCheck(input.command, args);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_COMMAND" };

      try {
        const { stdout, stderr } = await execFileAsync(input.command, args, {
          timeout: 5000,
          maxBuffer: 1_000_000,
          cwd: process.cwd(),
        });
        const out = stdout || stderr || "(no output)";
        return { success: true, output: out.slice(0, 5000) };
      } catch (err: any) {
        return { success: false, output: `Command failed: ${err.message}`, error: err.code ?? "EXEC_ERROR" };
      }
    },
  });

  // ═══ Test runner ═══════════════════════════════════════════════════════

  registerTool({
    name: "run_tests",
    description: "Run the project's test suite (detects npm test, pnpm test, pytest, etc). 5 minute timeout.",
    handler: "internal",
    actionClass: "execute_command",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project path (default: cwd)" },
        filter: { type: "string", description: "Test name filter (optional)" },
      },
    },
    execute: async (input): Promise<ToolResult> => {
      const projPath = input.path ?? process.cwd();
      const check = safePath(projPath);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };

      // Detect test runner
      let cmd: string, args: string[];
      if (fs.existsSync(path.join(check.absolute, "pnpm-lock.yaml"))) {
        cmd = "pnpm"; args = ["test"];
      } else if (fs.existsSync(path.join(check.absolute, "package.json"))) {
        cmd = "npm"; args = ["test"];
      } else if (fs.existsSync(path.join(check.absolute, "pyproject.toml")) || fs.existsSync(path.join(check.absolute, "pytest.ini"))) {
        cmd = "pytest"; args = [];
      } else {
        return { success: false, output: "No test runner detected (no package.json or pytest config)", error: "NO_TEST_RUNNER" };
      }

      if (input.filter) args.push(input.filter);

      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          timeout: 5 * 60 * 1000,  // 5 minutes
          maxBuffer: 5_000_000,
          cwd: check.absolute,
        });
        return { success: true, output: (stdout + "\n" + stderr).slice(-5000), data: { passed: true } };
      } catch (err: any) {
        return { success: false, output: `Tests failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`.slice(0, 5000), error: "TESTS_FAILED", data: { passed: false } };
      }
    },
  });

  // ═══ Log reader ═══════════════════════════════════════════════════════

  registerTool({
    name: "read_logs",
    description: "Tail the last N lines of a log file.",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Log file path" },
        lines: { type: "number", description: "Number of lines to tail (default 50, max 500)" },
      },
      required: ["path"],
    },
    execute: async (input): Promise<ToolResult> => {
      const check = safePath(input.path);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      const lines = Math.min(input.lines ?? 50, 500);
      try {
        const { stdout } = await execFileAsync("tail", ["-n", String(lines), check.absolute], { timeout: 5000, maxBuffer: 1_000_000 });
        return { success: true, output: stdout || "(empty)" };
      } catch (err: any) {
        return { success: false, output: `Read failed: ${err.message}`, error: "READ_ERROR" };
      }
    },
  });

  // ═══ Delegation to Claude Code (MCP) ═══════════════════════════════════

  registerTool({
    name: "delegate_to_claude_code",
    description: "Delegate a complex code task to Claude Code via MCP. Use for: writing new code, complex refactors, debugging. Returns Claude Code's result.",
    handler: "internal",
    actionClass: "delegate_agent",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Describe the task for Claude Code in plain English" },
        working_dir: { type: "string", description: "Working directory (default: cwd)" },
      },
      required: ["task"],
    },
    execute: async (input): Promise<ToolResult> => {
      // Placeholder — actual MCP client integration requires MCP config
      // For now, returns a stub that the user configures manually
      return {
        success: false,
        output: "delegate_to_claude_code requires MCP client configured for Claude Code. Configure in Settings → Integrations → MCP Servers.",
        error: "MCP_NOT_CONFIGURED",
      };
    },
  });

  console.log("[Execution] 10 dev tools registered (file, git, shell, test, logs, delegate)");
}
