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
    ];
    const ins = db.prepare("INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail) VALUES (?,?,?,?,?,?,?,?)");
    for (const n of nodes) ins.run(nanoid(), ...n);

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

seedIfEmpty();

export { DEFAULT_USER_ID };
