# Anchor OS — System Architecture

Personal Decision Operating System. 79 server files, 87 client files, 20K+ lines, 34 tables, 14 cron jobs, 12 agents, 15 tools, 6 channels.

---

## System Overview

```
                                    USER
                                     │
                 ┌───────────────────┼───────────────────┐
                 │                   │                   │
              Web App           Telegram            iMessage
            (:5173 Vite)        (telegraf)        (AppleScript)
                 │                   │                   │
                 └───────────────────┼───────────────────┘
                                     │
                              ┌──────┴──────┐
                              │  Express    │
                              │  :3001      │
                              │  14 routes  │
                              └──────┬──────┘
                                     │
          ┌──────────┬───────────────┼───────────────┬──────────┐
          │          │               │               │          │
       L6 Gate   L5 Exec        L4 Orch         L3 Cogn    L2 Memory
       (permit)  (ReAct)        (bus+cron)      (12 agents) (3 layers)
          │          │               │               │          │
          └──────────┴───────────────┼───────────────┴──────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                 L1 Graph       L8 Cortex         L8 Local
               (nodes+edges)   (LLM routing)    (Mac scanning)
                    │                │                │
                    └────────────────┼────────────────┘
                                     │
                              ┌──────┴──────┐
                              │  anchor.db  │
                              │  SQLite WAL │
                              │  34 tables  │
                              └─────────────┘
```

Two processes share one database:
- **User Product** (`:3001` + Vite `:5173`) — full system with cron, WebSocket, Telegram
- **Admin Panel** (`:3001` via admin branch) — read-only monitoring, manual triggers, no cron

---

## 8 Layers

### L1: Human Graph

```
server/graph/
├── reader.ts        # Read-only queries, graph → LLM prompt serialization
├── writer.ts        # Atomic mutations, transaction-safe batch ops
├── ontology.ts      # Type definitions
└── math/
    ├── pagerank.ts  # Edge-weighted PageRank, damping 0.85, 20 iterations
    ├── entropy.ts   # Shannon entropy → focus score 0-100
    ├── decay.ts     # e^(-λt), dynamic half-life = avgInterval × 4
    ├── bayesian.ts  # P(H|E) = P(E|H)×P(H)/P(E), batch update
    └── math.test.ts # Unit tests (all passing)
```

**21 node types:** person, goal, project, task, risk, constraint, value, preference, decision, event, skill, behavioral_pattern, opportunity, commitment, resource, milestone, metric, habit, relationship, emotion, insight

**5 domains:** work, relationships, finance, health, growth

**10 edge types:** depends-on, influences, relates-to, blocks, enables, requires, supports, conflicts-with, precedes, contextual

**Temporal edges:** `valid_from` / `valid_to` columns. Dream Engine auto-deletes expired edges at 3am.

**Graph → LLM prompt:** `serializeForPrompt()` converts all nodes + edges into structured text, ordered by PageRank importance score. Cached 5 minutes.

### L2: Memory

```
server/memory/
├── retrieval.ts   # 3-layer memory, scored retrieval, nudge, snapshot
├── dream.ts       # 3am consolidation: prune, merge, promote, skill create
└── classes.ts     # Type definitions
```

**3 memory layers:**

| Layer | TTL | Purpose | Example |
|-------|-----|---------|---------|
| working | 7 days | Today's context | "Morning digest generated" |
| episodic | 30 days | Specific events | "User confirmed pitch plan on April 15" |
| semantic | permanent | Stable facts | "User prefers email over phone calls" |

**Retrieval scoring:** `score = confidence × recency_factor × type_weight × keyword_boost`
- Recency: 24h = 1.0, decays to 0.3 over 30 days
- Type: semantic 1.2x > episodic 1.0x > working 0.8x
- Keyword: up to 2.5x boost for query matches

**Periodic Nudge (from Hermes):** Every 5 conversation turns, system injects `[System note: topic X came up N times recently]` into Decision Agent context.

**Frozen Snapshot (from Hermes):** Memory serialization cached with 5-minute TTL for LLM prefix caching efficiency.

**Dialectic Modeling (from Hermes/Honcho):** `writeDialecticInsight({ stated, observed, tension })` — records gap between what user says and what they do.

**Dream Engine (3am cron):**
1. Prune stale working (>7d) and low-confidence episodic (>14d)
2. Merge contradictions via LLM
3. Promote recurring episodic → semantic (3+ occurrences)
4. Time normalize ("next Thursday" → actual date)
5. Create skills from execution logs
6. Enforce capacity (max 200 memories, evict lowest-scoring)
7. Expire temporal edges (valid_to < now)

### L3: Cognition (12 Agents)

```
server/cognition/
├── decision.ts       # Decision Agent: 5-stage pipeline
├── twin.ts           # Twin Agent: behavioral learning from 4 sources
├── evolution.ts      # Evolution Engine: auto-tune 5 dimensions daily
├── skills.ts         # Skills Engine: crystallize, match, evolve, retire
├── diagnostic.ts     # Self-Diagnostic: meta-agent, pure SQL, 9 checks
├── extractor.ts      # Extractor: message → graph nodes
├── self-portrait.ts  # Self-Portrait: 5-layer math analysis
├── swarm.ts          # Cognitive Swarm: 3-role debate (Advocate/Critic/Judge)
├── observation.ts    # Observation + Memory Agent
├── gepa.ts           # GEPA Optimizer: execution trace analysis
├── sparse-analysis.ts # Sparse Analysis: 5 micro-analysts for thin data
└── packets.ts        # Type definitions
```

#### Decision Agent (decision.ts)

The brain. Every user message flows through here.

```
User message
    │
    ├─→ Intent classify (local regex, 0 LLM)
    │     greeting → instant reply ─────────→ done (0 cost)
    │     execution → skip to tools
    │     decision → continue ↓
    │
    ├─→ Cache check (LRU 50, 5min, keyed on msg+graph+mem+history)
    │     hit → return cached ──────────────→ done (0 cost)
    │
    ├─→ Skill match (keyword 60%, reads system_config threshold)
    │     match → cheap model adapts template → done (1 cheap call)
    │
    ├─→ Sparse data? (<5 nodes, <5 memories, <3 history)
    │     yes → 5 micro-analysts ───────────→ done (1 call)
    │
    ├─→ 5-STAGE PIPELINE (1 LLM call, ~2500 tokens)
    │     1. Constraint extraction (graph → blockers, deadlines)
    │     2. Option generation (2-3 candidates)
    │     3. Twin alignment (check vs behavioral priors)
    │     4. Boundary classification (risk level, approval need)
    │     5. Delta selection (best option + why NOW)
    │
    ├─→ Post-processing
    │     JSON parse + auto-repair truncated
    │     Cognitive failure detection (8 modes)
    │     Trajectory confidence verification (independent LLM)
    │
    └─→ Swarm escalation if confidence < 0.7
          3-role debate: Advocate → Critic → Judge
```

**Prompt construction:** `buildSystemPrompt()` injects:
- Graph (PageRank-weighted nodes + edges)
- Memory (top 12 scored memories)
- Twin priors (behavioral insights)
- Value Constitution (values > constraints > preferences)
- Evolution adaptations ("keep plans to 3 steps", "be concise")

**8 cognitive failure modes detected:**
1. High confidence on complex request (suspiciously easy)
2. Context starvation (no graph nodes referenced)
3. Over-planning (>6 steps for <15 word request)
4. Conflict suppression (conflicts exist but risk=low)
5. Missing why-this-now
6. No stages trace
7. Twin over-reliance (high-confidence decision from low-confidence priors)
8. Open-loop-as-task (questions treated as action items)

#### Twin Agent (twin.ts)

Learns user behavior from 4 sources:

| Source | When | What it learns |
|--------|------|----------------|
| Edit diffs | User modifies plan steps | "User always removes phone call suggestions" → contraindication node |
| Execution results | Plan execution completes | "4-step work plans succeed 90% of the time" |
| Accept/reject | User confirms or rejects | "Rejection rate 40% → system too aggressive" |
| Weekly drift | Monday 9am cron | "User shifted from cautious to decisive this month" |

Creates **contraindication nodes** in graph: `type=constraint, captured="Twin Agent"`. These feed into Decision Agent's Value Constitution.

**Dialectic tension:** Records gaps between stated preferences and actual behavior as semantic memories.

#### Evolution Engine (evolution.ts)

Runs daily at 4am. Zero user configuration.

**5 dimensions auto-tuned:**

| Dimension | Values | Signal source | Prompt effect |
|-----------|--------|---------------|---------------|
| decision_style | cautious / balanced / aggressive | reject rate | "Default risk to high" or "minimize hedging" |
| plan_complexity | simple / moderate / detailed | edit ratio | "Keep plans to 3 steps" or "include sub-steps" |
| communication_tone | direct / supportive / analytical | avg message length | "No filler" or "include reasoning" |
| domain_weights | {work: 0.5, health: 0.3...} | graph activity | "Prioritize work and health" |
| time_preference | {peak: 10, hours: [8-18]} | message timestamps | Suggest actions during active hours |

**5-step loop:**
1. Capture — 24h satisfaction signals + twin insights + skill usage
2. Deviation — compare suggestions vs user actions
3. Pattern — 5+ consistent days = stable
4. Update — write to evolution_state table
5. Adjust — generate prompt adaptation text for Decision Agent

**Reads `system_config`** for `evolution_min_signals` threshold (adjustable by Diagnostic Agent).

#### Skills Engine (skills.ts)

```
Lifecycle:
  3+ similar confirmed plans ──→ tryCrystallizeSkill() ──→ new skill
  user message matches skill ──→ detectSkillMatch() ──→ fast path (cheap model)
  user edits skill-based plan ──→ evolveSkill() ──→ template updated
  user rejects 3x ──→ penalizeSkill() ──→ confidence < 0.3 ──→ auto-delete
```

**5 built-in templates:** Investor Follow-up, Weekly Review, Meeting Prep, Decision Journal, Quick Outreach

**Reads `system_config`** for `skill_crystallize_min` (default 3) and `skill_match_threshold` (default 0.6), adjustable by Diagnostic Agent.

#### Self-Diagnostic Agent (diagnostic.ts)

The meta-agent. Watches all other agents. Pure SQL + math, zero LLM.

```
Phase determination (by DATA VOLUME, not calendar):
  Phase 1: < 50 conversations → accumulating data
  Phase 2: 50+ convos, 20+ signals → quality assessment
  Phase 3: 150+ convos, 1+ skill, 3+ dims → GEPA readiness

First 2 weeks = baseline period (observe only, no fixes)
```

**9 health checks:**

| # | Check | Healthy | Auto-fix (Phase 2+) |
|---|-------|---------|---------------------|
| Q1 | Confirm rate | > 50% | — (adjusts intent classification bias) |
| Q2 | Skills crystallized | > 0 after 50 convos | Lower crystallize_min: 3→2 (7d expiry) |
| Q3 | Evolution dims | >= 3 updated | Lower min_signals: 2→1 (7d expiry) |
| Q4 | Twin insights | > 5, recent < 7d | Trigger detectDrift() |
| Q5 | Graph orphans | < 30% | Root cause analysis (who created them) |
| Q6 | Memory capacity | < 150/200 | Trigger Dream Engine |
| Q7 | Cost/day | < $0.50 | Downgrade most expensive task |
| Q8 | Activity captures | > 100/24h | Notify: need macOS permission |
| Q9 | User activity | active in 7 days | Skip if inactive (save resources) |

**Auto-fix mechanism:**
- Writes adjustments to `system_config` table
- All fixes have **7-day expiry** (auto-revert to defaults)
- system_config has **higher priority** than hardcoded values
- Does NOT modify evolution_state directly (avoids fighting Evolution Engine)
- Every fix logged in `diagnostic_reports`

**GEPA readiness (Phase 3):** When 100+ sessions, 1+ skill, 3+ evolution dims → reports "Ready for GEPA prompt evolution" → user decides whether to enable.

### L4: Orchestration

```
server/orchestration/
├── bus.ts              # EventEmitter, 7 event types
├── handlers.ts         # Event → dispatch, handoff validation, retry 2x
├── cron.ts             # 14 scheduled jobs
├── enforcement.ts      # Handoff validation, event persistence
├── proactive.ts        # Push notifications (decay, overdue, outcomes)
├── modes.ts            # Trigger classification
└── system-evolution.ts # Weekly model routing optimization
```

#### Event Bus

```
Event                Trigger              Handler                    Result
─────────────────────────────────────────────────────────────────────────────
USER_CONFIRMED       User approves plan   Twin learns edits →        Execution runs
                                          Execution ReAct
EXECUTION_DONE       Agent completes      Twin learns results →      Memory persists
                                          Outcome evaluation
TWIN_UPDATED         Insight generated    Persist as semantic        Memory grows
                                          memory
GRAPH_UPDATED        Node status changes  Record as episodic         Memory grows
                                          memory, cascade unlocks
TASK_COMPLETED       Task marked done     Grant XP                   Twin levels up
NOTIFICATION         System alert         Push to WebSocket →        User sees toast
                                          frontend toast
SCAN_PROGRESS        Scanner running      Update onboarding          Progress bar moves
                                          progress bar
```

Handoff validation: orchestrator→execution OK, execution→execution BLOCKED. Max 2 retries with 1s backoff.

#### 14 Cron Jobs

```
FREQUENCY       TIME          JOB                    ENGINE
──────────────────────────────────────────────────────────────
Every 5 min     */5 * * * *   Activity Capture        AppleScript (app + title + URL)
Every 6 hours   0 */6 * * *   Decay Checker           markStaleAsDecaying(5 days)
Every 6 hours   0 */6 * * *   Ingestion Pipeline      Gmail + Calendar scan
Every 6 hours   30 */6 * * *  Graph from Activity     Update projects + relationships
Every 12 hours  0 */12 * * *  Proactive Check         Decay alerts, overdue tasks
Daily 2:55am    55 2 * * *    SQLite Backup           anchor-YYYY-MM-DD.db (keep 7)
Daily 3:00am    0 3 * * *     Dream Engine            Prune, merge, promote, skills
Daily 4:00am    0 4 * * *     Evolution Engine         Capture → deviation → update 5 dims
Daily 8:00am    0 8 * * *     Morning Digest          LLM → 3-bullet briefing
Daily 10:00pm   0 22 * * *    Stale Task Detector     >7d in-progress → blocked
Monday 9:00am   0 9 * * 1     Twin Reflection         Weekly behavior pattern + drift
Sunday 5:00am   0 5 * * 0     GEPA Optimizer          Trace analysis + auto route_overrides
Sunday 6:00am   0 6 * * 0     System Evolution        Model routing optimization
Sunday 7:00am   0 7 * * 0     Self-Diagnostic         9 checks, auto-fix, trend report
```

### L5: Execution

```
server/execution/
├── agent.ts     # ReAct loop, 12 turns max, checkpoint recovery
├── tools.ts     # 10 built-in tools
├── registry.ts  # Tool registration + permission gating
└── swarm.ts     # Parallel execution phases
```

#### 15 Tools

| # | Tool | Type | What it does |
|---|------|------|-------------|
| 1 | write_task | DB | Create task in projects table |
| 2 | update_graph_node | DB | Update node status/detail |
| 3 | record_outcome | DB | Write episodic memory |
| 4 | send_email | Shell | AppleScript → Mail.app |
| 5 | create_calendar_event | Shell | AppleScript → Calendar.app |
| 6 | create_reminder | Shell | AppleScript → Reminders.app |
| 7 | open_url | Shell | Open in default browser |
| 8 | web_search | Network | DuckDuckGo (no API key) |
| 9 | read_url | Network | Fetch URL, strip HTML |
| 10 | run_code | Sandbox | JS execution (no require/import/process/fs) |
| 11 | browser_navigate | Playwright | Navigate to URL, return content |
| 12 | browser_screenshot | Playwright | Screenshot as base64 |
| 13 | browser_click | Playwright | Click CSS selector |
| 14 | browser_type | Playwright | Type into input field |
| 15 | browser_extract | Playwright | Extract text by selector |

Tools 11-15 require `BROWSER_ENABLED=true` and Playwright installed.

Every tool call goes through L6 Permission Gate before execution.

### L6: Permission Gate

```
server/permission/
├── gate.ts    # checkPermission(), trust progression, rate limiting
└── levels.ts  # Policy definitions, action classes, risk tiers
```

**4 trust levels:**

```
L0_read_only       → deny all writes
L1_draft           → draft only, needs user approval
L2_confirm_execute → user approves, system executes
L3_bounded_auto    → system auto-executes (after 10 clean successes)
```

**Trust progression:**
- 10 consecutive successes + 0 failures → upgrade one level
- 3 failures → downgrade one level
- 5-call cooldown audit after upgrade
- High/critical risk actions never auto-upgrade past L2

**Rate limiting:** per action class, per hour (sliding window).

**Derived-write prohibition:** Twin/Decision output cannot write to graph as first-class fact without user confirmation.

**Emergency lockdown:** `activateLockdown()` → all actions denied. Activated via Admin panel.

**Audit trail:** Every permission decision (allow/deny/require_confirmation) written to `permission_audit` table. Append-only.

### L7: Surface

```
server/routes/
├── advisor.ts         # Chat: personal, general, stream, confirm, reject, digest
├── graph.ts           # Nodes CRUD, domains, export/import, decaying relationships
├── user.ts            # Profile, state, settings, evolution
├── memory.ts          # Search, browse, CRUD
├── workspace.ts       # Projects + tasks CRUD
├── twin.ts            # Evolution, insights, quests, model
├── agents.ts          # Status, executions, GEPA, self-portrait, recommendations
├── custom-agents.ts   # Custom agent CRUD, run, feedback, NL creation
├── admin.ts           # Cortex, costs, performance, logs, health, diagnostic, triggers
├── skills.ts          # CRUD, templates, install
├── integrations.ts    # Google OAuth, local scan, finance, activity
├── privacy.ts         # Policy, LLM disclosures, autonomy, delete-all
├── notifications.ts   # Proactive alerts, outcome feedback, suggest actions
├── crons.ts           # User automation CRUD, NL creation
└── mcp.ts             # External MCP server connect/disconnect/refresh
```

### L8: Infrastructure

```
server/infra/
├── compute/
│   ├── index.ts       # text(), textStream(), textWithTools(), vision(), embed()
│   ├── router.ts      # Task → capability → tier → model selection
│   ├── providers.ts   # Anthropic, OpenAI, Google model definitions
│   ├── keys.ts        # API key management
│   └── telemetry.ts   # Token/cost/latency logging, route overrides
├── storage/
│   └── db.ts          # SQLite schema (34 tables), migrations, seedIfEmpty()
├── hand/
│   ├── index.ts       # Hand initialization
│   └── browser.ts     # 5 Playwright tools (optional)
├── mcp/
│   └── index.ts       # MCP server (bidirectional)
└── rag/
    └── index.ts       # Embedding storage (optional)

server/integrations/
├── local/
│   ├── index.ts              # Orchestrates all local scans
│   ├── browser-history.ts    # Chrome/Safari/Arc SQLite reader
│   ├── contacts.ts           # AppleScript → Contacts.app
│   ├── calendar.ts           # AppleScript → Calendar.app
│   ├── activity-monitor.ts   # Every 5min: app + title + URL
│   ├── people-extractor.ts   # LinkedIn/Twitter/email pattern matching
│   ├── deep-scan.ts          # Apps, projects, tech stack
│   └── finance.ts            # Balance, burn, runway
├── adapters/
│   ├── gmail.ts              # Gmail API adapter
│   └── calendar.ts           # Google Calendar adapter
├── pipeline.ts               # Ingestion orchestrator
├── telegram.ts               # Telegraf bot (/today, /status, /scan)
├── imessage.ts               # AppleScript Messages.app read/write
├── token-store.ts            # OAuth token management
└── types.ts                  # Ingestion event types
```

---

## Frontend

```
client/src/
├── pages/
│   ├── Dashboard.tsx      # Mirror: priority, state, suggestions, diagnostic,
│   │                      #   fading relationships, twin model, evolution, graph
│   ├── Advisor.tsx        # SSE streaming chat, plan editor, confirm/reject
│   ├── Agents.tsx         # NL agent creation, chat, automations, skills
│   ├── TwinAgent.tsx      # XP/quests, 4 levels, insights
│   ├── Memory.tsx         # 3-layer browser, search, add
│   ├── Workspace.tsx      # Kanban: projects, tasks, priorities
│   ├── Settings.tsx       # Profile, models, privacy, notifications, Telegram
│   ├── NodeDetail.tsx     # Graph node: meta, mini SVG graph, tasks, ask, tools
│   ├── Onboarding.tsx     # 7-step: welcome → scan → identity → goals → people
│   ├── Cortex.tsx         # Model management, provider keys
│   └── admin/
│       ├── Overview.tsx   # One-screen system health
│       ├── Agents.tsx     # Agent monitor + manual trigger
│       ├── Crons.tsx      # Cron job status
│       ├── Permissions.tsx # Trust gate + lockdown + audit
│       ├── Privacy.tsx    # LLM disclosure + delete all data
│       ├── Health.tsx     # System health metrics
│       ├── Costs.tsx      # LLM spend tracking
│       ├── Performance.tsx # Latency/success rates
│       ├── Logs.tsx       # LLM call inspector
│       ├── Graph.tsx      # Graph visualization
│       ├── Memory.tsx     # Memory statistics
│       └── Data.tsx       # Export/import
├── components/
│   ├── AppLayout.tsx      # Sidebar navigation (7 items)
│   ├── AdminLayout.tsx    # Admin sidebar (5 areas, 13 items)
│   ├── CommandPalette.tsx # Cmd+K global search
│   ├── VoiceInput.tsx     # Web Speech API, hold-to-speak
│   └── ErrorBoundary.tsx  # React error boundary
├── hooks/
│   ├── useWebSocket.ts    # Auto-connect, toast on events
│   └── useComposition.ts  # IME composition handling
└── lib/
    ├── api.ts             # 60+ API functions
    └── store.ts           # Zustand with SWR caching (graph 5min, decision 5min, digest 2min)
```

---

## Self-Improvement Loop

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                                                                 │
    ▼                                                                 │
 User sends         Decision Agent        Returns plan               │
 message ──────────→ 5-stage pipeline ──→ with editable steps        │
                     (1 LLM call)         + confidence + why-now      │
                          │                      │                    │
                          │                      ▼                    │
                          │               User confirms/edits         │
                          │                      │                    │
                          │         ┌────────────┼────────────┐       │
                          │         │            │            │       │
                          │         ▼            ▼            ▼       │
                          │    Twin learns   Execution    Skill       │
                          │    edit diffs    ReAct loop   check       │
                          │         │            │            │       │
                          │         ▼            │            │       │
                          │    Evolution         │            │       │
                          │    tunes 5 dims      │            │       │
                          │         │            │            │       │
                          │         ▼            ▼            │       │
                          │    Next prompt    Results feed     │       │
                          │    automatically  back to Twin    │       │
                          │    includes       and Memory      │       │
                          │    adaptations         │          │       │
                          │         │              │          │       │
                          │         └──────────────┴──────────┘       │
                          │                   │                       │
                          │                   ▼                       │
                          │            Diagnostic Agent               │
                          │            (weekly, pure SQL)             │
                          │            monitors everything            │
                          │            auto-fixes if stalled ─────────┘
                          │
                          └──── next message benefits from all learning
```

**Key insight:** The user does nothing special. Every confirm, reject, and edit teaches the system. Diagnostic Agent ensures the loop doesn't stall.

---

## Database Schema (34 tables)

### Core Data
| Table | Purpose |
|-------|---------|
| users | User profile (name, email, role) |
| user_state | Energy, focus, stress (0-100) |
| settings | Theme, models, notifications, privacy |
| graph_nodes | 21 types × 5 domains, status, detail |
| graph_edges | 10 types, weight, valid_from/valid_to |
| memories | 3 layers (working/episodic/semantic), FTS5 indexed |
| memories_fts | Full-text search virtual table |
| messages | Conversation history (personal/general mode) |

### Learning & Intelligence
| Table | Purpose |
|-------|---------|
| twin_insights | Behavioral patterns learned by Twin |
| twin_evolution | XP + level tracking |
| twin_quests | Gamification quests |
| evolution_state | 5 dimensions (style, complexity, tone, weights, time) |
| skills | Auto-crystallized + templates (steps, trigger, confidence) |
| satisfaction_signals | Confirm/reject/modify signals |
| decision_traces | Task type, model, latency, satisfaction |

### System
| Table | Purpose |
|-------|---------|
| agent_executions | Every agent action logged |
| llm_calls | Every LLM call with tokens, cost, latency |
| route_overrides | Task → model routing overrides |
| dream_log | Dream Engine run statistics |
| system_config | Adjustable thresholds (7-day expiry) |
| diagnostic_reports | Weekly health snapshots |
| permission_audit | Append-only permission decisions |
| trust_state | Per-action trust level + success/failure counts |
| system_metrics | General metrics |
| events | Event persistence |
| prompt_strategies | Prompt optimization tracking |

### Integrations
| Table | Purpose |
|-------|---------|
| api_keys | LLM provider keys |
| oauth_tokens | Google OAuth tokens |
| ingestion_log | Scan run history |
| activity_captures | App + title + URL every 5min |
| scan_consent | Privacy consent tracking |

### User Content
| Table | Purpose |
|-------|---------|
| projects | Workspace projects |
| tasks | Project tasks (kanban) |
| user_crons | User-defined automations |
| user_agents | Custom AI agents |
| mcp_servers | External MCP connections |

---

## Hermes Agent Integration

Patterns borrowed from Hermes Agent (Nous Research):

| Hermes Pattern | Anchor Implementation | Match |
|----------------|----------------------|-------|
| GEPA (Genetic-Pareto Prompt Evolution) | gepa.ts: trace analysis + auto route_overrides | 30% — no Pareto selection, no prompt mutation |
| Periodic Nudge | retrieval.ts: every 5 turns, inject reflection | 80% — same concept, simpler |
| Frozen Prompt Snapshot | retrieval.ts: 5min cached memory serialization | 100% — identical |
| Dialectic User Modeling | retrieval.ts: writeDialecticInsight() | 50% — no Honcho, inline only |
| Skill Auto-Creation | skills.ts: 3+ confirms → crystallize | 40% — no GEPA evolution of skills |
| Dream Engine | dream.ts: 3am consolidation | 70% — same ops, no cross-session migration |
| Multi-Channel | 6 channels (Web, WS, Telegram, iMessage, MCP, Voice) | 100%+ — has iMessage + MCP |

**Anchor-only (no Hermes equivalent):** Human Graph, Evolution Engine, Self-Portrait, Recommendation Engine, Self-Diagnostic Agent, Local Mac Scanning.

---

## How to Run

```bash
# User product
pnpm dev          # Vite :5173 + Express :3001

# Admin panel (separate process)
pnpm admin        # Express :3001 (admin-panel branch)

# Both share the same anchor.db (SQLite WAL supports concurrent access)
```
