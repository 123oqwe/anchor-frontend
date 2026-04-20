/**
 * Per-agent workspace directory — ~/Documents/Anchor/agents/<name>/
 *
 * Design: make workspaces USER-VISIBLE. When a Custom Agent writes files during
 * execute_code, they land in a real folder the user can open in Finder. This is
 * the opposite of Manus-style cloud sandboxes where artifacts live in some
 * opaque container path — Anchor wants you to see what your agent is doing.
 *
 * Safety: cwd-scoping alone is not a sandbox. Code inside the subprocess can
 * still reach outside its cwd unless we add macOS sandbox-exec or similar later.
 * For Phase 1 we rely on: (a) explicit agent workspace cwd, (b) scoped bridge
 * token, (c) subprocess timeout, (d) audit log. Good enough for user-defined
 * trusted agents.
 */
import os from "os";
import path from "path";
import fs from "fs";

const ROOT = path.join(os.homedir(), "Documents", "Anchor", "agents");

/** Sanitize a name into a filesystem-safe folder name. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "-");
  return cleaned.slice(0, 64) || "unnamed-agent";
}

/** Ensure the workspace exists and return its absolute path. */
export function ensureWorkspace(agentName: string): string {
  const dir = path.join(ROOT, safeName(agentName));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    const readme = [
      `# ${agentName}`,
      ``,
      `This folder is the workspace for your Anchor agent **${agentName}**.`,
      ``,
      `Anything the agent writes during \`execute_code\` calls (analysis output,`,
      `generated files, logs) lands here. You can drop files in manually too —`,
      `the agent can read them.`,
      ``,
      `_Created by Anchor on ${new Date().toISOString()}._`,
      ``,
    ].join("\n");
    try { fs.writeFileSync(path.join(dir, "README.md"), readme); } catch {}
  }
  return dir;
}

/** Return the path without creating it. */
export function workspacePath(agentName: string): string {
  return path.join(ROOT, safeName(agentName));
}

/** Root dir holding all agent workspaces (for admin UI / debugging). */
export function workspaceRoot(): string {
  return ROOT;
}
