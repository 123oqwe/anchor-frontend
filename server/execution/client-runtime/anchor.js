/**
 * Anchor runtime client — Node.js side.
 *
 * Spawned by execute_code. require("anchor") exposes:
 *   Bridge capabilities: email, calendar, browser, desktop, dev
 *   Kernel methods:      graph, memory, state, web, tasks, think
 *
 * Env set by execute_code:
 *   ANCHOR_BRIDGE_URL   — localhost URL to Anchor's bridge HTTP API
 *   ANCHOR_KERNEL_URL   — localhost URL to Anchor's kernel HTTP API
 *   ANCHOR_TOKEN        — scoped bearer token
 *   ANCHOR_WORKSPACE    — this agent's workspace dir
 */
const BRIDGE_URL = process.env.ANCHOR_BRIDGE_URL || "";
const KERNEL_URL = process.env.ANCHOR_KERNEL_URL || "";
const TOKEN = process.env.ANCHOR_TOKEN || "";
const workspace = process.env.ANCHOR_WORKSPACE || "";

async function _post(url, body) {
  if (!url || !TOKEN) throw new Error("Anchor env not set — not running under execute_code");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "non-JSON response" }));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || "unknown"}`);
  return data;
}

// ── Bridge ────────────────────────────────────────────────────────────────

async function dispatch(capability, input) {
  return _post(BRIDGE_URL + "/dispatch", { capability, input: input ?? {} });
}

async function listCapabilities() {
  const res = await fetch(BRIDGE_URL + "/capabilities", { headers: { "Authorization": "Bearer " + TOKEN } });
  return res.json();
}

// ── Kernel ────────────────────────────────────────────────────────────────

async function kernel(method, args) {
  const body = await _post(KERNEL_URL + "/kernel", { method, args: args ?? {} });
  if (!body.success) throw new Error(body.error || "kernel call failed");
  return body.result;
}

async function think(prompt, options = {}) {
  return kernel("think", { prompt, ...options });
}

// ── Parallel ──────────────────────────────────────────────────────────────

const BRIDGE_PREFIXES = /^(email|calendar|browser|desktop|dev)\./;

function routeCall(method, args) {
  return BRIDGE_PREFIXES.test(method) ? dispatch(method, args) : kernel(method, args);
}

async function parallel(specs) {
  if (!Array.isArray(specs)) throw new Error("parallel() requires array of [method, args] pairs");
  return Promise.all(specs.map(([method, args]) => routeCall(method, args ?? {})));
}

// ── Namespace proxies ─────────────────────────────────────────────────────

function bridgeNs(prefix) {
  return new Proxy({}, {
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      return (input) => dispatch(`${prefix}.${name}`, input);
    },
  });
}

function kernelNs(prefix) {
  return new Proxy({}, {
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      return (args) => kernel(`${prefix}.${name}`, args);
    },
  });
}

module.exports = {
  dispatch, listCapabilities, kernel, think, parallel, workspace,
  // Bridge
  email:    bridgeNs("email"),
  calendar: bridgeNs("calendar"),
  browser:  bridgeNs("browser"),
  desktop:  bridgeNs("desktop"),
  dev:      bridgeNs("dev"),
  // Kernel
  graph:      kernelNs("graph"),
  memory:     kernelNs("memory"),
  state:      kernelNs("state"),
  web:        kernelNs("web"),
  tasks:      kernelNs("tasks"),
  blackboard: kernelNs("blackboard"),  // mission-scoped, shared across agents
};
