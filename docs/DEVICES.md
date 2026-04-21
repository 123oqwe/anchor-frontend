# Anchor Devices — Multi-device Design

Anchor is one brain across many devices. Each device connects independently
to the cloud relay, declares what it can do, and the cloud routes tasks to
whichever device can actually perform them. This doc describes the device
model you get for free by using `ANCHOR_CLOUD_URL`.

## Device kinds

**Runner** — full Anchor instance that executes agents. Any platform (darwin /
linux / future win32). Declares its bridge capabilities on connect. Can run
`execute_code`, call the Bridge, host workspaces.

**Viewer** — no Anchor runtime. Just views jobs and triggers agents over HTTP.
Today the only viewer is the mobile web UI in `worker/public/`. Could be a
native iOS/Android app later (same `/api/run` shape).

## Capability-aware routing

Each runner's `hello` message declares `bridges` as a map from capability name
to the list of providers it can offer for that capability:

```json
{
  "email.send": ["applemail-applescript", "gmail-rest"],
  "calendar.create_event": ["applecalendar-applescript"],
  "browser.navigate": ["playwright-cli"],
  "browser.session": ["playwright-mcp"],
  "dev.delegate": ["claude-cli"],
  "desktop.automate": ["macos-vision"]
}
```

Cloud routing logic when a job needs `email.send`:

1. Filter to runners where `bridges["email.send"]` is non-empty and online
2. Prefer `preferences.primary: true`
3. Tiebreak by oldest connection (most stable)
4. Fall back to "any online runner" if the specific capability isn't gated
5. Queue for later if no one is online + wake the next device that connects

Practical effect: add a Linux box with `playwright-cli` only → jobs needing
`browser.navigate` will prefer the Mac (if online) but route to Linux
automatically when your Mac is asleep.

## Deciding primary

Set `ANCHOR_DEVICE_PRIMARY=true` on exactly one device (usually your main
Mac). It wins routing ties. Other devices default to false.

Why expose this? Because for Anchor-specific tasks (Apple Mail, Chrome
profile), your primary Mac has real accounts logged in. Travel MacBook or
Linux runner can still handle capability-clean tasks (web search, dev
delegate to Claude Code), but "send an email from my inbox" really should
go to the one machine that IS your inbox.

## Device IDs

Pass `ANCHOR_DEVICE_ID` as a stable per-machine string. Convention:

```
<platform>-<role>-<location>
darwin-desktop-home
darwin-laptop-travel
linux-server-homelab
```

If you don't set it, Anchor picks `<platform>-<hostname>`. Safe default but
prone to collisions if you reinstall macOS.

## Adding a new runner

Minimum steps on the new machine:

1. Clone the repo, `pnpm install`
2. `.env` with same `ANCHOR_CLOUD_URL`, `ANCHOR_CLOUD_TOKEN` as your primary
3. Unique `ANCHOR_DEVICE_ID`
4. `pnpm server`

On first connect, the new device:
- Registers in cloud's DO storage
- Appears in `/api/devices`
- Becomes eligible for routing (low priority unless you flip primary)

Its bridge list is derived automatically from what providers `registerProvider`
succeeds on that platform — Linux won't have AppleScript providers, Windows
won't have mac-specific ones, etc. This is already handled in
`server/bridges/registry.ts` via `platforms: ["macos", "linux", "windows"]`
per provider.

## Viewer devices (phone/iPad)

The mobile UI at `/` doesn't run Anchor. It just talks to the cloud HTTP
API. To use from a phone:

1. Make sure cloud is deployed (`npx wrangler deploy`)
2. Visit `https://YOUR-URL/?token=YOUR_TOKEN` once — token saved to localStorage
3. After that, just `https://YOUR-URL/` works

If you want to install it like an app: iPhone Safari → Share → Add to Home
Screen. It'll run full-screen with a home-screen icon.

## Disconnection behavior

- Runner closes WS (sleep, quit, network drop) → device marked offline after
  2 min of no heartbeat
- `/api/run` returns 503 if no runner is online with the requested
  capability; UI shows "no runner" in job detail
- Device wakes and reconnects → cloud sends any queued jobs

## Future (Phase 3 sketch)

- **Graph sync** — nodes/edges published by one device, available to others
- **Memory sync** — episodic memories cross-device
- **Tauri packaging** — one-click install on Mac/Windows, auto-update from cloud
- **Per-capability cost routing** — prefer Mac (free AppleScript) over OAuth
  (API quota) when both are available
- **Device groups** — "home" vs "work" — route by context
