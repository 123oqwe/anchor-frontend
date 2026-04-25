import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "anchor.db");

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'User',
    email TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_state (
    user_id TEXT PRIMARY KEY,
    energy INTEGER NOT NULL DEFAULT 72,
    focus INTEGER NOT NULL DEFAULT 85,
    stress INTEGER NOT NULL DEFAULT 34,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    theme TEXT NOT NULL DEFAULT 'dark',
    model_reasoning TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    model_fast TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    local_processing INTEGER NOT NULL DEFAULT 0,
    data_retention TEXT NOT NULL DEFAULT '90',
    share_analytics INTEGER NOT NULL DEFAULT 0,
    encrypt_memory INTEGER NOT NULL DEFAULT 1,
    notif_decisions INTEGER NOT NULL DEFAULT 1,
    notif_memories INTEGER NOT NULL DEFAULT 1,
    notif_twin INTEGER NOT NULL DEFAULT 1,
    notif_digest INTEGER NOT NULL DEFAULT 1,
    notif_email INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    captured TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (from_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_node_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_node_id);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0.8,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FTS5 full-text search index on memories (hybrid search: keyword + relevance)
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, content, tags,
    content='memories', content_rowid='rowid'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
  END;

  -- Learned skills (auto-created from complex task executions)
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    trigger_pattern TEXT NOT NULL DEFAULT '',
    use_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dream log (tracks consolidation runs)
  CREATE TABLE IF NOT EXISTS dream_log (
    id TEXT PRIMARY KEY,
    pruned INTEGER NOT NULL DEFAULT 0,
    merged INTEGER NOT NULL DEFAULT 0,
    promoted INTEGER NOT NULL DEFAULT 0,
    contradictions INTEGER NOT NULL DEFAULT 0,
    skills_created INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'bg-blue-500',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    tags TEXT NOT NULL DEFAULT '[]',
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    draft_type TEXT,
    draft_status TEXT,
    agent_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_executions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS twin_evolution (
    user_id TEXT PRIMARY KEY,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS twin_quests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 10,
    xp_reward INTEGER NOT NULL DEFAULT 20,
    completed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS twin_insights (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    insight TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8,
    trend TEXT NOT NULL DEFAULT 'stable',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    provider_id TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    capability TEXT,
    model_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    latency_ms INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    request_preview TEXT,
    response_preview TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_llm_calls_task ON llm_calls(task);
  CREATE INDEX IF NOT EXISTS idx_llm_calls_model ON llm_calls(model_id);
  CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);

  CREATE TABLE IF NOT EXISTS route_overrides (
    task TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- L6 trust level persistence (survives restart)
  CREATE TABLE IF NOT EXISTS trust_state (
    action_class TEXT PRIMARY KEY,
    current_level TEXT NOT NULL,
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- L6 permission audit log (append-only by convention)
  CREATE TABLE IF NOT EXISTS permission_audit (
    id TEXT PRIMARY KEY,
    action_class TEXT NOT NULL,
    decision TEXT NOT NULL,
    boundary TEXT NOT NULL,
    source TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_perm_audit ON permission_audit(action_class, created_at);

  -- Performance indexes
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_user_status ON graph_nodes(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_user_domain ON graph_nodes(user_id, domain);
  CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_user_mode ON messages(user_id, mode, created_at);
  CREATE INDEX IF NOT EXISTS idx_executions_user_created ON agent_executions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_executions_user_agent ON agent_executions(user_id, agent);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_insights_user ON twin_insights(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_quests_user ON twin_quests(user_id);

  -- Satisfaction signals (Phase 0.5: user satisfaction tracking)
  CREATE TABLE IF NOT EXISTS satisfaction_signals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    value REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_satisfaction_user ON satisfaction_signals(user_id, created_at);

  -- Evolution state (Phase 2: personal evolution engine)
  CREATE TABLE IF NOT EXISTS evolution_state (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    current_value TEXT NOT NULL,
    previous_value TEXT NOT NULL DEFAULT '',
    evidence_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, dimension)
  );

  -- Decision traces (Phase 3: system evolution)
  CREATE TABLE IF NOT EXISTS decision_traces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    model_used TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER,
    user_satisfaction REAL,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_traces_task ON decision_traces(task_type, created_at);

  -- Prompt strategies (Phase 3: system evolution)
  CREATE TABLE IF NOT EXISTS prompt_strategies (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    template_patch TEXT NOT NULL DEFAULT '',
    success_rate REAL NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- System metrics (Phase 4: reliability)
  CREATE TABLE IF NOT EXISTS system_metrics (
    id TEXT PRIMARY KEY,
    metric_name TEXT NOT NULL,
    value REAL NOT NULL,
    tags TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_metrics ON system_metrics(metric_name, created_at);

  -- Events (Phase 4: event persistence)
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);

  -- OAuth tokens for external integrations
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, provider)
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_tokens(user_id, provider);

  -- Ingestion run log
  CREATE TABLE IF NOT EXISTS ingestion_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    run_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    events_fetched INTEGER NOT NULL DEFAULT 0,
    nodes_created INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ingestion_user ON ingestion_log(user_id, source, started_at);

  -- User-defined automations (cron jobs)
  CREATE TABLE IF NOT EXISTS user_crons (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron_pattern TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Custom user-defined agents
  CREATE TABLE IF NOT EXISTS user_agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    tools TEXT NOT NULL DEFAULT '[]',
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    trigger_config TEXT NOT NULL DEFAULT '{}',
    model_preference TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- External MCP server connections
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'streamable-http',
    status TEXT NOT NULL DEFAULT 'disconnected',
    tools_json TEXT NOT NULL DEFAULT '[]',
    last_connected TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_consent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    consented_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    version TEXT NOT NULL DEFAULT '1.0'
  );

  -- System config (adjustable thresholds for Diagnostic Agent)
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'default',
    expires_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Diagnostic reports (weekly snapshots for trend analysis)
  CREATE TABLE IF NOT EXISTS diagnostic_reports (
    id TEXT PRIMARY KEY,
    phase INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL,
    alerts_json TEXT NOT NULL DEFAULT '[]',
    fixes_applied_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-agent persistent KV store (OPT-5: agent state across runs)
  CREATE TABLE IF NOT EXISTS agent_kv (
    agent_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, key)
  );

  -- OPT-3: Agent pipelines (chain multiple custom agents)
  CREATE TABLE IF NOT EXISTS agent_pipelines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    steps TEXT NOT NULL,              -- JSON: [{agent_id, input_template, output_key}]
    trigger_type TEXT DEFAULT 'manual',
    trigger_config TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    step_results TEXT NOT NULL DEFAULT '[]',
    total_cost REAL NOT NULL DEFAULT 0,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_runs ON pipeline_runs(pipeline_id, started_at);

  -- OPT-1 Gap B: dev tool write proposals (human-in-loop approval)
  CREATE TABLE IF NOT EXISTS dev_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,                        -- 'write_file' | 'git_commit'
    path TEXT,                                 -- absolute file path (for write_file)
    before_content TEXT,                       -- existing content (null if new file)
    after_content TEXT NOT NULL,               -- proposed content
    agent_name TEXT,                           -- which agent proposed (audit)
    run_id TEXT,                               -- trace correlation
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected | expired | written
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    write_result TEXT                          -- 'ok' or error message once written
  );

  CREATE INDEX IF NOT EXISTS idx_dev_proposals_status ON dev_proposals(user_id, status, created_at);

  -- L8-Hand Bridge: capability preferences (per-user provider order + disabled set)
  CREATE TABLE IF NOT EXISTS capability_preferences (
    user_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    provider_order TEXT NOT NULL DEFAULT '[]',   -- JSON array of provider ids
    disabled_providers TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, capability)
  );

  -- L8-Hand Bridge: non-OAuth API tokens (Todoist/Linear/etc)
  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    token TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, provider)
  );

  -- L8-Hand Bridge: provider attempt log (reliability telemetry + Twin learning feed)
  CREATE TABLE IF NOT EXISTS provider_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,                        -- success | failed | skipped
    error_kind TEXT,                             -- terminal | retryable
    reason TEXT,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,                                 -- OPT-4 trace correlation
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_provider_attempts_run ON provider_attempts(run_id);
  CREATE INDEX IF NOT EXISTS idx_provider_attempts_provider ON provider_attempts(provider_id, created_at);

  -- Codex-style App Approval: per-app authorization layered on top of L6 ActionClass.
  -- A vision/automation provider targeting a new app is blocked until user grants it.
  CREATE TABLE IF NOT EXISTS app_approvals (
    user_id TEXT NOT NULL,
    app_identifier TEXT NOT NULL,            -- "gmail.com" / "com.apple.Mail" / "*"
    scope TEXT NOT NULL DEFAULT 'full',      -- "read" | "write" | "full"
    status TEXT NOT NULL DEFAULT 'pending',  -- "pending" | "approved" | "denied"
    granted_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, app_identifier, scope)
  );

  CREATE INDEX IF NOT EXISTS idx_app_approvals_status ON app_approvals(user_id, status);
`);

// ─── Default user seed ────────────────────────────────────────────────────────

const DEFAULT_USER_ID = "user_default";

function seedIfEmpty() {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(DEFAULT_USER_ID);
  if (user) return;

  const run = db.transaction(() => {
    // Only create empty user shell — real data comes from Onboarding
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?)").run(
      DEFAULT_USER_ID, "", "", ""
    );
    db.prepare("INSERT INTO user_state (user_id) VALUES (?)").run(DEFAULT_USER_ID);
    db.prepare("INSERT INTO settings (user_id) VALUES (?)").run(DEFAULT_USER_ID);
    db.prepare("INSERT INTO twin_evolution (user_id, xp) VALUES (?, ?)").run(DEFAULT_USER_ID, 0);

    // Starter quests (these are system-defined, not user data)
    const insQuest = db.prepare("INSERT INTO twin_quests (id, user_id, name, description, progress, total, xp_reward, completed) VALUES (?,?,?,?,?,?,?,?)");
    insQuest.run(nanoid(), DEFAULT_USER_ID, "First 10 Interactions", "Have 10 conversations with your advisor", 0, 10, 30, 0);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Graph Builder", "Add 10 nodes to your Human Graph", 0, 10, 50, 0);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Plan Reviewer", "Review and approve 5 AI-generated plans", 0, 5, 40, 0);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Memory Maker", "Create 5 memories through conversations", 0, 5, 20, 0);
  });

  run();
  console.log("✅ Database initialized (empty — ready for Onboarding)");
}

// Migrate: add new columns to skills table (safe for existing DBs)
try { db.exec("ALTER TABLE skills ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN last_used TEXT"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN success_rate REAL NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN context_conditions TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'dream_engine'"); } catch {}

try { db.exec("ALTER TABLE graph_edges ADD COLUMN valid_from TEXT"); } catch {}
try { db.exec("ALTER TABLE graph_edges ADD COLUMN valid_to TEXT"); } catch {}
// Backfill legacy edges: valid_from defaults to their created_at; valid_to stays NULL ("currently active")
try { db.exec("UPDATE graph_edges SET valid_from = created_at WHERE valid_from IS NULL"); } catch {}
// Index active edges for fast "currently valid" queries
try { db.exec("CREATE INDEX IF NOT EXISTS idx_edges_active ON graph_edges(user_id, from_node_id, to_node_id, type) WHERE valid_to IS NULL"); } catch {}

// ── Phase 2 — System agent overrides (Mode C: per-field lock) ─────────────
// User customizations to the 11 hardcoded system agents (Twin, Decision,
// Council, ...). Each row overrides one USER-locked field path. LOCKED
// fields silently ignore any rows here (composer guards). Schema_version
// tied to the agent's spec.schemaVersion so future migrations can rename
// or drop fields without orphan-loss.
try { db.exec(`CREATE TABLE IF NOT EXISTS system_agent_overrides (
  agent_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  value TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (agent_id, field_path)
)`); } catch {}

// User-added items for ADD_ONLY fields (constraints, examples, skills...).
// Many-rows-per-agent-per-path; each item is one row. Anchor's built-in
// items live in the spec defaults — these append, never replace.
try { db.exec(`CREATE TABLE IF NOT EXISTS system_agent_additions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  value TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  schema_version INTEGER NOT NULL DEFAULT 1
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sys_agent_add ON system_agent_additions(agent_id, field_path)"); } catch {}

// System cron overrides — flat shape. snooze_until is the most-used field
// (pause for a week while traveling). Persists across reboots. Cleared by
// passing null in PUT /api/system/cron/:id/snooze.
try { db.exec(`CREATE TABLE IF NOT EXISTS system_cron_overrides (
  cron_id TEXT PRIMARY KEY,
  snooze_until TEXT,
  proactive_off INTEGER NOT NULL DEFAULT 0,
  user_added_conditions TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}

// ── Bi-temporal columns for graph_nodes ─────────────────────────────────────
// Two orthogonal time axes, per Snodgrass (1999) TSQL2 semantics:
//   valid_from / valid_to — when the FACT is true in the world. Node represents
//     something that exists as of valid_from; if valid_to is non-NULL, the node
//     describes a fact that has ceased to be true (e.g., a person no longer in
//     your circle, a project that ended). NULL valid_to = currently valid.
//   recorded_at — when Anchor LEARNED of this fact. The transaction-time axis.
//     Differs from valid_from when a scanner imports a backdated event
//     (e.g., an old email discovered today represents a fact that's been true
//     since the email's sent-date, but was recorded today).
// Existing nodes: best-effort backfill. We don't know the actual occurrence
// time so we assume they became valid at insertion (valid_from = created_at)
// and were learned at insertion (recorded_at = created_at). Future writes
// should populate these explicitly when the source provides occurrence time.
try { db.exec("ALTER TABLE graph_nodes ADD COLUMN valid_from TEXT"); } catch {}
try { db.exec("ALTER TABLE graph_nodes ADD COLUMN valid_to TEXT"); } catch {}
try { db.exec("ALTER TABLE graph_nodes ADD COLUMN recorded_at TEXT"); } catch {}
try { db.exec("UPDATE graph_nodes SET valid_from = created_at WHERE valid_from IS NULL"); } catch {}
try { db.exec("UPDATE graph_nodes SET recorded_at = created_at WHERE recorded_at IS NULL"); } catch {}
// Index currently-valid nodes for fast "as-of now" queries
try { db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_active ON graph_nodes(user_id, domain, type) WHERE valid_to IS NULL"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_valid_from ON graph_nodes(user_id, valid_from)"); } catch {}
// Zero-invasion auto-populate trigger — any INSERT (including the 7 existing
// writer sites that predate bi-temporality) gets valid_from/recorded_at filled
// from created_at. Writers that want to backdate (scanner imports of old
// facts) can still set valid_from explicitly; the trigger only fires when
// the column is NULL. COALESCE guards against the NEW.created_at default
// race: if a caller supplies NULL for all time columns, SQLite's DEFAULT
// for created_at has already populated it by the time this trigger runs.
try { db.exec(`CREATE TRIGGER IF NOT EXISTS graph_nodes_bitemporal_default
  AFTER INSERT ON graph_nodes
  WHEN NEW.valid_from IS NULL OR NEW.recorded_at IS NULL
  BEGIN
    UPDATE graph_nodes SET
      valid_from  = COALESCE(NEW.valid_from,  NEW.created_at, datetime('now')),
      recorded_at = COALESCE(NEW.recorded_at, NEW.created_at, datetime('now'))
    WHERE id = NEW.id;
  END`); } catch {}

// Timeline events — per-event timestamped rows aggregated from unified scans.
// Events LINK to graph nodes via related_node_ids (JSON array) for node-centric
// timeline queries ("interactions with X this month") without exploding the
// graph into one node per commit/meeting/message.
try { db.exec(`CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  related_node_ids TEXT NOT NULL DEFAULT '[]',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_external ON timeline_events(user_id, external_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_timeline_time ON timeline_events(user_id, occurred_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_timeline_source ON timeline_events(user_id, source, occurred_at DESC)"); } catch {}

// OPT-4: run_id for trace correlation across tools + LLM calls
try { db.exec("ALTER TABLE agent_executions ADD COLUMN run_id TEXT"); } catch {}
try { db.exec("ALTER TABLE llm_calls ADD COLUMN run_id TEXT"); } catch {}
try { db.exec("ALTER TABLE llm_calls ADD COLUMN agent_name TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_exec_run ON agent_executions(run_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_llm_run ON llm_calls(run_id)"); } catch {}

// Prompt caching instrumentation — Anthropic reports cache tokens separately
// from regular input tokens. Store both so cost/hit-rate are observable.
try { db.exec("ALTER TABLE llm_calls ADD COLUMN cache_creation_tokens INTEGER"); } catch {}
try { db.exec("ALTER TABLE llm_calls ADD COLUMN cache_read_tokens INTEGER"); } catch {}

// Mutation proposals — L3 "eval-as-gate" infrastructure. Any learner
// (GEPA / Evolution / Skills) that wants to mutate system behavior
// submits a proposal here instead of applying directly. The gate
// runs eval fixtures against before/after; only accepted proposals
// get applied. Rejected ones are kept for audit.
try { db.exec(`CREATE TABLE IF NOT EXISTS mutation_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  eval_score REAL,
  eval_threshold REAL NOT NULL DEFAULT 0.8,
  eval_baseline_score REAL,
  eval_fixture_ids TEXT,
  eval_report_json TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  evaluated_at TEXT,
  applied_at TEXT
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_status ON mutation_proposals(status, created_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_source ON mutation_proposals(source, status, created_at DESC)"); } catch {}

// Workflow DAG — L4 orchestration upgrade. Replaces "blind parallel cron"
// with dependency-aware runs. workflow_defs holds the DAG; workflow_runs
// is per-execution; workflow_jobs tracks each node's outcome so a failed
// upstream can cascade-skip its dependents instead of letting them fire
// on stale data.
try { db.exec(`CREATE TABLE IF NOT EXISTS workflow_defs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  description TEXT,
  schedule TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  jobs_json TEXT NOT NULL,
  trigger_event TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  trigger_kind TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS workflow_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  handler TEXT NOT NULL,
  error TEXT,
  output_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  wave_index INTEGER
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_runs ON workflow_runs(workflow_id, started_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_jobs_run ON workflow_jobs(run_id, wave_index)"); } catch {}

// Memory lifecycle — track last access for Ebbinghaus-style decay + consolidation lineage.
try { db.exec("ALTER TABLE memories ADD COLUMN last_accessed_at TEXT"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN consolidated_from TEXT"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch {}
try { db.exec("UPDATE memories SET last_accessed_at = created_at WHERE last_accessed_at IS NULL"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_memories_status_conf ON memories(user_id, status, confidence DESC)"); } catch {}

// Bi-temporal memories: `recorded_at` is when Anchor ingested the memory
// (transaction time); `valid_from/valid_to` is when the referenced FACT
// is/was true (e.g., an observation about a meeting has valid_from = meeting
// date, recorded_at = when the memory was written). Recency decay in
// retrieval.ts should use recorded_at (freshness of ingestion) while
// semantic queries about "what did I know in March" use valid_from.
try { db.exec("ALTER TABLE memories ADD COLUMN valid_from TEXT"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN valid_to TEXT"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN recorded_at TEXT"); } catch {}
try { db.exec("UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL"); } catch {}
try { db.exec("UPDATE memories SET recorded_at = created_at WHERE recorded_at IS NULL"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(user_id, valid_from)"); } catch {}
// Same zero-invasion pattern — auto-populate bi-temporal fields on INSERT
// so the ~10 writeMemory call sites don't need to be touched. FTS triggers
// already defined above fire on INSERT too — SQLite runs all matching
// triggers; ordering doesn't matter since they target different columns.
try { db.exec(`CREATE TRIGGER IF NOT EXISTS memories_bitemporal_default
  AFTER INSERT ON memories
  WHEN NEW.valid_from IS NULL OR NEW.recorded_at IS NULL
  BEGIN
    UPDATE memories SET
      valid_from  = COALESCE(NEW.valid_from,  NEW.created_at, datetime('now')),
      recorded_at = COALESCE(NEW.recorded_at, NEW.created_at, datetime('now'))
    WHERE id = NEW.id;
  END`); } catch {}

// Memory arbitrations — contradictions too-serious-to-auto-resolve that
// the user needs to review. Low-confidence contradictions still get
// auto-merged by dream.ts. This queue is for pairs where BOTH sides
// have high confidence and a naive merge would lose information.
try { db.exec(`CREATE TABLE IF NOT EXISTS memory_arbitrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- memory | graph_edge | profile_claim
  left_id TEXT NOT NULL,              -- id of first item
  right_id TEXT NOT NULL,             -- id of second item
  left_preview TEXT,
  right_preview TEXT,
  topic TEXT,                         -- LLM-generated short label
  severity TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high
  status TEXT NOT NULL DEFAULT 'open',      -- open | resolved | ignored
  resolution TEXT,                    -- keep_left | keep_right | keep_both | custom
  resolution_note TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_arbitrations_status ON memory_arbitrations(status, created_at DESC)"); } catch {}

// Implicit feedback events — the training-signal ledger.
// Captures edit-distance on agent outputs, re-prompts, abandonment,
// tool rejections, and explicit thumbs. Stored as typed rows so future
// RLHF / DPO / on-policy learning can replay them without re-scraping
// any other table. <1% of real user feedback is explicit, so this
// ledger is where the learning signal actually lives.
try { db.exec(`CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- edit_distance | re_prompt | abandonment | tool_rejection | thumbs_up | thumbs_down | regeneration
  subject_type TEXT NOT NULL,    -- agent_output | tool_call | portrait_claim | graph_inference
  subject_id TEXT,               -- runId / toolUseId / claim id / node id
  agent_id TEXT,
  run_id TEXT,
  signal REAL NOT NULL DEFAULT 0, -- -1.0 (strong negative) .. +1.0 (strong positive)
  payload TEXT,                  -- JSON: edit_distance, original, modified, similarity_score, etc.
  source TEXT NOT NULL DEFAULT 'implicit_detector',  -- ui | cli | implicit_detector | cron
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_subject ON feedback_events(subject_type, subject_id, created_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback_events(agent_id, kind, created_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_run ON feedback_events(run_id)"); } catch {}

// Guardrail events — every classifier verdict on user input / tool results
// gets logged here so audits can reconstruct what was flagged and why.
// severity=block rows are the actual prevented attacks; warn/info are near-misses.
try { db.exec(`CREATE TABLE IF NOT EXISTS guardrail_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT,
  context TEXT NOT NULL,
  origin TEXT,
  severity TEXT NOT NULL,
  flags_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  preview TEXT,
  classifier_model TEXT,
  classifier_latency_ms INTEGER,
  fail_open INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_guardrail_run ON guardrail_events(run_id, created_at)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_guardrail_severity ON guardrail_events(severity, created_at DESC)"); } catch {}

// External MCP servers — inbound MCP (Anchor as client). Extends existing
// mcp_servers table (defined earlier) with columns needed for stdio
// transport + auto-connect + error tracking.
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN command TEXT"); } catch {}
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN args_json TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN last_connected_at TEXT"); } catch {}
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN last_error TEXT"); } catch {}
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_server_name ON mcp_servers(user_id, name)"); } catch {}

// Agent run checkpoints — every ReAct turn snapshots here so long-horizon
// runs survive crashes AND agents can request_user_input to pause cleanly
// and resume later. status lifecycle: running → interrupted | completed |
// failed | cancelled | abandoned (auto-set on boot for stale runs).
try { db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mission_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  turn INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL DEFAULT 25,
  user_message TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT NOT NULL DEFAULT '',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  final_text TEXT,
  interrupt_reason TEXT,
  interrupt_question TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, updated_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC)"); } catch {}

// L5 Execution rebuild: per-agent scoping for code execution + bridge access
try { db.exec("ALTER TABLE user_agents ADD COLUMN allowed_bridges TEXT NOT NULL DEFAULT '[\"*\"]'"); } catch {}
try { db.exec("ALTER TABLE user_agents ADD COLUMN allowed_dirs TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE user_agents ADD COLUMN network_policy TEXT NOT NULL DEFAULT 'bridge-only'"); } catch {}
try { db.exec("ALTER TABLE user_agents ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'local'"); } catch {}

// ── OpenClaw 4-layer + Hermes-style structured config (custom agents only) ──
// Adds Soul (durable identity), Body (role + responsibilities + constraints),
// Faculty (skills + read scopes), examples (few-shot), rhythm (trigger),
// vitality (lifecycle metrics) into a single JSON blob to avoid 12 ALTER
// TABLEs. The legacy `instructions` / `tools` / `trigger_type` / `trigger_config`
// columns stay authoritative for backward compat — config_json layers on top.
// SCOPE: custom agents only. System agents (decision/twin/council/dream) are
// untouched and continue to use their existing prompt code paths.
try { db.exec("ALTER TABLE user_agents ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"); } catch {}
// Same structure for user_crons — purpose, voice, pre-fire conditions,
// snooze_until, vitality. Existing legacy columns untouched.
try { db.exec("ALTER TABLE user_crons ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"); } catch {}

// One-shot backfill for legacy rows: derive a sensible default config from
// existing fields so the new buildSystemPromptFromConfig() helper can read
// them without crashing. Idempotent — only fills rows where config_json is
// the empty default '{}'.
try {
  const legacyAgents = db.prepare(
    "SELECT id, name, instructions, trigger_type, trigger_config, tools FROM user_agents WHERE config_json IN ('{}', '')"
  ).all() as any[];
  const upd = db.prepare("UPDATE user_agents SET config_json=? WHERE id=?");
  for (const a of legacyAgents) {
    const seed = {
      soul: {
        purpose: String(a.instructions ?? "").slice(0, 140),  // first ~140 chars as durable purpose
        voice: "",
        values: [],
      },
      body: {
        role: a.name,
        responsibilities: [],
        constraints: [],
      },
      faculty: {
        skills: [],
        read_scope: ["graph", "memory.semantic"],  // sensible default
      },
      examples: [],
      rhythm: {
        trigger_type: a.trigger_type ?? "manual",
        trigger_config: (() => { try { return JSON.parse(a.trigger_config ?? "{}"); } catch { return {}; } })(),
        proactive: false,
      },
      vitality: { success_count: 0, failure_count: 0 },
    };
    upd.run(JSON.stringify(seed), a.id);
  }
} catch {}

try {
  const legacyCrons = db.prepare(
    "SELECT id, name, cron_pattern FROM user_crons WHERE config_json IN ('{}', '')"
  ).all() as any[];
  const upd = db.prepare("UPDATE user_crons SET config_json=? WHERE id=?");
  for (const c of legacyCrons) {
    const seed = {
      purpose: String(c.name ?? ""),
      voice: "",
      conditions: [],            // empty = always fire when cron pattern matches
      vitality: { fire_count: 0, success_count: 0, failure_count: 0 },
      snooze_until: null,
    };
    upd.run(JSON.stringify(seed), c.id);
  }
} catch {}

// P3 Skill auto-extraction: record each execute_code success + crystallize repeats
try { db.exec(`
  CREATE TABLE IF NOT EXISTS agent_skill_candidates (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    code TEXT NOT NULL,
    lang TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_skill_cand_sig ON agent_skill_candidates(agent_id, signature)"); } catch {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS agent_skills (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    signature TEXT NOT NULL,
    template TEXT NOT NULL,
    lang TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_id, signature)
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id)"); } catch {}

// P4 Task Brain: unified job ledger with state machine (pending/running/succeeded/failed/retrying/cancelled)
try { db.exec(`
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT,
    action_type TEXT NOT NULL,
    action_config TEXT NOT NULL DEFAULT '{}',
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    result_summary TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_state_next ON agent_jobs(state, next_run_at)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_created ON agent_jobs(created_at DESC)"); } catch {}

// P6 Swarm: shared blackboard across agents participating in the same mission.
// mission_id is inherited by handoffs / delegates of a top-level agent run.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS mission_kv (
    mission_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (mission_id, key)
  )
`); } catch {}

// App Registry: unknown apps queued for batch LLM classification
try { db.exec(`
  CREATE TABLE IF NOT EXISTS unknown_apps (
    name TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    seen_count INTEGER NOT NULL DEFAULT 1,
    classified_at TEXT,
    classification_json TEXT
  )
`); } catch {}

// P7 Hooks: user-registered shell / agent callbacks on Anchor events.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS user_hooks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    matcher TEXT NOT NULL DEFAULT '{}',
    action_type TEXT NOT NULL,
    action_config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_at TEXT,
    fire_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_hooks_event_enabled ON user_hooks(event, enabled)"); } catch {}

// ── Event-sourced core: scanner_events + derivation_manifest ────────────────
// The single source of truth. All scanners emit append-only events here;
// the graph / memories / timeline are derived views. Two invariants:
//   (1) Append-only: events are never mutated or deleted (enforced by convention —
//       no UPDATE or DELETE code paths exist outside migrations).
//   (2) Hash chain: this_hash = sha256(prev_hash || id || payload). Any tamper
//       breaks the chain at that point and is detected by verifyHashChain().
// Design decisions:
//   - seq is monotonic (AUTOINCREMENT) so replay has a total order.
//   - id is the stable dedup key: sha256 of (source + kind + occurred_at +
//     stable fields from payload). Re-running a scanner on the same source
//     data produces the same ids → UNIQUE constraint suppresses duplicates.
//   - manifest_id captures the scanner's derivation config at ingestion time;
//     this is how we know *how* to replay an event later. Model upgrades
//     produce new manifest rows rather than mutating old ones.
try { db.exec(`CREATE TABLE IF NOT EXISTS derivation_manifest (
  id TEXT PRIMARY KEY,
  scanner TEXT NOT NULL,
  model_id TEXT,
  prompt_hash TEXT,
  temperature REAL NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_manifest_scanner ON derivation_manifest(scanner, model_id, prompt_hash)"); } catch {}

try { db.exec(`CREATE TABLE IF NOT EXISTS scanner_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  prev_hash TEXT,
  this_hash TEXT NOT NULL,
  manifest_id TEXT,
  FOREIGN KEY (manifest_id) REFERENCES derivation_manifest(id)
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_events_user_source ON scanner_events(user_id, source, occurred_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_events_occurred ON scanner_events(user_id, occurred_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_events_seq ON scanner_events(user_id, seq)"); } catch {}

// ── Contact aggregates — per-scan snapshots for cooling/warming analysis ────
// Why separate from scanner_events: scanner_events is immutable event stream
// for replay; contact_aggregates is derived aggregate state per scan — small,
// indexed for time-series queries. Each row is one (contact, source,
// direction) snapshot at a specific scan time.
// Cooling/warming works by comparing the count at snapshot_at=now vs
// snapshot_at=30-days-ago. If no 30-day-ago snapshot exists, the algorithm
// falls back to the raw timeline_events count (status quo).
try { db.exec(`CREATE TABLE IF NOT EXISTS contact_aggregates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  contact_node_id TEXT,
  contact_handle TEXT NOT NULL,
  contact_display_name TEXT,
  source TEXT NOT NULL,
  direction TEXT,
  count_in_window INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  first_at TEXT,
  last_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_contact_agg_user_time ON contact_aggregates(user_id, snapshot_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_contact_agg_contact ON contact_aggregates(user_id, contact_node_id, snapshot_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_contact_agg_handle ON contact_aggregates(user_id, contact_handle, source, direction, snapshot_at DESC)"); } catch {}
// Idempotency: one snapshot per (contact, source, direction, snapshot_at).
// Re-running demo seed, or scanner double-firing, returns to the same row via
// INSERT OR IGNORE. Handle must be non-null; snapshot_at carries the timestamp.
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_agg_key ON contact_aggregates(user_id, contact_handle, source, COALESCE(direction, ''), snapshot_at)"); } catch {}

// ── Long-horizon projects — state file + milestone tracking ─────────────────
// Anchor's version of Anthropic's claude-progress.txt pattern: a single JSON
// blob per project that the agent reads at session start and writes at
// session end. Survives conversation compactions, model swaps, device switches.
// Keeping state in SQLite rather than the FS means it's backup-covered and
// sync-covered for free. The JSON shape is intentionally schema-light (stored
// as TEXT): { goal, milestones: [{ name, status, notes, done_at }], notes,
// next_check_in, last_updated_by }. Structure evolves as agents need it.
try { db.exec(`CREATE TABLE IF NOT EXISTS project_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  next_check_in TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_projects_user_status ON project_state(user_id, status)"); } catch {}

// ── Prompt A/B (Sprint A — #7 Prompt experiments) ─────────────────────────
// Override-on-top-of-hardcoded model: source-code prompts stay as fallback,
// DB rows define active variants. No experiment row → zero overhead, code
// path identical to before. Hash-based traffic split (deterministic per key).
try { db.exec(`
  CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,                        -- e.g. "decision.system_prompt", "twin.reflect_prompt"
    description TEXT NOT NULL DEFAULT '',
    variant_a_value TEXT NOT NULL,            -- the prompt (or any string) for arm A
    variant_b_value TEXT NOT NULL,            -- the prompt for arm B
    traffic_split REAL NOT NULL DEFAULT 0.5,  -- fraction sent to A; B gets 1 - split
    status TEXT NOT NULL DEFAULT 'running',   -- 'running' | 'stopped' | 'promoted_a' | 'promoted_b'
    success_metric TEXT NOT NULL DEFAULT 'plan_confirmed',  -- which satisfaction_signal type counts as +1
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    winner TEXT,                              -- 'a' | 'b' | NULL
    notes TEXT NOT NULL DEFAULT ''
  )
`); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_experiments_key_running ON experiments(user_id, key) WHERE status='running'"); } catch {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS experiment_assignments (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    variant TEXT NOT NULL,                    -- 'a' | 'b'
    context_ref TEXT,                         -- e.g. message_id, session_id — for outcome attribution
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    outcome_signal TEXT,                      -- copied from satisfaction_signal type when attributed
    outcome_value REAL,                       -- the value
    outcome_at TEXT,
    FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_assignments_exp ON experiment_assignments(experiment_id, variant)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_assignments_ctxref ON experiment_assignments(context_ref)"); } catch {}

// ── Unified Approval Queue (Sprint B — #4) ────────────────────────────────
// Mirror table: existing 4 approval mechanisms (L6 gate require_confirmation,
// bridges/app-approval, cognition/proposals, agent_runs interrupted) keep
// writing to their own state. Each *also* enqueues a row here so the UI has
// one inbox. Decisions made here notify the source via 'source_ref_id'.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS approval_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,                 -- 'gate' | 'app' | 'proposal' | 'run' | 'step' (future)
    source_ref_id TEXT NOT NULL,          -- back-pointer (audit_id / app_identifier / proposal_id / run_id)
    title TEXT NOT NULL,                  -- "Send email to sarah@…", "Approve macOS Notes access", …
    summary TEXT NOT NULL DEFAULT '',     -- one-line description shown in list
    detail_json TEXT NOT NULL DEFAULT '{}',  -- arbitrary structured payload for the detail view
    risk_level TEXT NOT NULL DEFAULT 'medium', -- low|medium|high|critical
    status TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|rejected|expired|dismissed
    decided_by TEXT,                      -- 'user' | 'auto_expire' | 'auto_dismiss'
    decision_reason TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_approval_user_status ON approval_queue(user_id, status, created_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_approval_source ON approval_queue(source, source_ref_id)"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_source_ref ON approval_queue(source, source_ref_id) WHERE status='pending'"); } catch {}

// ── Plan-step Execution Sessions (Phase 1 of #2) ──────────────────────────
// Compiled plans land here as structured rows. SessionRunner (Phase 2) reads
// from these tables; for Phase 1 the rows are shadow — old runExecutionReAct
// still does the actual work, the new tables only enable UI visibility into
// the structured plan.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS action_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    source TEXT NOT NULL,                 -- 'advisor_confirm' | 'cron' | 'channel'
    source_ref_id TEXT,                   -- e.g. originating message id
    status TEXT NOT NULL DEFAULT 'pending',  -- compiling|pending|running|paused|completed|failed|cancelled
    current_step_id TEXT,
    plan_summary TEXT NOT NULL DEFAULT '',
    compile_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON action_sessions(user_id, status, created_at DESC)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_source ON action_sessions(source, source_ref_id)"); } catch {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS action_steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    name TEXT NOT NULL,                   -- natural language line (user-confirmed)
    type TEXT NOT NULL,                   -- query|draft|side_effect|approval|verify
    runtime TEXT NOT NULL,                -- llm|cli|browser|local_app|db|human
    tool TEXT,                            -- registry tool name; NULL for human/approval
    input_template_json TEXT NOT NULL DEFAULT '{}', -- mustache refs to prior steps
    input_resolved_json TEXT,             -- runtime-filled (Phase 2)
    status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|awaiting_approval|succeeded|failed|skipped|retrying
    approval_required INTEGER NOT NULL DEFAULT 0,
    approval_decision TEXT,               -- approved|rejected|NULL
    output_text TEXT,
    observation_json TEXT,                -- Phase 3 fills (structured per runtime)
    verify_rule TEXT,
    verify_status TEXT NOT NULL DEFAULT 'unknown',  -- unknown|pass|fail
    verify_evidence TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 1,
    depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES action_sessions(id) ON DELETE CASCADE
  )
`); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_steps_session_index ON action_steps(session_id, step_index)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_steps_status ON action_steps(status)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_steps_session_status ON action_steps(session_id, status)"); } catch {}

seedIfEmpty();

/** Shared agent execution logger — replaces duplicate log() in 19 files. */
export function logExecution(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

export { DEFAULT_USER_ID };
