/**
 * Tasks Unification — one view of "what you're trying to do".
 *
 * Anchor's agent capability ("help me do X") depends on knowing the user's
 * ACTUAL todo state. Tasks scattered across Things / Reminders / Linear /
 * Jira / Notion = no single source of truth = agents can't prioritize.
 *
 * Sources ranked by extractability on macOS:
 *   full-content:    Apple Reminders (AppleScript, needs TCC Reminders),
 *                    Things (SQLite at ThingsData-N/main.sqlite)
 *   metadata-only:   OmniFocus (its bundle — partial, fragile)
 *   api-only:        Todoist, TickTick, Linear, Jira, Asana (OAuth)
 *   presence-only:   detected app, no integration
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

const HOME = os.homedir();
const APPS = ["/Applications", path.join(HOME, "Applications")];

export type TasksTier = "full-content" | "metadata-only" | "api-only" | "presence-only";

export interface TaskApp {
  appId: string;
  displayName: string;
  installed: boolean;
  active: boolean;
  tier: TasksTier;
  openCount?: number;
  overdueCount?: number;
  completedLast7d?: number;
  topProjects?: string[];
  recentTasks?: string[];
  permissionNeeded?: string;
}

export interface TasksUnifiedSummary {
  apps: TaskApp[];
  totalAppsInstalled: number;
  totalActiveSystems: number;
  primarySystem: string;
  totalOpenTasks: number;
  totalOverdueTasks: number;
  totalCompletedLast7d: number;
  signals: TasksSignal[];
  coverage: string;
}

export interface TasksSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Apple Reminders via AppleScript ──────────────────────────────────────

function scanAppleReminders(): TaskApp | null {
  try {
    // Quick existence/permission probe
    const probe = execSync(`osascript -e 'tell application "Reminders" to count of reminders' 2>/dev/null`, {
      encoding: "utf-8", timeout: 5000,
    }).trim();
    const total = parseInt(probe, 10);
    if (isNaN(total)) {
      return {
        appId: "apple-reminders", displayName: "Apple Reminders",
        installed: true, active: false, tier: "full-content",
        permissionNeeded: "TCC Reminders — grant in System Settings > Privacy & Security > Reminders",
      };
    }
    // Pull open reminder titles + due dates
    const script = `
      tell application "Reminders"
        set output to ""
        set openRems to (reminders whose completed is false)
        set k to count of openRems
        if k > 50 then set k to 50
        repeat with i from 1 to k
          set r to item i of openRems
          set t to name of r
          try
            set d to due date of r
            set output to output & t & "|" & (d as string) & "\\n"
          on error
            set output to output & t & "|\\n"
          end try
        end repeat
        return output
      end tell`;
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8", timeout: 10000,
    });
    const lines = raw.split("\n").filter(Boolean);
    let overdue = 0;
    const recent: string[] = [];
    const now = Date.now();
    for (const line of lines) {
      const [title, due] = line.split("|");
      if (!title) continue;
      recent.push(title.trim());
      if (due && due.trim()) {
        const dueDate = new Date(due.trim());
        if (!isNaN(dueDate.getTime()) && dueDate.getTime() < now) overdue++;
      }
    }

    // Completed last 7d
    let completed7d = 0;
    try {
      const completedScript = `
        tell application "Reminders"
          set sinceDate to (current date) - 7 * days
          return count of (reminders whose completed is true and completion date >= sinceDate)
        end tell`;
      const c = execSync(`osascript -e '${completedScript.replace(/'/g, "'\\''")}'`, { encoding: "utf-8", timeout: 5000 }).trim();
      completed7d = parseInt(c, 10) || 0;
    } catch {}

    return {
      appId: "apple-reminders", displayName: "Apple Reminders",
      installed: true,
      active: total > 0 || completed7d > 0,
      tier: "full-content",
      openCount: lines.length,
      overdueCount: overdue,
      completedLast7d: completed7d,
      recentTasks: recent.slice(0, 10),
    };
  } catch (err: any) {
    if (err.message?.includes("not allowed") || err.message?.includes("-1743")) {
      return {
        appId: "apple-reminders", displayName: "Apple Reminders",
        installed: true, active: false, tier: "full-content",
        permissionNeeded: "TCC Reminders — grant in System Settings > Privacy & Security > Reminders",
      };
    }
    return null;
  }
}

// ── Things (culturedcode) via its SQLite ──────────────────────────────────

function scanThings(): TaskApp | null {
  const groupDir = path.join(HOME, "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac");
  if (!fs.existsSync(groupDir)) return null;

  // Find the ThingsData-*/main.sqlite
  let dbPath = "";
  try {
    for (const entry of fs.readdirSync(groupDir)) {
      if (entry.startsWith("ThingsData-")) {
        const candidate = path.join(groupDir, entry, "Things Database.thingsdatabase/main.sqlite");
        if (fs.existsSync(candidate)) { dbPath = candidate; break; }
      }
    }
  } catch {}
  if (!dbPath) {
    return {
      appId: "things", displayName: "Things",
      installed: fs.existsSync("/Applications/Things.app"),
      active: false, tier: "full-content",
      permissionNeeded: "App data accessible (no extra TCC) but DB not found",
    };
  }

  const tmp = path.join(os.tmpdir(), `anchor_things_${Date.now()}.sqlite`);
  try {
    fs.copyFileSync(dbPath, tmp);
    const db = new Database(tmp, { readonly: true });
    // Things schema: TMTask table. status 0=open, 3=completed. type 0=todo.
    const open = (db.prepare("SELECT COUNT(*) as c FROM TMTask WHERE status = 0 AND trashed = 0 AND type = 0").get() as any)?.c ?? 0;
    const sevenDaysAgoCoreData = (Date.now() - 7 * 86400_000) / 1000 - 978307200;
    const completed7d = (db.prepare("SELECT COUNT(*) as c FROM TMTask WHERE status = 3 AND stopDate >= ?").get(sevenDaysAgoCoreData) as any)?.c ?? 0;
    const overdue = (db.prepare("SELECT COUNT(*) as c FROM TMTask WHERE status = 0 AND trashed = 0 AND dueDate IS NOT NULL AND dueDate < strftime('%s','now') - 978307200").get() as any)?.c ?? 0;
    // Top projects by task count
    const projects = db.prepare(`
      SELECT p.title AS project, COUNT(t.uuid) AS c
      FROM TMTask t
      JOIN TMTask p ON t.project = p.uuid
      WHERE t.status = 0 AND t.trashed = 0 AND p.type = 1
      GROUP BY p.title ORDER BY c DESC LIMIT 10
    `).all() as any[];
    // Recent titles
    const recent = db.prepare(`
      SELECT title FROM TMTask WHERE status = 0 AND trashed = 0 AND type = 0
      ORDER BY creationDate DESC LIMIT 10
    `).all() as any[];
    db.close();
    fs.unlinkSync(tmp);
    return {
      appId: "things", displayName: "Things",
      installed: true, active: open > 0, tier: "full-content",
      openCount: open, overdueCount: overdue, completedLast7d: completed7d,
      topProjects: projects.map(p => p.project).filter(Boolean),
      recentTasks: recent.map(r => r.title).filter(Boolean),
    };
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }
}

// ── Presence-only detection ──────────────────────────────────────────────

function isInstalled(appName: string): boolean {
  for (const d of APPS) {
    try { if (fs.existsSync(path.join(d, `${appName}.app`))) return true; } catch {}
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function scanTasksUnified(): Promise<TasksUnifiedSummary> {
  const apps: TaskApp[] = [];
  const reminders = scanAppleReminders();
  if (reminders) apps.push(reminders);
  const things = scanThings();
  if (things) apps.push(things);

  // Presence-only additions
  const PRESENCE: Record<string, string> = {
    omnifocus: "OmniFocus", ticktick: "TickTick", todoist: "Todoist",
    linear: "Linear", asana: "Asana", clickup: "ClickUp",
    height: "Height", "notion-tasks": "Notion",
  };
  for (const [id, appName] of Object.entries(PRESENCE)) {
    if (apps.find(a => a.appId === id)) continue;
    if (isInstalled(appName)) {
      apps.push({
        appId: id, displayName: appName,
        installed: true, active: false, tier: "presence-only",
      });
    }
  }

  const active = apps.filter(a => a.active);
  const totalOpen = apps.reduce((s, a) => s + (a.openCount ?? 0), 0);
  const totalOverdue = apps.reduce((s, a) => s + (a.overdueCount ?? 0), 0);
  const totalCompleted = apps.reduce((s, a) => s + (a.completedLast7d ?? 0), 0);

  let primarySystem = "";
  if (active.length > 0) {
    const top = [...active].sort((a, b) => (b.openCount ?? 0) - (a.openCount ?? 0))[0];
    primarySystem = top.appId;
  }

  const signals: TasksSignal[] = [];
  if (active.length === 0 && apps.length === 0) {
    signals.push({ name: "no-task-system", strength: "strong",
      evidence: "No task apps detected — tracking via calendar or memory" });
  } else if (active.length === 0 && apps.filter(a => a.installed).length > 0) {
    signals.push({ name: "installed-but-unused-task-apps", strength: "medium",
      evidence: `${apps.filter(a => a.installed).map(a => a.displayName).join(", ")} installed but empty` });
  } else if (active.length >= 2) {
    signals.push({ name: "fragmented-task-system", strength: "medium",
      evidence: `Active in ${active.length}: ${active.map(a => a.displayName).join(" + ")} — no single source of truth` });
  }
  if (totalOverdue >= 10) {
    signals.push({ name: "overdue-task-pileup", strength: "strong",
      evidence: `${totalOverdue} overdue tasks across systems — GTD-failure mode` });
  } else if (totalOverdue >= 3) {
    signals.push({ name: "overdue-task-moderate", strength: "medium",
      evidence: `${totalOverdue} overdue` });
  }
  if (totalOpen > 0 && totalCompleted === 0) {
    signals.push({ name: "task-stasis", strength: "medium",
      evidence: `${totalOpen} open tasks, zero completed in last 7 days — system abandoned` });
  }
  if (totalOpen > 100) {
    signals.push({ name: "task-hoarder", strength: "medium",
      evidence: `${totalOpen} open tasks — cognitive load high, likely many never-to-do` });
  } else if (totalOpen > 0 && totalOpen < 10) {
    signals.push({ name: "task-minimalist", strength: "weak",
      evidence: `${totalOpen} open — lightweight user` });
  }

  // Permission flags
  const needsPerms = apps.filter(a => a.permissionNeeded);
  const coverage = buildCoverage(apps);

  return {
    apps,
    totalAppsInstalled: apps.filter(a => a.installed).length,
    totalActiveSystems: active.length,
    primarySystem,
    totalOpenTasks: totalOpen,
    totalOverdueTasks: totalOverdue,
    totalCompletedLast7d: totalCompleted,
    signals,
    coverage: coverage + (needsPerms.length > 0 ? `. Needs permissions: ${needsPerms.map(a => a.displayName).join(", ")}` : ""),
  };
}

function buildCoverage(apps: TaskApp[]): string {
  const full = apps.filter(a => a.tier === "full-content" && a.active);
  const presence = apps.filter(a => a.tier === "presence-only");
  const parts: string[] = [];
  if (full.length > 0) parts.push(`Readable with counts: ${full.map(a => a.displayName).join(", ")}`);
  if (presence.length > 0) parts.push(`Installed, not integrated: ${presence.map(a => a.displayName).join(", ")}`);
  if (parts.length === 0) parts.push("No task systems active");
  return parts.join(". ");
}

export function tasksUnifiedToText(s: TasksUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("TASKS / TODO SYSTEM:");
  lines.push(`  Active: ${s.totalActiveSystems}. Total open: ${s.totalOpenTasks}. Overdue: ${s.totalOverdueTasks}. Completed last 7d: ${s.totalCompletedLast7d}.`);
  if (s.primarySystem) lines.push(`  Primary: ${s.primarySystem}`);
  for (const a of s.apps) {
    const metric = a.openCount !== undefined
      ? `${a.openCount} open${a.overdueCount ? `, ${a.overdueCount} overdue` : ""}${a.completedLast7d ? `, ${a.completedLast7d} done (7d)` : ""}`
      : a.permissionNeeded ?? "";
    lines.push(`    [${a.tier}] ${a.displayName}: ${metric}`);
    if (a.topProjects && a.topProjects.length > 0) lines.push(`      top projects: ${a.topProjects.slice(0, 5).join(", ")}`);
    if (a.recentTasks && a.recentTasks.length > 0) lines.push(`      recent: ${a.recentTasks.slice(0, 5).join(" | ")}`);
  }
  if (s.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const sig of s.signals) lines.push(`    [${sig.strength}] ${sig.name} — ${sig.evidence}`);
  }
  if (s.coverage) lines.push(`  Coverage: ${s.coverage}`);
  return lines.join("\n");
}
