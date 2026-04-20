"""
Anchor runtime client — Python side.

Imported by subprocess spawned by execute_code. Exposes:
  • Bridge capabilities (physical world): email, calendar, browser, desktop, dev
  • Kernel methods (Anchor's internals): graph, memory, state, web, tasks, think

Reads token + URL from env (set by execute_code when spawning):
  ANCHOR_BRIDGE_URL       — e.g. http://127.0.0.1:3001/local/bridge
  ANCHOR_KERNEL_URL       — e.g. http://127.0.0.1:3001/local/anchor
  ANCHOR_TOKEN            — HMAC-signed bearer scoped to (agent, run, capabilities)
  ANCHOR_WORKSPACE        — this agent's workspace directory (also your cwd)

Typical PTC usage — one code block, many ops:

  import anchor

  people = anchor.graph.query(query="active", limit=5)
  for p in people:
      mems = anchor.memory.search(query=p["label"], limit=3)
      summary = anchor.think(prompt=f"Summarize: {mems}", maxTokens=200)
      anchor.state.set(key=f"summary:{p['id']}", value=summary["answer"])

  # Fan out in parallel:
  results = anchor.parallel([
      ("web.search", {"query": "competitor A"}),
      ("web.search", {"query": "competitor B"}),
      ("web.search", {"query": "competitor C"}),
  ])
"""
import os
import json
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

_BRIDGE_URL = os.environ.get("ANCHOR_BRIDGE_URL", "")
_KERNEL_URL = os.environ.get("ANCHOR_KERNEL_URL", "")
_TOKEN = os.environ.get("ANCHOR_TOKEN", "")
workspace = os.environ.get("ANCHOR_WORKSPACE", "")


class AnchorError(Exception):
    pass


def _post(url: str, body: dict, timeout: int = 60) -> dict:
    if not url or not _TOKEN:
        raise AnchorError("Anchor env not set — not running under execute_code")
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + _TOKEN,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        payload = e.read()
        try: detail = json.loads(payload)
        except Exception: detail = {"error": payload.decode("utf-8", "replace")}
        raise AnchorError(f"HTTP {e.code}: {detail.get('error', 'unknown')}")


def _get(url: str, timeout: int = 10) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _TOKEN})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


# ── Bridge capabilities (physical world) ────────────────────────────────────

def dispatch(capability: str, **inputs):
    """Call a bridge capability. Returns dict with success/output/data/error."""
    return _post(_BRIDGE_URL + "/dispatch", {"capability": capability, "input": inputs})


def list_capabilities():
    """Bridge capabilities this agent is allowed to call."""
    return _get(_BRIDGE_URL + "/capabilities")


# ── Kernel methods (Anchor internals) ───────────────────────────────────────

def kernel(method: str, **args):
    """Call a kernel method (graph/memory/state/web/tasks/think). Returns result field."""
    body = _post(_KERNEL_URL + "/kernel", {"method": method, "args": args})
    if not body.get("success"):
        raise AnchorError(body.get("error", "kernel call failed"))
    return body.get("result")


def think(prompt: str, system: str = None, maxTokens: int = 500):
    """Sub-LLM call from agent code. Capped at 5 per run. Use sparingly."""
    args = {"prompt": prompt, "maxTokens": maxTokens}
    if system is not None:
        args["system"] = system
    return kernel("think", **args)


# ── Parallel fan-out ────────────────────────────────────────────────────────

_BRIDGE_PREFIXES = ("email.", "calendar.", "browser.", "desktop.", "dev.")

def _route_call(method: str, args: dict):
    if method.startswith(_BRIDGE_PREFIXES):
        return dispatch(method, **args)
    return kernel(method, **args)


def parallel(specs, max_workers: int = 8):
    """
    Run multiple bridge/kernel calls concurrently. Order of results matches
    order of specs. Each spec is a (method, args_dict) tuple.

    Example:
      anchor.parallel([
          ("graph.query", {"query": "active"}),
          ("memory.search", {"query": "meetings"}),
          ("email.send",   {"to": "x@y.com", "subject": "hi", "body": "..."}),
      ])
    """
    if not isinstance(specs, (list, tuple)):
        raise AnchorError("parallel() requires list of (method, args) tuples")
    max_workers = max(1, min(int(max_workers), 16))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        def run(spec):
            if isinstance(spec, (list, tuple)) and len(spec) == 2:
                return _route_call(str(spec[0]), dict(spec[1] or {}))
            raise AnchorError(f"Bad spec: {spec!r} — want (method, args)")
        return list(ex.map(run, specs))


# ── Namespaces — anchor.email.send(...) etc. ────────────────────────────────

class _BridgeNs:
    def __init__(self, prefix: str): self._p = prefix
    def __getattr__(self, name: str):
        cap = f"{self._p}.{name}"
        def call(**kwargs): return dispatch(cap, **kwargs)
        return call


class _KernelNs:
    def __init__(self, prefix: str): self._p = prefix
    def __getattr__(self, name: str):
        method = f"{self._p}.{name}"
        def call(**kwargs): return kernel(method, **kwargs)
        return call


# Bridge namespaces
email = _BridgeNs("email")
calendar = _BridgeNs("calendar")
browser = _BridgeNs("browser")
desktop = _BridgeNs("desktop")
dev = _BridgeNs("dev")

# Kernel namespaces
graph = _KernelNs("graph")
memory = _KernelNs("memory")
state = _KernelNs("state")
web = _KernelNs("web")
tasks = _KernelNs("tasks")
