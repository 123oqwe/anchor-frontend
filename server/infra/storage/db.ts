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
`);

// ─── Default user seed ────────────────────────────────────────────────────────

const DEFAULT_USER_ID = "user_default";

function seedIfEmpty() {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(DEFAULT_USER_ID);
  if (user) return;

  const run = db.transaction(() => {
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?)").run(
      DEFAULT_USER_ID, "Anchor User", "user@anchor.ai", "Founder"
    );

    db.prepare("INSERT INTO user_state (user_id) VALUES (?)").run(DEFAULT_USER_ID);
    db.prepare("INSERT INTO settings (user_id) VALUES (?)").run(DEFAULT_USER_ID);
    db.prepare("INSERT INTO twin_evolution (user_id, xp) VALUES (?, ?)").run(DEFAULT_USER_ID, 127);

    // Graph nodes
    const nodes = [
      [DEFAULT_USER_ID, "work", "YC Application", "goal", "delayed", "Command input, 3 days ago", "Delayed 3 times. Highest priority — completing unlocks 2 downstream tasks."],
      [DEFAULT_USER_ID, "work", "Product Roadmap v2", "goal", "active", "Workspace project creation", "On track. 60% complete, next milestone: user testing framework."],
      [DEFAULT_USER_ID, "work", "Technical Architecture", "task", "in-progress", "Advisor conversation, 2 days ago", "Backend integration plan drafted. Needs CTO review."],
      [DEFAULT_USER_ID, "work", "Hire CTO", "opportunity", "active", "Email thread analysis", "3 candidates in pipeline. Alex Rivera strongest — schedule intro call."],
      [DEFAULT_USER_ID, "work", "Team Standup", "task", "overdue", "Calendar sync", "Missed last 2 standups. Team morale risk detected."],
      [DEFAULT_USER_ID, "relationships", "Matt Zhang", "person", "decaying", "Calendar sync, last meeting 5 days ago", "3 days silent. Previously discussed Series B prep — should follow up."],
      [DEFAULT_USER_ID, "relationships", "Sarah Chen (Sequoia)", "person", "decaying", "Email thread analysis", "Investor contact. Follow-up overdue by 4 days."],
      [DEFAULT_USER_ID, "relationships", "Alex Rivera (CTO candidate)", "person", "opportunity", "LinkedIn + email", "Strong technical background. Intro call not yet scheduled."],
      [DEFAULT_USER_ID, "relationships", "Co-founder Alignment", "pattern", "stable", "Meeting analysis", "Communication frequency healthy. Last sync: yesterday."],
      [DEFAULT_USER_ID, "finance", "Pre-Seed Fundraising", "goal", "active", "Workspace project", "$500K target. 2 warm intros pending. Pitch deck needs metrics update."],
      [DEFAULT_USER_ID, "finance", "Investor Follow-up", "task", "overdue", "Draft center, auto-detected", "3 investor emails pending response. Average delay: 4 days."],
      [DEFAULT_USER_ID, "finance", "Runway Calculation", "task", "todo", "Advisor suggestion", "Current burn rate unknown. Should calculate before next investor meeting."],
      [DEFAULT_USER_ID, "growth", "Decision Pattern: Avoidance", "pattern", "worsening", "Twin Agent analysis, 3 months", "You delay high-stakes decisions by 2-3 days. Writing tasks are most avoided."],
      [DEFAULT_USER_ID, "growth", "Productivity Cycle", "pattern", "stable", "Behavioral analysis", "Peak: 10am-1pm. Significant drop after 3pm. Optimize scheduling accordingly."],
      [DEFAULT_USER_ID, "growth", "Communication Style", "pattern", "evolving", "Email + message analysis", "Becoming more concise over time. Prefer async over sync communication."],
      [DEFAULT_USER_ID, "health", "Sleep Pattern", "pattern", "declining", "Behavioral inference", "Average 5.5h last week. Below your 7h baseline. Affects afternoon energy."],
      [DEFAULT_USER_ID, "health", "Exercise Routine", "task", "inactive", "Calendar gap analysis", "No exercise events detected in 2 weeks. Previously 3x/week."],
      // Values, Constraints, Preferences — so Decision Agent has a constitution from day 1
      [DEFAULT_USER_ID, "growth", "Build something meaningful", "value", "stable", "Onboarding", "Core motivation: create technology that genuinely helps people make better decisions."],
      [DEFAULT_USER_ID, "growth", "Honesty over comfort", "value", "stable", "Onboarding", "Prefer direct feedback even when uncomfortable. Don't sugarcoat."],
      [DEFAULT_USER_ID, "finance", "Runway: 6 months", "constraint", "active", "Finance tracking", "Current runway is approximately 6 months at current burn rate. Hard deadline."],
      [DEFAULT_USER_ID, "work", "YC Deadline: This Friday", "constraint", "active", "Calendar", "YC W26 application due this Friday. Non-negotiable."],
      [DEFAULT_USER_ID, "growth", "Async over sync", "preference", "stable", "Communication analysis", "Strongly prefers email and Slack over phone calls and video meetings."],
      [DEFAULT_USER_ID, "growth", "Deep work mornings", "preference", "stable", "Productivity analysis", "Most productive 10am-1pm. Protect this block for high-stakes work."],
    ];
    const ins = db.prepare("INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail) VALUES (?,?,?,?,?,?,?,?)");
    const nodeIds: string[] = [];
    for (const n of nodes) { const id = nanoid(); ins.run(id, ...n); nodeIds.push(id); }

    // Seed edges (relationships between nodes)
    // nodeIds index matches nodes array order above
    const insEdge = db.prepare("INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, type, weight) VALUES (?,?,?,?,?,?)");
    const seedEdges: [number, number, string, number][] = [
      // YC Application depends_on Product Roadmap
      [0, 1, "depends_on", 1.0],
      // Technical Architecture supports YC Application
      [2, 0, "supports", 0.8],
      // Hire CTO supports Product Roadmap
      [3, 1, "supports", 0.9],
      // Team Standup supports Product Roadmap
      [4, 1, "supports", 0.5],
      // Matt Zhang contextual to Product Roadmap
      [5, 1, "contextual", 0.7],
      // Sarah Chen contextual to Pre-Seed Fundraising
      [6, 9, "contextual", 0.9],
      // Alex Rivera contextual to Hire CTO
      [7, 3, "contextual", 0.8],
      // Pre-Seed Fundraising depends_on YC Application
      [9, 0, "depends_on", 0.7],
      // Investor Follow-up supports Pre-Seed Fundraising
      [10, 9, "supports", 0.8],
      // Decision Pattern threatens YC Application (avoidance causes delay)
      [12, 0, "threatens", 0.6],
    ];
    for (const [fromIdx, toIdx, type, weight] of seedEdges) {
      if (nodeIds[fromIdx] && nodeIds[toIdx]) {
        insEdge.run(nanoid(), DEFAULT_USER_ID, nodeIds[fromIdx], nodeIds[toIdx], type, weight);
      }
    }

    // Memories
    const mems = [
      [DEFAULT_USER_ID, "working", "YC Application — Current Focus", "Active task: Refine 'Why Now' section. Key angle: behavioral insight + market timing. Co-founder feedback pending. Deadline: This Friday.", '["YC","application","active"]', "Workspace project", 0.95],
      [DEFAULT_USER_ID, "episodic", "Meeting with Matt Zhang — Product Strategy", "Discussed go-to-market strategy for Anchor. Matt suggested focusing on founder persona first. Agreed to follow up with detailed user journey. Matt mentioned potential intro to a16z partner.", '["Matt Zhang","strategy","meeting"]', "Calendar + conversation analysis", 0.88],
      [DEFAULT_USER_ID, "episodic", "Investor Call — Pre-Seed Discussion", "30-min call with Sarah Chen from Sequoia Scout. She was interested in the Human Graph concept. Asked about defensibility and data moat. Follow-up requested with technical architecture doc.", '["investor","Sequoia","fundraising"]', "Call transcript analysis", 0.82],
      [DEFAULT_USER_ID, "semantic", "Decision Pattern: Avoidance Behavior", "Long-term pattern: You tend to delay confrontation-related tasks by an average of 4.2 days. This pattern has been consistent across 23 observed instances.", '["pattern","avoidance","behavioral"]', "Twin Agent behavioral analysis", 0.91],
      [DEFAULT_USER_ID, "semantic", "Preference: Communication Style", "You prefer concise emails averaging 47 words. Response rate increases 34% when emails contain a specific ask in the first sentence.", '["preference","email","communication"]', "Email pattern analysis", 0.87],
      [DEFAULT_USER_ID, "working", "CTO Search — Active Pipeline", "3 candidates in review. Alex Rivera top choice — ex-CTO of YC W22 startup, strong distributed systems background. Intro call not yet scheduled.", '["CTO","hiring","pipeline"]', "Workspace + email analysis", 0.92],
    ];
    const insMem = db.prepare("INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)");
    for (const m of mems) insMem.run(nanoid(), ...m);

    // Projects
    const p1id = nanoid(), p2id = nanoid(), p3id = nanoid();
    db.prepare("INSERT INTO projects (id, user_id, name, description, color) VALUES (?,?,?,?,?)").run(p1id, DEFAULT_USER_ID, "YC Application", "Complete and submit Y Combinator W26 application", "bg-blue-500");
    db.prepare("INSERT INTO projects (id, user_id, name, description, color) VALUES (?,?,?,?,?)").run(p2id, DEFAULT_USER_ID, "CTO Hiring Pipeline", "Find and onboard a technical co-founder / CTO", "bg-emerald-500");
    db.prepare("INSERT INTO projects (id, user_id, name, description, color) VALUES (?,?,?,?,?)").run(p3id, DEFAULT_USER_ID, "Fundraising — Pre-Seed", "Close $500K pre-seed round", "bg-amber-500");

    const insTask = db.prepare("INSERT INTO tasks (id, project_id, parent_id, title, status, priority, tags, due_date) VALUES (?,?,?,?,?,?,?,?)");
    const t1id = nanoid(), t2id = nanoid(), t3id = nanoid(), t4id = nanoid();
    insTask.run(t1id, p1id, null, "Refine 'Why Now' section", "in-progress", "high", '["writing","deadline"]', "Tomorrow");
    insTask.run(nanoid(), p1id, t1id, "Research market timing data", "done", "medium", "[]", null);
    insTask.run(nanoid(), p1id, t1id, "Draft behavioral insight angle", "in-progress", "high", "[]", null);
    insTask.run(nanoid(), p1id, t1id, "Get co-founder review", "todo", "medium", "[]", null);
    insTask.run(nanoid(), p1id, null, "Record 1-minute founder video", "todo", "medium", '["video","creative"]', "Friday");
    insTask.run(nanoid(), p1id, null, "Finalize team section", "done", "low", '["writing"]', null);
    insTask.run(nanoid(), p1id, null, "Technical architecture appendix", "todo", "medium", '["technical"]', "Thursday");
    insTask.run(nanoid(), p2id, null, "Schedule intro call with Alex Rivera", "in-progress", "high", '["urgent"]', "Thursday");
    insTask.run(nanoid(), p2id, null, "Review 2 other candidates", "todo", "medium", '["review"]', null);
    insTask.run(nanoid(), p2id, null, "Prepare technical assessment", "done", "medium", '["assessment"]', null);
    insTask.run(nanoid(), p3id, null, "Follow up with Sarah Chen/Sequoia", "blocked", "high", '["investor","overdue"]', "Overdue");
    insTask.run(nanoid(), p3id, null, "Prepare technical architecture doc", "todo", "high", '["technical"]', "Next week");
    insTask.run(nanoid(), p3id, null, "Update pitch deck", "todo", "medium", '["deck"]', null);

    // Agent executions seed
    const insExec = db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)");
    insExec.run(nanoid(), DEFAULT_USER_ID, "Decision Agent", "Priority inference — surfaced YC application", "success");
    insExec.run(nanoid(), DEFAULT_USER_ID, "Observation Agent", "Scanned 14 new emails, 3 calendar events", "success");
    insExec.run(nanoid(), DEFAULT_USER_ID, "Memory Agent", "Indexed 5 new memory items", "success");
    insExec.run(nanoid(), DEFAULT_USER_ID, "Twin Agent", "Updated behavioral pattern confidence scores", "success");

    // Twin quests
    const insQuest = db.prepare("INSERT INTO twin_quests (id, user_id, name, description, progress, total, xp_reward, completed) VALUES (?,?,?,?,?,?,?,?)");
    insQuest.run(nanoid(), DEFAULT_USER_ID, "First 50 Interactions", "Complete 50 conversations with your advisor", 50, 50, 30, 1);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "State Check-in Streak", "Update your state 7 days in a row", 7, 7, 20, 1);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Graph Calibration", "Add 14 nodes to your Human Graph", 14, 14, 50, 1);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Approve 20 Drafts", "Review and approve 20 AI-generated drafts", 16, 20, 40, 0);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Follow 10 Suggestions", "Act on 10 advisor suggestions", 7, 10, 35, 0);
    insQuest.run(nanoid(), DEFAULT_USER_ID, "Avoidance Breakthrough", "Complete 3 tasks you previously avoided", 2, 3, 50, 0);

    // Twin insights
    const insInsight = db.prepare("INSERT INTO twin_insights (id, user_id, category, insight, confidence, trend) VALUES (?,?,?,?,?,?)");
    insInsight.run(nanoid(), DEFAULT_USER_ID, "Decision Style", "Delays high-stakes decisions 2-3 days. When you do act, 78% lead to positive outcomes.", 0.82, "stable");
    insInsight.run(nanoid(), DEFAULT_USER_ID, "Risk Preference", "Moderate risk tolerance for business decisions, conservative for personal. Avoids confrontation.", 0.75, "evolving");
    insInsight.run(nanoid(), DEFAULT_USER_ID, "Behavioral Pattern", "Peak productivity 10am-1pm. Energy drops significantly after 3pm. Procrastinates on writing tasks.", 0.91, "stable");

    // Initial advisor messages
    const insMsgStmt = db.prepare("INSERT INTO messages (id, user_id, mode, role, content, draft_type, draft_status, agent_name) VALUES (?,?,?,?,?,?,?,?)");
    insMsgStmt.run(nanoid(), DEFAULT_USER_ID, "personal", "advisor",
      "Based on your Human Graph, I see 3 areas needing attention. Your YC application has been delayed 3 times — this is your highest priority. You're also avoiding investor follow-ups. Would you like me to create a focused plan?",
      null, null, null);
    insMsgStmt.run(nanoid(), DEFAULT_USER_ID, "general", "advisor",
      "General mode connected. I can help with any question — research, analysis, writing, brainstorming. Unlike Personal mode, I don't reference your Human Graph here. What would you like to explore?",
      null, null, null);
    insMsgStmt.run(nanoid(), DEFAULT_USER_ID, "agent", "advisor",
      "Agent Mode active. Describe what you need done, and I'll create a specialized agent to execute it. The agent will generate a plan, show you each step, and only execute with your approval.",
      null, null, null);
  });

  run();
  console.log("✅ Database seeded with default data");
}

// Migrate: add new columns to skills table (safe for existing DBs)
try { db.exec("ALTER TABLE skills ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN last_used TEXT"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN success_rate REAL NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN context_conditions TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'dream_engine'"); } catch {}

seedIfEmpty();

export { DEFAULT_USER_ID };
