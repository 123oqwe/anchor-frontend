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

// OPT-4: run_id for trace correlation across tools + LLM calls
try { db.exec("ALTER TABLE agent_executions ADD COLUMN run_id TEXT"); } catch {}
try { db.exec("ALTER TABLE llm_calls ADD COLUMN run_id TEXT"); } catch {}
try { db.exec("ALTER TABLE llm_calls ADD COLUMN agent_name TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_exec_run ON agent_executions(run_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_llm_run ON llm_calls(run_id)"); } catch {}

// L5 Execution rebuild: per-agent scoping for code execution + bridge access
try { db.exec("ALTER TABLE user_agents ADD COLUMN allowed_bridges TEXT NOT NULL DEFAULT '[\"*\"]'"); } catch {}
try { db.exec("ALTER TABLE user_agents ADD COLUMN allowed_dirs TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE user_agents ADD COLUMN network_policy TEXT NOT NULL DEFAULT 'bridge-only'"); } catch {}
try { db.exec("ALTER TABLE user_agents ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'local'"); } catch {}

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

seedIfEmpty();

/** Shared agent execution logger — replaces duplicate log() in 19 files. */
export function logExecution(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

export { DEFAULT_USER_ID };
