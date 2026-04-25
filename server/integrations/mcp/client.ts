/**
 * MCP (Model Context Protocol) Client — inbound direction.
 *
 * Anchor acts as an MCP *client* and connects to external MCP *servers*.
 * Minimal implementation of the 2024-11-05 / 2025-11-25 spec covering:
 *   initialize   — handshake
 *   tools/list   — discover tools
 *   tools/call   — invoke a tool
 *
 * Transport: stdio only (local subprocess, newline-delimited JSON-RPC 2.0).
 * SSE / HTTP streamable-http can be added later; stdio covers Composio,
 * official server-filesystem/server-github, and most Mac-local MCP servers.
 *
 * We deliberately don't depend on @modelcontextprotocol/sdk: the protocol
 * surface we need is ~80 lines, and owning it keeps the subprocess supervision
 * tight (timeout, kill, reconnect) without leaking SDK assumptions.
 */
import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";

const PROTOCOL_VERSION = "2025-06-18";  // widely supported; servers negotiate down as needed
const CLIENT_INFO = { name: "anchor", version: "1.0" };

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface MCPCallResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | Record<string, any>>;
  isError?: boolean;
  structuredContent?: any;
}

export interface StdioConnectOpts {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

/**
 * One connected stdio MCP server. Lifecycle:
 *   new MCPClient() → connect() → listTools() / callTool() → disconnect()
 */
export class MCPClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private callTimeoutMs: number;
  public serverInfo: { name?: string; version?: string } = {};
  public capabilities: any = {};

  constructor(private opts: StdioConnectOpts) {
    super();
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    const timeout = this.opts.startupTimeoutMs ?? 15_000;
    this.proc = spawn(this.opts.command, this.opts.args, {
      env: { ...process.env, ...(this.opts.env ?? {}) },
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // MCP servers commonly write informational logs to stderr — capture
      // for debug but don't treat as errors unless exit code is non-zero.
      this.emit("stderr", chunk.toString());
    });
    this.proc.on("exit", (code) => {
      this.emit("exit", code);
      // Reject all pending on unexpected exit
      this.pending.forEach(({ reject, timer }) => {
        clearTimeout(timer);
        reject(new Error(`MCP subprocess exited with code ${code}`));
      });
      this.pending.clear();
    });
    this.proc.on("error", (err) => this.emit("error", err));

    // Handshake
    const initResult = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeout);

    this.serverInfo = initResult.serverInfo ?? {};
    this.capabilities = initResult.capabilities ?? {};

    // Notification — required by spec to finalize init
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<MCPCallResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result as MCPCallResult;
  }

  disconnect(): void {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill("SIGTERM"); } catch {}
    }
    this.proc = null;
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error("MCP client disconnected"));
    });
    this.pending.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.dispatchMessage(msg);
      } catch {
        // Ignore lines that aren't JSON — some servers emit banners
      }
    }
  }

  private dispatchMessage(msg: any): void {
    if (msg?.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`MCP ${msg.error.code ?? "?"}: ${msg.error.message ?? "unknown error"}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // Notifications from server (tools/list_changed, etc.) — surface as events
    if (msg?.method) this.emit("notification", msg);
  }

  private request(method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const ms = timeoutMs ?? this.callTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.proc || this.proc.killed || !this.proc.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("MCP subprocess not writable"));
        return;
      }
      this.proc.stdin.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: any): void {
    if (!this.proc || !this.proc.stdin?.writable) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(frame);
  }
}

/** Render an MCPCallResult back into the string shape Anchor's registry expects. */
export function flattenCallResult(r: MCPCallResult): { ok: boolean; text: string } {
  const parts = (r.content ?? []).map((c: any) => {
    if (c?.type === "text" && typeof c.text === "string") return c.text;
    if (c?.type === "image") return `[image ${c.mimeType ?? ""}, ${(c.data ?? "").length} bytes base64]`;
    return JSON.stringify(c);
  });
  return { ok: !r.isError, text: parts.join("\n") };
}
