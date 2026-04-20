/**
 * Desktop Activity Monitor — captures what you're DOING, not just what you HAVE.
 *
 * Every 5 minutes: captures active window (app + title).
 * Every hour: aggregates into time-per-app, time-per-project, communication patterns.
 * Every 6 hours: updates Human Graph with real behavioral data.
 *
 * This is the difference between a photo (static scan) and a documentary (continuous monitoring).
 */
import { execSync } from "child_process";
import { db, DEFAULT_USER_ID } from "../../infra/storage/db.js";
import { nanoid } from "nanoid";

// ── Activity capture table ──────────────────────────────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_captures (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      window_title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_captures(user_id, captured_at);
  `);
} catch {}

try { db.exec("ALTER TABLE activity_captures ADD COLUMN url TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE activity_captures ADD COLUMN content TEXT NOT NULL DEFAULT ''"); } catch {}

// ── Capture current active window ───────────────────────────────────────────

/** Read visible text from the active window via Accessibility API (macOS). */
function readScreenText(appName: string): string {
  try {
    // For editors: read the document name + visible content hint
    if (["Cursor", "Visual Studio Code", "Xcode", "Terminal"].includes(appName)) {
      const result = execSync(
        `osascript -e 'tell application "System Events" to tell process "${appName}"
          try
            set focusedEl to value of attribute "AXFocusedUIElement" of application process "${appName}"
            return focusedEl
          on error
            return ""
          end try
        end tell'`,
        { timeout: 2000, encoding: "utf-8" }
      ).trim();
      return result.slice(0, 500);
    }

    // For browsers: read page title (already have URL, title gives more context)
    if (["Google Chrome", "Safari", "Arc"].includes(appName)) {
      // Title already captured, skip deep reading
      return "";
    }

    // For communication apps: read the focused text element
    if (["Slack", "Discord", "Telegram", "WeChat", "Mail", "Messages"].includes(appName)) {
      const result = execSync(
        `osascript -e 'tell application "System Events" to tell process "${appName}"
          try
            return value of text area 1 of scroll area 1 of window 1
          on error
            try
              return description of window 1
            on error
              return ""
            end try
          end try
        end tell'`,
        { timeout: 2000, encoding: "utf-8" }
      ).trim();
      // Truncate and filter sensitive content
      const text = result.slice(0, 500);
      // Don't capture if it looks like a password or credit card
      if (/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(text)) return "";
      if (/password|credential|secret|token/i.test(text)) return "";
      return text;
    }

    return "";
  } catch {
    return "";
  }
}

export function captureActiveWindow(): { app: string; title: string; url: string; content: string } | null {
  try {
    const result = execSync(
      `osascript -e 'tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        try
          set winTitle to name of front window of first application process whose frontmost is true
        on error
          set winTitle to ""
        end try
        return frontApp & "|" & winTitle
      end tell'`,
      { timeout: 3000, encoding: "utf-8" }
    ).trim();

    const [app, title] = result.split("|", 2);
    if (!app) return null;

    // Capture browser URL if active app is a browser
    let url = "";
    const browserApp = app?.trim();
    if (browserApp === "Google Chrome" || browserApp === "Safari" || browserApp === "Arc") {
      try {
        if (browserApp === "Google Chrome") {
          url = execSync(
            `osascript -e 'tell application "Google Chrome" to return URL of active tab of front window'`,
            { timeout: 2000, encoding: "utf-8" }
          ).trim();
        } else if (browserApp === "Safari") {
          url = execSync(
            `osascript -e 'tell application "Safari" to return URL of front document'`,
            { timeout: 2000, encoding: "utf-8" }
          ).trim();
        } else if (browserApp === "Arc") {
          url = execSync(
            `osascript -e 'tell application "Arc" to return URL of active tab of front window'`,
            { timeout: 2000, encoding: "utf-8" }
          ).trim();
        }
      } catch {}
    }

    // Read screen text content (Littlebird-inspired)
    const content = readScreenText(app.trim());

    // Save to DB
    db.prepare("INSERT INTO activity_captures (id, user_id, app_name, window_title, url, content, captured_at) VALUES (?,?,?,?,?,?,datetime('now'))")
      .run(nanoid(), DEFAULT_USER_ID, app.trim(), (title ?? "").trim(), url, content);

    return { app: app.trim(), title: (title ?? "").trim(), url, content };
  } catch {
    return null;
  }
}

// ── Aggregate: time per app (last N hours) ──────────────────────────────────

export interface AppTimeEntry {
  app: string;
  minutes: number;
  percentage: number;
  category: string;
}

const APP_CATEGORIES: Record<string, string> = {
  "Cursor": "coding", "Visual Studio Code": "coding", "Xcode": "coding", "Terminal": "coding",
  "Google Chrome": "browser", "Safari": "browser", "Arc": "browser",
  "Claude": "ai", "ChatGPT": "ai", "Codex": "ai",
  "Slack": "communication", "Telegram": "communication", "WeChat": "communication", "Discord": "communication",
  "Mail": "communication", "Zoom": "communication", "Microsoft Teams": "communication",
  "Figma": "design", "Sketch": "design",
  "rekordbox": "music", "Serato DJ Pro": "music", "GarageBand": "music",
  "Douyin": "distraction", "TikTok": "distraction",
  "Finder": "system", "System Settings": "system", "Preview": "system",
};

export function getTimeByApp(hours = 24): AppTimeEntry[] {
  const rows = db.prepare(`
    SELECT app_name, COUNT(*) as captures
    FROM activity_captures
    WHERE user_id=? AND captured_at >= datetime('now', '-${hours} hours')
    GROUP BY app_name ORDER BY captures DESC
  `).all(DEFAULT_USER_ID) as any[];

  const total = rows.reduce((s: number, r: any) => s + r.captures, 0);
  if (total === 0) return [];

  // Each capture = 5 minutes of activity
  return rows.map((r: any) => ({
    app: r.app_name,
    minutes: r.captures * 5,
    percentage: Math.round((r.captures / total) * 100),
    category: APP_CATEGORIES[r.app_name] ?? "other",
  }));
}

// ── Infer project from window title ─────────────────────────────────────────

export interface ProjectTime {
  project: string;
  minutes: number;
  source: string; // "Cursor — file path" or "Chrome — tab title"
}

export function getTimeByProject(hours = 24): ProjectTime[] {
  const rows = db.prepare(`
    SELECT app_name, window_title, COUNT(*) as captures
    FROM activity_captures
    WHERE user_id=? AND captured_at >= datetime('now', '-${hours} hours')
    AND window_title != ''
    GROUP BY app_name, window_title ORDER BY captures DESC LIMIT 30
  `).all(DEFAULT_USER_ID) as any[];

  const projects = new Map<string, { minutes: number; source: string }>();

  for (const r of rows) {
    const title: string = r.window_title;
    const app: string = r.app_name;
    const mins = r.captures * 5;

    let project = "";

    // Infer project from editor window titles
    if (app === "Cursor" || app === "Visual Studio Code") {
      // "anchor-ui/server/cognition/decision.ts" → "anchor-ui"
      const match = title.match(/^([^\/\\]+)/);
      if (match) project = match[1].trim();
    }
    // Infer from Chrome tab titles
    else if (app === "Google Chrome" || app === "Safari" || app === "Arc") {
      if (title.includes("| LinkedIn")) project = "LinkedIn Networking";
      else if (title.includes("Gmail") || title.includes("mail")) project = "Email";
      else if (title.includes("GitHub")) project = "GitHub";
      else if (title.includes("ChatGPT") || title.includes("Claude") || title.includes("claude.ai")) project = "AI Research";
    }
    // Direct app = project
    else if (["rekordbox", "Serato DJ Pro", "GarageBand", "Splice"].includes(app)) {
      project = "Music Production";
    }
    else if (["Douyin", "TikTok"].includes(app)) {
      project = "Distraction";
    }

    if (project) {
      const existing = projects.get(project);
      if (existing) {
        existing.minutes += mins;
      } else {
        projects.set(project, { minutes: mins, source: `${app}: ${title.slice(0, 50)}` });
      }
    }
  }

  return Array.from(projects.entries())
    .map(([project, data]) => ({ project, ...data }))
    .sort((a, b) => b.minutes - a.minutes);
}

// ── Infer relationship strength from browsing behavior ──────────────────────

export interface PersonActivity {
  name: string;
  interactions: number; // how many times their name appeared in window titles
  lastSeen: string;
}

export function getPersonActivity(hours = 168): PersonActivity[] { // 168h = 1 week
  // Find person names that appeared in window titles (LinkedIn, email, etc.)
  const people = db.prepare("SELECT label FROM graph_nodes WHERE user_id=? AND type='person'").all(DEFAULT_USER_ID) as any[];
  if (people.length === 0) return [];

  const results: PersonActivity[] = [];

  for (const p of people) {
    const firstName = p.label.split(/[\s(]/)[0];
    if (firstName.length < 2) continue;

    const count = db.prepare(`
      SELECT COUNT(*) as c, MAX(captured_at) as last_seen
      FROM activity_captures
      WHERE user_id=? AND window_title LIKE ? AND captured_at >= datetime('now', '-${hours} hours')
    `).get(DEFAULT_USER_ID, `%${firstName}%`) as any;

    if (count.c > 0) {
      results.push({ name: p.label, interactions: count.c, lastSeen: count.last_seen });
    }
  }

  return results.sort((a, b) => b.interactions - a.interactions);
}

// ── Update graph nodes based on activity data ───────────────────────────────

export function updateGraphFromActivity(): { updated: number; insights: string[] } {
  const insights: string[] = [];
  let updated = 0;

  // 1. Update project node importance based on time spent
  const projectTime = getTimeByProject(24);
  for (const pt of projectTime) {
    if (pt.project === "Distraction" || pt.project === "Email") continue;

    // Find matching graph node
    const node = db.prepare(
      "SELECT id, label, status FROM graph_nodes WHERE user_id=? AND type IN ('project','goal') AND label LIKE ?"
    ).get(DEFAULT_USER_ID, `%${pt.project.split(" ")[0]}%`) as any;

    if (node) {
      // Update the node's updated_at to reflect recent activity
      db.prepare("UPDATE graph_nodes SET updated_at=datetime('now') WHERE id=?").run(node.id);
      updated++;
    }
  }

  // 2. Update relationship strength based on actual interactions
  const personActivity = getPersonActivity(168); // last week
  for (const pa of personActivity) {
    if (pa.interactions >= 3) {
      const node = db.prepare(
        "SELECT id FROM graph_nodes WHERE user_id=? AND type='person' AND label LIKE ?"
      ).get(DEFAULT_USER_ID, `%${pa.name.split(/[\s(]/)[0]}%`) as any;

      if (node) {
        db.prepare("UPDATE graph_nodes SET updated_at=datetime('now'), detail=? WHERE id=?")
          .run(`${pa.interactions} interactions this week | Last seen: ${pa.lastSeen?.slice(0, 16)}`, node.id);
        updated++;
      }
    }
  }

  // 3. Detect distraction patterns
  const distractionTime = projectTime.find(p => p.project === "Distraction");
  if (distractionTime && distractionTime.minutes > 60) {
    insights.push(`${distractionTime.minutes} minutes on distracting apps today`);
  }

  // 4. Detect overwork
  const totalScreenTime = getTimeByApp(24).reduce((s, a) => s + a.minutes, 0);
  if (totalScreenTime > 600) { // 10+ hours
    insights.push(`${Math.round(totalScreenTime / 60)} hours of screen time today — consider taking a break`);
  }

  return { updated, insights };
}

// ── Status for API ──────────────────────────────────────────────────────────

export function getActivityStatus() {
  const captureCount = (db.prepare(
    "SELECT COUNT(*) as c FROM activity_captures WHERE user_id=? AND captured_at >= datetime('now', '-24 hours')"
  ).get(DEFAULT_USER_ID) as any)?.c ?? 0;

  const topApps = getTimeByApp(24).slice(0, 5);
  const topProjects = getTimeByProject(24).slice(0, 5);

  return {
    capturesLast24h: captureCount,
    monitoring: captureCount > 0,
    topApps,
    topProjects,
    totalScreenMinutes: topApps.reduce((s, a) => s + a.minutes, 0),
  };
}

// ── Daily activity summary (Littlebird-inspired) ──────────────────────────

export function generateActivitySummary(hours = 24): {
  totalMinutes: number;
  topApps: { app: string; minutes: number }[];
  activities: { time: string; app: string; detail: string }[];
  meetings: { title: string; duration: number }[];
  contentHighlights: string[];
} {
  const appTime = getTimeByApp(hours);
  const totalMinutes = appTime.reduce((s, a) => s + a.minutes, 0);

  // Get distinct activities with content
  const activities = db.prepare(`
    SELECT app_name, window_title, url, content, captured_at
    FROM activity_captures
    WHERE user_id=? AND captured_at >= datetime('now', '-${hours} hours')
    AND window_title != ''
    ORDER BY captured_at DESC LIMIT 50
  `).all(DEFAULT_USER_ID) as any[];

  // Deduplicate by window_title (keep most recent)
  const seen = new Set<string>();
  const uniqueActivities = activities.filter((a: any) => {
    const key = a.app_name + "|" + a.window_title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20).map((a: any) => ({
    time: a.captured_at?.slice(11, 16) ?? "",
    app: a.app_name,
    detail: a.url ? `${a.window_title} (${a.url.slice(0, 60)})` : a.window_title,
  }));

  // Detect meetings (Zoom/Teams/Meet in app name or title)
  const meetingCaptures = db.prepare(`
    SELECT window_title, MIN(captured_at) as start_time, COUNT(*) as captures
    FROM activity_captures
    WHERE user_id=? AND captured_at >= datetime('now', '-${hours} hours')
    AND (app_name IN ('zoom.us', 'Microsoft Teams', 'FaceTime')
         OR window_title LIKE '%meeting%' OR window_title LIKE '%Meet -%')
    GROUP BY window_title
  `).all(DEFAULT_USER_ID) as any[];

  const meetings = meetingCaptures.map((m: any) => ({
    title: m.window_title,
    duration: m.captures * 5, // each capture = 5 min
  }));

  // Content highlights (non-empty content entries)
  const contentRows = db.prepare(`
    SELECT DISTINCT content FROM activity_captures
    WHERE user_id=? AND content != '' AND captured_at >= datetime('now', '-${hours} hours')
    ORDER BY captured_at DESC LIMIT 10
  `).all(DEFAULT_USER_ID) as any[];

  const contentHighlights = contentRows.map((r: any) => r.content.slice(0, 100));

  return {
    totalMinutes,
    topApps: appTime.slice(0, 5).map(a => ({ app: a.app, minutes: a.minutes })),
    activities: uniqueActivities,
    meetings,
    contentHighlights,
  };
}

// ── Cleanup old captures (keep last 30 days) ────────────────────────────────

export function cleanupOldCaptures(): number {
  const result = db.prepare(
    "DELETE FROM activity_captures WHERE user_id=? AND captured_at < datetime('now', '-30 days')"
  ).run(DEFAULT_USER_ID);
  return result.changes;
}
