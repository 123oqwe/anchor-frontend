/**
 * MCP stdio client — minimal JSON-RPC 2.0 over a child process's stdin/stdout.
 *
 * Why we roll our own instead of using @modelcontextprotocol/sdk:
 *   - Zero extra deps.
 *   - The wire protocol is line-delimited JSON-RPC 2.0 — a couple hundred lines.
 *   - Matches the "CLI + MCP separated, both real" brief.
 *
 * Server spec: https://modelcontextprotocol.io/specification/2024-11-05
 */
import { spawn, type ChildProcess } from "child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpCallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private lastUsedAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private spec: {
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
      idleTimeoutMs?: number;
      serverName: string;
    }
  ) {}

  isAlive(): boolean {
    return !!this.proc && !this.proc.killed && !this.closed;
  }

  /** Start the server and complete the MCP initialize handshake. */
  async start(): Promise<void> {
    if (this.isAlive()) return;
    this.closed = false;
    this.proc = spawn(this.spec.command, this.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.spec.env ?? {}) },
      cwd: this.spec.cwd,
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      // Log but don't fail — many MCP servers emit diagnostic output on stderr
      const text = chunk.toString().trim();
      if (text) console.error(`[MCP:${this.spec.serverName}] stderr: ${text.slice(0, 200)}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      console.log(`[MCP:${this.spec.serverName}] exited code=${code} signal=${signal}`);
      // Reject all pending
      this.pending.forEach(p => {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${this.spec.serverName} exited before reply`));
      });
      this.pending.clear();
    });
    this.proc.on("error", (err) => {
      console.error(`[MCP:${this.spec.serverName}] spawn error:`, err.message);
      this.closed = true;
    });

    // Initialize handshake (2024-11-05 protocol)
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "anchor-os", version: "1.0" },
    });

    // The spec says we should send an `initialized` notification after the response.
    this.notify("notifications/initialized");

    this.touch();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    // Line-delimited JSON-RPC
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
          else p.resolve(msg.result);
        }
        // else: server-initiated notifications — ignore for our one-way use
      } catch (err: any) {
        console.error(`[MCP:${this.spec.serverName}] invalid JSON line: ${line.slice(0, 200)}`);
      }
    }
  }

  private touch(): void {
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeout = this.spec.idleTimeoutMs ?? 5 * 60 * 1000;
    this.idleTimer = setTimeout(() => {
      const idleMs = Date.now() - this.lastUsedAt;
      if (idleMs >= timeout) {
        console.log(`[MCP:${this.spec.serverName}] idle ${Math.floor(idleMs / 1000)}s, shutting down`);
        this.close();
      }
    }, timeout + 100);
  }

  /** Send a request with a reply. */
  private request(method: string, params?: any, timeoutMs = 30_000): Promise<any> {
    if (!this.isAlive() || !this.proc?.stdin) {
      return Promise.reject(new Error(`MCP server ${this.spec.serverName} not alive`));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.proc!.stdin!.write(JSON.stringify(req) + "\n");
      this.touch();
    });
  }

  /** Fire-and-forget notification (no id). */
  private notify(method: string, params?: any): void {
    if (!this.isAlive() || !this.proc?.stdin) return;
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(req) + "\n");
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.request("tools/list");
    return res?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, any>, timeoutMs = 120_000): Promise<McpCallResult> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill("SIGTERM"); } catch {}
    }
    this.closed = true;
    this.proc = null;
  }
}
