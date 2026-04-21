# Anchor Cloud Phase 2 — Architecture Plan

**Status:** design doc only, not yet implemented. Scope rough-sized at 6-8 engineering weeks plus auth/billing/legal.

## Why cloud

Current Anchor is local-only. That's correct for Phase 1 — it proves Anchor's identity (runs on your actual Mac, touches your real apps) without cloud infra overhead. But it caps the product at three meaningful limits:

1. **Cron dies when Mac sleeps.** Scheduled agents miss fires. Tailscale / launchd workarounds help but don't solve it — your MacBook is closed during meetings.
2. **No multi-device.** Agent defs, task brain state, skills all live in one SQLite file. If you have a Mac mini + MacBook, they don't share.
3. **No remote management.** You can't edit agents, watch runs, or intervene from your phone on the subway. The Anchor app is Mac-bound.

Meanwhile: **Anchor must stay local-first**. Apple Mail / Calendar / Chrome profile / Finder workspaces are non-negotiable. Moving execution to the cloud = becoming Manus, which is losing the whole positioning. The answer is **cloud brain, local hand** — the same architecture as GitHub Actions self-hosted runners and Tailscale.

## High-level topology

```
┌───────── CLOUD (brain.anchor.ai) ─────────────────────┐
│                                                        │
│  Cloudflare Workers (edge, global)                     │
│  ├─ Auth (Clerk / WorkOS) — device pairing + sessions  │
│  ├─ Task Brain proxy (D1 mirror of agent_jobs)         │
│  ├─ Cron scheduler (always-on, APNs wake)              │
│  ├─ Agent registry (cloud-authoritative definitions)   │
│  ├─ LLM router (cloud holds API keys, never device)    │
│  ├─ Web UI (manage agents from phone / iPad)           │
│  └─ Per-device Durable Object = WebSocket endpoint     │
│                                                        │
└──────────────────────────┬─────────────────────────────┘
                           │ persistent WebSocket
                           │ (device → cloud outbound, solves NAT)
          ┌────────────────┼────────────────┐
          │                │                │
  ┌───────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
  │ Mac Desktop  │  │ MacBook     │  │ iPad (view) │
  │ Anchor runner│  │ Anchor runner  │  │ Web client  │
  │ Bridge local │  │ Bridge local   │  │ no runner   │
  │ execute_code │  │ execute_code   │  │             │
  │ Graph DB     │  │ Graph DB sync  │  │             │
  └──────────────┘  └─────────────┘  └─────────────┘
```

## What lives where

| Responsibility | Cloud | Local |
|---|---|---|
| Cron scheduling | **yes** — never sleeps | no |
| Agent definitions | **yes** (authoritative) | yes (cached for offline) |
| LLM inference | **yes** (cloud holds API keys) | no (device never sees key) |
| Task Brain ledger | **mirrored** both | yes |
| ReAct loop iteration | **yes** (each step dispatches tool to device) | no |
| Bridge (Apple Mail, Calendar, Chrome profile) | no | **yes** — this is the whole point |
| execute_code subprocess | no | **yes** |
| Graph / Memory | sync opt-in | **yes** (privacy default) |
| Workspace files | no | **yes** (real `~/Documents/Anchor/`) |
| Web UI for phone/iPad | **yes** | no (already local UI on Mac) |

## The key mechanism — persistent WebSocket

Device boots → Anchor runner opens outbound WebSocket to `wss://brain.anchor.ai/v1/device/{deviceId}`. This solves NAT / firewalls (same pattern as Slack, Discord, GitHub Actions runner). The Cloudflare Durable Object instance for this device sits there waiting.

When cloud needs to dispatch work:

```
Cloud cron fires at 9am for "Weekly Digest" agent
  → Task Brain enqueues cloud-side job
  → Router selects this user's primary device (Mac Desktop, online)
  → Pushes "run agent X with input Y" over that device's WebSocket
  → Device's Anchor runner receives, invokes runCustomAgentReAct locally
  → Each tool_use in the ReAct loop is dispatched:
      - Bridge call → local execution, result streams back
      - LLM inference → back to cloud (cloud owns the API key)
  → Full trace streams to cloud for UI viewing
```

## Offline behavior

- **Cloud down:** runner falls back to local-only mode (current P1-P8 behavior). Local cron still fires via user-cron-runtime.ts. User notices nothing except "web UI unreachable".
- **Device offline:** cloud queues jobs in its Task Brain. When device reconnects, it pulls pending jobs and runs them.
- **Both online:** cloud is authoritative for cron + agent defs; local is authoritative for Bridge + execute_code.

## Phase 2 interfaces (already stubbed in P1)

The three swap points were designed in `server/execution/interfaces.ts`:

```typescript
interface JobSource {
  nextJob(): Promise<Job | null>;
  reportResult(result: JobResult): Promise<void>;
}

interface AgentRegistry {
  getAgent(id: string): Promise<AgentDef | null>;
  listAgents(userId: string): Promise<AgentDef[]>;
}

interface LlmRouter {
  call(opts: LlmCallOpts): Promise<LlmCallResult>;
}
```

Phase 1 uses `LocalDbJobSource`, `LocalAgentRegistry`, `LocalLlmRouter`. Phase 2 adds `CloudWebSocketJobSource`, `CloudSyncAgentRegistry`, `CloudProxyLlmRouter`. **The runner code (ReAct loop, execute_code, Bridge dispatch) doesn't change.** That's the whole point of those interfaces.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Edge API | Cloudflare Workers | Scale-to-zero, global, WS-native |
| Database | Cloudflare D1 (SQLite-compat) | Migration from local SQLite = zero schema change |
| Per-device state | Cloudflare Durable Objects | One object per device, persistent WS |
| Auth | Clerk or WorkOS | OAuth + device pairing, don't rebuild |
| Device runner | Tauri app | Menu-bar on Mac, 10x smaller than Electron |
| Device updates | Tauri updater | Push new builds automatically |
| Observability | Cloudflare Analytics + Langfuse | Trace viewer already planned |
| Billing | Stripe usage-based | LLM consumption + per-device tier |

## Rough delivery plan

- **Week 1-2:** auth + device pairing + outbound WebSocket connection from Mac runner. Cloud UI skeleton.
- **Week 3-4:** Task Brain mirror in D1. CloudWebSocketJobSource impl.
- **Week 5:** CloudProxyLlmRouter + billing metering.
- **Week 6:** CloudSyncAgentRegistry + phone/iPad web UI. Read-only at first.
- **Week 7:** Write-through from web UI (edit agent → syncs to device). APNs wake.
- **Week 8:** Pre-launch QA + privacy audit + docs.

**Not in Phase 2:**
- Multi-user collaboration
- Graph sync between devices (Phase 3)
- Desktop Windows/Linux runner (Phase 3)

## Why not now

1. **Not validated yet.** P1-P12 make Anchor powerful locally but usage isn't proven. Cloud infra burns money + time only to serve no users.
2. **Cost of wrong architecture.** Picking Cloudflare vs Supabase vs self-hosted is a one-way door after the first 100 users. Wait for signal before committing.
3. **Billing / LLM-key management.** Once we proxy LLM calls, users expect subscription / usage caps. That's product work, not infra.
4. **Privacy story.** Graph / memory opt-in sync needs legal review. Not to be rushed.

**Trigger to start:** when the local product has 20+ daily active users who've asked for cron reliability or cross-device in unsolicited feedback.

## What's ready for Phase 2 today (no extra work)

- `JobSource` / `AgentRegistry` / `LlmRouter` interfaces — cloud impls drop in
- Bridge HTTP API at `/local/bridge/dispatch` — already localhost-scoped, token-auth'd; swap tokens for cloud-issued ones
- `agent_jobs` schema + state machine — migration-compatible with D1
- Agent token HMAC — same pattern works for cloud-issued device auth
- WebSocket infra exists in `server/index.ts` (currently used for bus events to frontend — expand to cloud)

## Open design questions (decide during Phase 2 kickoff)

- **Conflict resolution when Mac + iPad edit same agent?** Last-write-wins vs CRDT vs reject. Probably LWW given agent definition is small.
- **LLM API key BYOK option?** Let advanced users bring their own Anthropic key to skip billing. Complicates router but gives trust control.
- **Per-device scope vs per-user?** One cloud account, N devices. Each device gets its own WS. Mirror the GitHub Actions multi-runner model.
- **Graph sync granularity?** Full snapshot, per-node replication, or only insights? Phase 3 decision.
