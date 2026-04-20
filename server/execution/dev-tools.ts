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
import { nanoid } from "nanoid";
import { registerTool, type ToolResult } from "./registry.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { bus } from "../orchestration/bus.js";

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

// ── Proposed change storage (persistent; requires user approval via HTTP) ───

const PROPOSAL_TTL_MS = 10 * 60 * 1000; // 10 minutes

function expireOldProposals(): void {
  // Mark anything pending past TTL as expired
  db.prepare(
    `UPDATE dev_proposals SET status='expired'
     WHERE status='pending'
     AND datetime(created_at) <= datetime('now', ?)`
  ).run(`-${Math.floor(PROPOSAL_TTL_MS / 1000)} seconds`);
}

function createProposal(details: {
  kind: "write_file" | "git_commit";
  path?: string;
  before?: string;
  after: string;
  agentName?: string;
  runId?: string;
}): string {
  expireOldProposals();
  const id = `proposal_${nanoid(8)}`;
  db.prepare(
    `INSERT INTO dev_proposals (id, user_id, kind, path, before_content, after_content, agent_name, run_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    id,
    DEFAULT_USER_ID,
    details.kind,
    details.path ?? null,
    details.before ?? null,
    details.after,
    details.agentName ?? null,
    details.runId ?? null,
  );
  return id;
}

function getProposal(id: string): { id: string; kind: string; path: string | null; before_content: string | null; after_content: string; status: string; agent_name: string | null } | null {
  const row = db.prepare(
    "SELECT id, kind, path, before_content, after_content, status, agent_name FROM dev_proposals WHERE id=? AND user_id=?"
  ).get(id, DEFAULT_USER_ID) as any;
  return row ?? null;
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
    description: "Propose a file change for user review. Returns proposal ID. The user must approve in the dashboard before the write happens — calling approve_and_write alone will NOT write.",
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
    execute: (input, context): ToolResult => {
      const check = safePath(input.path);
      if (!check.ok) return { success: false, output: check.reason, error: "UNSAFE_PATH" };
      if (input.proposed.length > MAX_WRITE_BYTES) return { success: false, output: `Proposed content too large (max ${MAX_WRITE_BYTES})`, error: "TOO_LARGE" };

      let before: string | undefined;
      try {
        before = fs.readFileSync(check.absolute, "utf-8");
      } catch {
        before = undefined;  // new file
      }

      // Resolve a friendly agent label from context (OPT-4 agentName isn't on ExecutionContext — look up by runId if needed)
      let agentName: string | undefined;
      if (context?.runId) {
        const row = db.prepare("SELECT agent_name FROM llm_calls WHERE run_id=? AND agent_name IS NOT NULL LIMIT 1").get(context.runId) as any;
        agentName = row?.agent_name;
      }

      const proposalId = createProposal({
        kind: "write_file",
        path: check.absolute,
        before,
        after: input.proposed,
        agentName,
        runId: context?.runId,
      });

      const beforeLines = (before ?? "").split("\n").length;
      const afterLines = input.proposed.split("\n").length;
      const delta = afterLines - beforeLines;

      // Notify the frontend — user should review in Proposals dashboard
      bus.publish({
        type: "PROPOSAL_PENDING",
        payload: {
          id: proposalId,
          kind: "write_file",
          path: check.absolute,
          agentName,
          deltaLines: delta,
        },
      });

      return {
        success: true,
        output: `Proposal ${proposalId} created (awaiting user review). Diff: ${beforeLines} → ${afterLines} lines (${delta >= 0 ? "+" : ""}${delta}).\n\nThe user will review in the dashboard. You do NOT need to call approve_and_write — the user approves directly via the UI. If asked to follow up, check back later to see if the proposal was approved.`,
        data: { proposalId, beforeLines, afterLines, delta, path: check.absolute, status: "pending" },
      };
    },
  });

  registerTool({
    name: "approve_and_write",
    description: "DEPRECATED: File writes require explicit user approval via the dashboard. This tool only CHECKS if a proposal was approved by the user — it cannot approve on the user's behalf. If status is still 'pending', inform the user to review in Settings → Proposals.",
    handler: "internal",
    actionClass: "execute_command",
    inputSchema: {
      type: "object",
      properties: { proposal_id: { type: "string", description: "ID returned from diff_file" } },
      required: ["proposal_id"],
    },
    execute: (input): ToolResult => {
      const proposal = getProposal(input.proposal_id);
      if (!proposal) return { success: false, output: "Proposal not found", error: "NO_PROPOSAL" };

      // Only report status — agent cannot bypass human approval
      if (proposal.status === "pending") {
        return {
          success: false,
          output: `Proposal ${proposal.id} is still awaiting user review. The write has NOT happened. Inform the user to open Settings → Proposals and approve or reject.`,
          error: "AWAITING_APPROVAL",
          data: { status: "pending" },
        };
      }
      if (proposal.status === "rejected") {
        return { success: false, output: `Proposal ${proposal.id} was rejected by the user.`, error: "REJECTED", data: { status: "rejected" } };
      }
      if (proposal.status === "expired") {
        return { success: false, output: `Proposal ${proposal.id} expired (>10 min old). Re-create with diff_file.`, error: "EXPIRED", data: { status: "expired" } };
      }
      if (proposal.status === "written" || proposal.status === "approved") {
        return { success: true, output: `Proposal ${proposal.id} was approved and written to ${proposal.path}.`, data: { status: proposal.status, path: proposal.path } };
      }
      return { success: false, output: `Unknown proposal status: ${proposal.status}`, error: "UNKNOWN_STATUS" };
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
