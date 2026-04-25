# anchor-frontend

User-facing frontend for **Anchor** — personal AI OS. React + Vite + Tailwind + Wouter.

Talks to **`anchor-backend`** (`server/index.ts` on port `3001`).

## Pages

| Route | Page | Purpose |
|-------|------|---------|
| `/` → `/dashboard` | Onboarding / Dashboard | first-run flow, then human graph + state |
| `/advisor` | Advisor | conversational decision agent + plan confirmation |
| `/twin` | TwinAgent | digital twin profile + insights |
| `/memory` | Memory | episodic/semantic memory browser |
| `/workspace` | Workspace | projects + tasks |
| `/sessions` | Sessions | compiled-plan execution sessions (Phase 1-4 of #2) |
| `/sessions/:id` | SessionDetail | step-by-step progress + pause/resume/cancel/takeover |
| `/approvals` | Approvals | unified inbox for all pending decisions |
| `/agents` | Agents | custom + system agents |
| `/portrait` | PortraitCeremony | first-time Oracle Council reveal |
| `/scan` | Scan | cinematic Mac scan flow |
| `/settings` | Settings | preferences + integrations |
| `/graph/:id` | NodeDetail | drill-down on a graph node |

Admin pages (Cortex, Logs, Costs, Performance, Health, Runs, Jobs, Hooks, Missions, etc.) live in **`anchor-admin`** repo, not here.

## Quick start

```bash
pnpm install
pnpm dev                  # vite on :3000
```

Make sure `anchor-backend` is running on `:3001` (vite proxies `/api` and `/ws` to it).

## Build

```bash
pnpm run build            # outputs dist/
pnpm run preview          # serve dist on :3000
```

## What's inside

```
client/
├── index.html
├── public/
└── src/
    ├── App.tsx
    ├── main.tsx
    ├── index.css
    ├── pages/             ← user-facing pages (no admin)
    ├── components/
    │   ├── AppLayout.tsx  ← sidebar
    │   ├── ui/            ← shadcn-style components
    │   └── ...
    ├── hooks/             ← useWebSocket, etc
    ├── contexts/          ← ThemeContext
    └── lib/api.ts         ← all backend HTTP calls
```

## CORS / proxy

Vite dev server proxies `/api/*` and `/ws` to `localhost:3001`. In production you'd typically serve the built `dist/` from a static host and configure the same proxy at the edge (or run frontend behind same origin as backend).

## Related repos

- [`anchor`](https://github.com/123oqwe/anchor) — type contracts (spec)
- [`anchor-backend`](https://github.com/123oqwe/anchor-backend) — the server this frontend talks to
- [`anchor-admin`](https://github.com/123oqwe/anchor-admin) — admin panel UI (different proxy: `:3002`)
