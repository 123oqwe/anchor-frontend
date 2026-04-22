# Anchor Dogfood Protocol — 2 Weeks of Truth

**Goal**: You don't know what to build next until you've used Anchor as a
real tool for two weeks. Not "tested it once" — used it.

## Setup (Day 0)

1. `pnpm server` + `pnpm dev` running
2. Visit `/portrait`, click **Begin** — read the Portrait slowly
3. Answer Y/P/N on every question honestly (~10 mins)
4. Screenshot the Compass headline. Paste into `docs/DOGFOOD_JOURNAL.md`

## Daily Rhythm (14 days)

### Morning (2 min)
- Did Anchor tell me anything useful in the last 24h?
- Did I go looking for info that Anchor should have surfaced proactively?

### Evening (2 min)
- One sentence: **What did Anchor get right today?**
- One sentence: **What did Anchor get wrong today?**
- One screenshot: the best (or worst) moment

### Weekly (Sunday, 15 min)
- Re-run `/portrait` → click **Re-read me**
- Diff: what changed in Compass headline? Is it sharper or drifting?
- Top 3 pains this week (by frequency, not drama)
- Top 3 delights (moments of "oh that worked")

## The 3 Agents You Must Actually Create

Don't only read Anchor — make it work for you. Create these, even bluntly:

1. **Daily Digest Agent** (`trigger: cron 8am`) — summary of yesterday
   from calendar + important files changed + iMessage peaks
2. **Focus Check Agent** (`trigger: app_focused:Douyin` or TikTok) —
   interrupts after 30 min of distraction apps
3. **Weekly Reflector** (`trigger: cron Sunday 6pm`) — reads last week's
   `agent_executions`, writes a 1-page reflection

If you can't get these to work, that's the #1 signal for what to fix.

## Hard Questions to Answer by Day 14

(write answers in JOURNAL)

1. **What's the one feature I'd pay $20/mo for?** If nothing → rebuild.
2. **What's the one feature I'd SHOW a friend in 30 seconds?** If nothing
   → the product isn't demo-able yet.
3. **Which Oracle gave me the sharpest insight? Which felt generic?**
   Generic ones need few-shot tuning.
4. **What did Anchor MISS that I wish it knew?** → next scanner / data
   source.
5. **What did I stop doing because Anchor handled it?** → proof of value.

## What NOT To Do

- ❌ Add features during the 2 weeks (except blocking bugs)
- ❌ Optimize prompts because you think they should be sharper
- ❌ Build "just one more scanner"
- ❌ Refactor the architecture
- ❌ Show it to anyone else yet

**Feature freeze = finding what you actually use.**

## Exit Criteria

After 14 days, you should have:

1. `docs/DOGFOOD_JOURNAL.md` with 14 daily entries + 2 weekly reflections
2. A ranked pain list (top 5) with frequency counts
3. A ranked delight list (top 5)
4. Specific answers to the 5 Hard Questions above
5. A **decision**: continue with current architecture, pivot, or ship-as-is

The next sprint's priorities come from the journal, not from this
codebase. No exceptions.

## Why This Protocol Exists

Two risks the codebase doesn't show:
- **Spec sprawl**: it's easy to keep building because the 8-step
  scanning architecture can always be "one more step better"
- **Fake signal**: every new feature looks good in isolation. Only
  usage reveals what compounds.

The best code you write in the next 2 weeks is the code you DON'T write
because real usage showed it wasn't needed.
