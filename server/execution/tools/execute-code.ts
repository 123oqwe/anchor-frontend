/**
 * execute_code — run Python/Node/bash in the agent's own workspace on the
 * user's real Mac. Bridge access via localhost HTTP + scoped token.
 *
 * This replaces the old `run_code` tool which used `new Function()` with a
 * forbidden-word denylist — that was a toy, not a tool. This is the real
 * thing: subprocess, real filesystem, real bridge access.
 *
 * Design decisions:
 *   • cwd = per-agent workspace (~/Documents/Anchor/agents/<name>/) — user
 *     can see what the agent is doing in Finder.
 *   • env includes ANCHOR_BRIDGE_URL + ANCHOR_TOKEN (10-min HMAC-scoped).
 *   • PYTHONPATH/NODE_PATH point at our client-runtime dir so `import anchor`
 *     / `require("anchor")` just works.
 *   • 2-min timeout. stdout/stderr captured. Exit code surfaced.
 *   • NO Docker. This is Anchor's whole point — runs on the user's actual
 *     machine with access to their actual apps via the Bridge proxy.
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { registerTool, type ToolResult } from "../registry.js";
import { ensureWorkspace } from "../workspace.js";
import { mintToken } from "../agent-tokens.js";
import { localAgentRegistry } from "../local-impl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_RUNTIME_DIR = path.resolve(__dirname, "..", "client-runtime");

const EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 8000;

function bridgeUrl(): string {
  const port = process.env.PORT || "3001";
  return `http://127.0.0.1:${port}/local/bridge`;
}

function kernelUrl(): string {
  const port = process.env.PORT || "3001";
  return `http://127.0.0.1:${port}/local/anchor`;
}

export function registerExecuteCodeTool(): void {
  registerTool({
    name: "execute_code",
    description:
      "Run Python, Node.js, or bash code in your workspace on the user's Mac. " +
      "Python: `import anchor` exposes bridge (email, calendar, browser, desktop, dev). " +
      "Node: `const anchor = require('anchor')`. " +
      "cwd is your agent workspace at ~/Documents/Anchor/agents/<name>/ — files you write land there (user sees them in Finder). " +
      "Prefer this over many individual tool calls: write one code block that calls multiple bridge capabilities. " +
      "2-min timeout. Return files by writing to workspace and including the path in stdout.",
    handler: "code",
    actionClass: "write_memory",
    inputSchema: {
      type: "object",
      properties: {
        lang: { type: "string", enum: ["python", "node", "bash"], description: "Language to execute" },
        code: { type: "string", description: "Code to run" },
      },
      required: ["lang", "code"],
    },
    execute: async (input, ctx): Promise<ToolResult> => {
      const agentId = ctx?.agentId;
      if (!agentId) return {
        success: false, output: "execute_code requires agent context (must be called from a custom agent run)",
        error: "NO_AGENT_CONTEXT",
      };

      const agent = await localAgentRegistry.getAgent(agentId);
      if (!agent) return { success: false, output: "Agent not found", error: "AGENT_NOT_FOUND" };

      const workspace = ensureWorkspace(agent.name);
      const token = mintToken({
        agentId: agent.id,
        agentName: agent.name,
        runId: ctx?.runId ?? "no-run",
        allowedBridges: agent.allowedBridges,
      });

      const cmd = input.lang === "python" ? "python3"
                : input.lang === "node"   ? "node"
                : "bash";

      const args =
        input.lang === "bash"   ? ["-c", input.code]
      : input.lang === "python" ? ["-c", input.code]
      :                           ["-e", input.code];

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        ANCHOR_BRIDGE_URL: bridgeUrl(),
        ANCHOR_KERNEL_URL: kernelUrl(),
        ANCHOR_TOKEN: token,
        ANCHOR_AGENT_ID: agent.id,
        ANCHOR_AGENT_NAME: agent.name,
        ANCHOR_RUN_ID: ctx?.runId ?? "",
        ANCHOR_WORKSPACE: workspace,
        // Make `import anchor` / `require("anchor")` resolve to our client runtime
        PYTHONPATH: CLIENT_RUNTIME_DIR + (process.env.PYTHONPATH ? ":" + process.env.PYTHONPATH : ""),
        NODE_PATH: CLIENT_RUNTIME_DIR + (process.env.NODE_PATH ? ":" + process.env.NODE_PATH : ""),
      };

      return new Promise<ToolResult>((resolve) => {
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(cmd, args, { cwd: workspace, env, timeout: EXEC_TIMEOUT_MS });
        } catch (err: any) {
          resolve({
            success: false,
            output: `Failed to spawn ${cmd}: ${err.message}. ${cmd === "python3" ? "Install Python 3." : ""}`,
            error: "SPAWN_FAILED",
          });
          return;
        }

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (d) => { stdout += d.toString("utf-8"); });
        proc.stderr?.on("data", (d) => { stderr += d.toString("utf-8"); });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { proc.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
        }, EXEC_TIMEOUT_MS);

        proc.on("close", (code, signal) => {
          clearTimeout(timer);
          const tail = (stdout + (stderr ? "\n--- stderr ---\n" + stderr : "")).slice(-MAX_OUTPUT_CHARS);
          if (timedOut) {
            resolve({
              success: false,
              output: (tail || "") + `\n[killed after ${EXEC_TIMEOUT_MS / 1000}s timeout]`,
              error: "TIMEOUT",
            });
            return;
          }
          if (code === 0) {
            resolve({
              success: true,
              output: tail || "(no output)",
              data: { exitCode: 0, workspace, lang: input.lang },
            });
          } else {
            resolve({
              success: false,
              output: tail || `(no output; exit code ${code}${signal ? `, signal ${signal}` : ""})`,
              error: `EXIT_${code ?? "UNKNOWN"}`,
              data: { exitCode: code, signal, workspace },
            });
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            success: false,
            output: `Process error: ${err.message}`,
            error: "PROC_ERROR",
          });
        });
      });
    },
  });
}
