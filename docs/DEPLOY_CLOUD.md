# Anchor Cloud Relay — Deployment

Single-user MVP that makes Anchor reachable from phone/web and lets cron fire
when Mac sleeps. Cloud is a thin relay — all real work still runs on your
own devices (Macs + future Linux/Windows runners). This doc walks through
deploying the relay and pointing a runner at it.

## Architecture recap

- **Cloudflare Worker** at `worker/` serves:
  - `wss://YOUR-DOMAIN/ws/device/:id` — runners (and viewers) connect here
  - `https://YOUR-DOMAIN/api/*` — HTTP API for mobile web UI
  - `https://YOUR-DOMAIN/` — static mobile UI (from `worker/public/`)
  - Durable Object state holds device records + job history (survives redeploys)
- **Mac / Linux runner** opens outbound WebSocket on boot if `ANCHOR_CLOUD_URL` is set
- **Phone/iPad** = browser that loads the mobile UI, no runner

## First-time deploy

You need: a Cloudflare account (free tier is fine), Wrangler CLI.

```bash
cd worker
pnpm install
npx wrangler login                              # opens browser to log in
# generate a random bearer token for single-user auth
openssl rand -hex 24 > /tmp/anchor-token
cat /tmp/anchor-token
npx wrangler secret put AUTH_TOKEN < /tmp/anchor-token
npx wrangler deploy
```

Wrangler prints something like `Published anchor-cloud (1.x.x) at
https://anchor-cloud.<your-subdomain>.workers.dev`. Save that URL.

Optional: bind a custom domain via Cloudflare dashboard (`anchor.<yourdomain>`).

## Point the Mac runner at it

Add to your `.env`:

```bash
# .env
ANCHOR_CLOUD_URL=wss://anchor-cloud.your-subdomain.workers.dev
ANCHOR_CLOUD_TOKEN=<paste the bearer token from /tmp/anchor-token>
ANCHOR_DEVICE_ID=mac-desktop-home
ANCHOR_DEVICE_PRIMARY=true
```

Then start Anchor as usual (`pnpm server`). You should see:

```
☁️  Cloud Relay started — deviceId="mac-desktop-home" primary=true → wss://...
[CloudRelay] connected
```

Visit `https://anchor-cloud.your-subdomain.workers.dev/?token=YOUR_TOKEN` on
your phone. Token gets saved to localStorage so future visits just need the
bare URL.

## Adding another device (2nd Mac, Linux, etc.)

On the second machine: same install as Phase 1 Anchor (`pnpm install`,
`.env` configured). Set:

```bash
ANCHOR_CLOUD_URL=wss://...                      # same URL
ANCHOR_CLOUD_TOKEN=<same token>
ANCHOR_DEVICE_ID=mac-laptop-travel              # unique per device
ANCHOR_DEVICE_PRIMARY=false                     # so the desktop wins routing
```

Start. The cloud relay now sees both devices in `/api/devices`. Routing
picks primary first; if offline, falls back to secondary. Capability-aware
routing means an email.send will prefer whichever device has
`applemail-applescript` or `gmail-rest` online.

## Local dev (no Cloudflare needed)

```bash
# terminal 1 — cloud worker locally on port 8787
cd worker && pnpm dev

# terminal 2 — anchor pointed at local cloud
ANCHOR_CLOUD_URL=ws://127.0.0.1:8787 pnpm server

# terminal 3 — browse mobile UI at http://127.0.0.1:8787/
```

No AUTH_TOKEN needed in local dev (the env var is unset, so the Worker
skips auth).

## Verifying it works

From phone / laptop at the cloud URL:

1. **Devices** section shows your runner(s) online with platform + bridge count
2. **Agents** lists agents that exist on any connected runner
3. Tap an agent → type a message → **Run** → job should show up in **Recent jobs**
   transitioning `pending → claimed → running → succeeded`

If the device stays offline: check Mac runner console for `[CloudRelay]`
messages. Common issues:

- `unauthorized` → token mismatch; check ANCHOR_CLOUD_TOKEN matches what
  `wrangler secret put` set
- Connection hangs → firewall blocking outbound WSS; try ws:// for local test
- Device shows online but `/api/run` says "No runner online" → check
  heartbeats are firing (logs every 30s)

## What's intentionally NOT there yet

- **Multi-user / team** — single-account single-token. Add Clerk/WorkOS when
  needed.
- **LLM proxy** — each runner calls LLM with its own API key. Cloud doesn't
  see your prompts.
- **Graph / memory sync** — stays local, opt-in in Phase 3.
- **Cloud cron** — cloud tick is stubbed but currently doesn't fire jobs
  (local cron still runs). Enable cloud-backup cron in Phase 2.5 once the
  idempotency story is nailed.
- **Tauri packaging** — runner is still `pnpm server`. Tauri wrapper with
  auto-update is a separate project.

## Cost

Free tier on Cloudflare Workers covers this single-user MVP: 100k requests/day,
10ms CPU per request. Durable Object usage is negligible at single-user.
Expect **$0–5/month** unless you're dispatching thousands of jobs.
