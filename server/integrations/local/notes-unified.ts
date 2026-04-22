/**
 * Notes / Knowledge Unification — one view of "what you're actually thinking".
 *
 * Scans formal PKM apps (Obsidian, Apple Notes, Bear, Logseq) + detects the
 * increasingly common "scattered markdown" pattern where power users store
 * notes as raw .md files in Desktop/Documents without any app wrapper.
 *
 * Tiers:
 *   full-content       Obsidian (markdown files in vault), scattered .md
 *   metadata-only      Apple Notes (NoteStore.sqlite readable headers),
 *                      Bear (its SQLite)
 *   api-only           Notion, Craft, Roam, Heptabase (presence detected,
 *                      content needs OAuth)
 *   presence-only      app installed, no integration yet
 *
 * Privacy: we read file NAMES and light metadata (mtime, size) — we never
 * emit file CONTENT to downstream consumers. For markdown files we extract
 * tags (#tag) from first 2KB only, for topic inference.
 */
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { findApp } from "./app-registry.js";

const HOME = os.homedir();

export type NotesTier = "full-content" | "metadata-only" | "api-only" | "presence-only";

export interface NoteApp {
  appId: string;
  displayName: string;
  installed: boolean;
  active: boolean;
  tier: NotesTier;
  noteCount?: number;
  recentNoteCount?: number;       // modified in last 30d
  vaultPaths?: string[];
  topKeywords?: string[];
  topTags?: string[];
  folderCount?: number;
  lastEditAt?: string;
}

export interface NotesUnifiedSummary {
  apps: NoteApp[];
  totalAppsInstalled: number;
  totalActiveSystems: number;      // apps or vaults with actual content
  primarySystem: string;           // appId of the most-used system
  totalNoteCount: number;
  totalRecentNoteCount: number;
  recentTopics: string[];          // merged keyword list across systems
  scatteredMarkdown: {
    count: number;                 // .md files found outside vaults
    directories: string[];         // top 5 dirs with most .md
    topFilenames: string[];        // top 10 filenames
  } | null;
  signals: NotesSignal[];
  coverage: string;
}

export interface NotesSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Obsidian ──────────────────────────────────────────────────────────────

function detectObsidianVaults(): string[] {
  const configPath = path.join(HOME, "Library/Application Support/obsidian/obsidian.json");
  if (!fs.existsSync(configPath)) return [];
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const vaults: string[] = [];
    for (const v of Object.values(config.vaults ?? {}) as any[]) {
      if (typeof v?.path === "string" && fs.existsSync(v.path)) vaults.push(v.path);
    }
    return vaults;
  } catch { return []; }
}

function scanMarkdownDir(dirPath: string, opts: { maxFiles?: number; maxDepth?: number } = {}): {
  count: number;
  recent: number;
  keywords: string[];
  tags: string[];
  folderCount: number;
  lastEdit?: string;
} {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxDepth = opts.maxDepth ?? 4;
  const titleWords = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const folders = new Set<string>();
  let count = 0;
  let recent = 0;
  let lastEdit = "";
  const thirtyDaysAgo = Date.now() - 30 * 86400_000;

  function walk(dir: string, depth: number) {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= maxFiles) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") && e.name !== ".obsidian") continue;
        folders.add(e.name);
        walk(full, depth + 1);
      } else if (e.name.endsWith(".md") && !e.name.startsWith(".")) {
        count++;
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        const mtime = stat.mtime.toISOString();
        if (mtime > lastEdit) lastEdit = mtime;
        if (stat.mtime.getTime() > thirtyDaysAgo) recent++;

        // Title words from filename
        const title = e.name.replace(/\.md$/, "");
        for (const w of title.split(/[\s_\-\/]+/)) {
          const clean = w.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, "");
          if (clean.length >= 3 && !STOPWORDS.has(clean)) {
            titleWords.set(clean, (titleWords.get(clean) ?? 0) + 1);
          }
        }

        // Tags from first 2KB of content
        try {
          const fd = fs.openSync(full, "r");
          const buf = Buffer.alloc(2048);
          const n = fs.readSync(fd, buf, 0, 2048, 0);
          fs.closeSync(fd);
          const head = buf.subarray(0, n).toString("utf-8");
          const matches = Array.from(head.matchAll(/#([a-zA-Z][\w\/]+)/g));
          for (const m of matches) {
            const tag = m[1].toLowerCase();
            if (tag.length < 30) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        } catch {}
      }
    }
  }

  walk(dirPath, 0);

  const keywords = Array.from(titleWords.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
  const tags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t]) => t);

  return {
    count,
    recent,
    keywords,
    tags,
    folderCount: folders.size,
    lastEdit: lastEdit || undefined,
  };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "had", "are",
  "was", "were", "not", "but", "all", "can", "new", "out", "old", "get",
  "how", "why", "what", "when", "where", "which", "who", "note", "notes",
  "untitled", "copy", "draft",
]);

// ── Apple Notes (NoteStore.sqlite metadata) ──────────────────────────────

function scanAppleNotes(): { noteCount: number; folderCount: number; lastEdit?: string } | null {
  const dbPath = path.join(HOME, "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const tmp = path.join(os.tmpdir(), `anchor_notes_${Date.now()}.db`);
  try {
    fs.copyFileSync(dbPath, tmp);
    // WAL/SHM aux
    for (const ext of ["-wal", "-shm"]) {
      const src = dbPath + ext;
      if (fs.existsSync(src)) try { fs.copyFileSync(src, tmp + ext); } catch {}
    }
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    // Apple Notes schema: ZICCLOUDSYNCINGOBJECT with ZTITLE1 + ZMODIFICATIONDATE1
    // Z_PK + Z_ENT narrows to note entity
    const noteCount = (db.prepare(
      `SELECT COUNT(*) as c FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1 IS NOT NULL`
    ).get() as any)?.c ?? 0;
    const folderCount = (db.prepare(
      `SELECT COUNT(DISTINCT ZFOLDER) as c FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDER IS NOT NULL`
    ).get() as any)?.c ?? 0;
    const last = db.prepare(
      `SELECT MAX(ZMODIFICATIONDATE1) as last FROM ZICCLOUDSYNCINGOBJECT`
    ).get() as any;
    db.close();
    fs.unlinkSync(tmp);
    // ZMODIFICATIONDATE1 is Apple Core Data seconds since 2001
    let lastEdit: string | undefined;
    if (last?.last) {
      const unix = (last.last + 978307200) * 1000;
      lastEdit = new Date(unix).toISOString();
    }
    return { noteCount, folderCount, lastEdit };
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }
}

// ── Bear ──────────────────────────────────────────────────────────────────

function scanBear(): { noteCount: number; recentCount: number; tags: string[]; lastEdit?: string } | null {
  const dbPath = path.join(HOME, "Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const tmp = path.join(os.tmpdir(), `anchor_bear_${Date.now()}.db`);
  try {
    fs.copyFileSync(dbPath, tmp);
    const db = new Database(tmp, { readonly: true });
    const noteCount = (db.prepare("SELECT COUNT(*) as c FROM ZSFNOTE WHERE ZTRASHED = 0").get() as any)?.c ?? 0;
    const thirty = (Date.now() - 30 * 86400_000) / 1000 - 978307200;
    const recentCount = (db.prepare("SELECT COUNT(*) as c FROM ZSFNOTE WHERE ZTRASHED = 0 AND ZMODIFICATIONDATE > ?").get(thirty) as any)?.c ?? 0;
    const tagRows = db.prepare(
      "SELECT ZTITLE as tag, COUNT(*) as c FROM ZSFNOTETAG GROUP BY ZTITLE ORDER BY c DESC LIMIT 10"
    ).all() as any[];
    const lastRow = db.prepare("SELECT MAX(ZMODIFICATIONDATE) as last FROM ZSFNOTE").get() as any;
    db.close();
    fs.unlinkSync(tmp);
    let lastEdit: string | undefined;
    if (lastRow?.last) lastEdit = new Date((lastRow.last + 978307200) * 1000).toISOString();
    return {
      noteCount,
      recentCount,
      tags: tagRows.map(r => r.tag).filter(Boolean),
      lastEdit,
    };
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return null;
  }
}

// ── Scattered markdown (the "PKM is just .md files on Desktop" pattern) ──

function scanScatteredMarkdown(excludeVaults: string[]): NotesUnifiedSummary["scatteredMarkdown"] {
  const roots = [
    path.join(HOME, "Desktop"),
    path.join(HOME, "Documents"),
  ];
  const filenameCounts = new Map<string, { dir: string; mtime: string }>();
  const dirCounts = new Map<string, number>();
  const excludeList = excludeVaults.map(v => path.resolve(v));

  function inExcludedVault(file: string): boolean {
    for (const v of excludeList) {
      if (file.startsWith(v + path.sep)) return true;
    }
    return false;
  }

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (inExcludedVault(full)) continue;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        walk(full, depth + 1);
      } else if (e.name.endsWith(".md") && !e.name.startsWith(".")) {
        let mtime = "";
        try { mtime = fs.statSync(full).mtime.toISOString(); } catch {}
        filenameCounts.set(e.name, { dir, mtime });
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
    }
  }

  for (const r of roots) walk(r, 0);

  if (filenameCounts.size === 0) return null;

  const topDirs = Array.from(dirCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d, c]) => `${d.replace(HOME, "~")} (${c})`);

  const topFilenames = Array.from(filenameCounts.entries())
    .sort((a, b) => b[1].mtime.localeCompare(a[1].mtime))
    .slice(0, 10)
    .map(([f]) => f);

  return {
    count: filenameCounts.size,
    directories: topDirs,
    topFilenames,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function scanNotesUnified(): Promise<NotesUnifiedSummary> {
  const apps: NoteApp[] = [];
  const topicAgg = new Map<string, number>();

  // Obsidian
  const obsVaults = detectObsidianVaults();
  if (obsVaults.length > 0) {
    let total = 0, recent = 0, folderCount = 0, lastEdit = "";
    const keywords = new Map<string, number>();
    const tags = new Map<string, number>();
    for (const v of obsVaults) {
      const s = scanMarkdownDir(v);
      total += s.count;
      recent += s.recent;
      folderCount += s.folderCount;
      if (s.lastEdit && s.lastEdit > lastEdit) lastEdit = s.lastEdit;
      s.keywords.forEach(k => keywords.set(k, (keywords.get(k) ?? 0) + 1));
      s.tags.forEach(t => tags.set(t, (tags.get(t) ?? 0) + 1));
    }
    const keyWords = Array.from(keywords.keys()).slice(0, 15);
    keyWords.forEach(k => topicAgg.set(k, (topicAgg.get(k) ?? 0) + 1));
    apps.push({
      appId: "obsidian", displayName: "Obsidian",
      installed: true, active: total > 0,
      tier: "full-content",
      noteCount: total, recentNoteCount: recent,
      vaultPaths: obsVaults,
      topKeywords: keyWords,
      topTags: Array.from(tags.keys()).slice(0, 10),
      folderCount,
      lastEditAt: lastEdit || undefined,
    });
  } else if (findApp("Obsidian")) {
    apps.push({
      appId: "obsidian", displayName: "Obsidian",
      installed: true, active: false, tier: "presence-only",
    });
  }

  // Apple Notes
  const apple = scanAppleNotes();
  if (apple && apple.noteCount > 0) {
    apps.push({
      appId: "apple-notes", displayName: "Apple Notes",
      installed: true, active: true, tier: "metadata-only",
      noteCount: apple.noteCount,
      folderCount: apple.folderCount,
      lastEditAt: apple.lastEdit,
    });
  } else if (apple) {
    apps.push({
      appId: "apple-notes", displayName: "Apple Notes",
      installed: true, active: false, tier: "metadata-only",
    });
  }

  // Bear
  const bear = scanBear();
  if (bear) {
    bear.tags.forEach(t => topicAgg.set(t, (topicAgg.get(t) ?? 0) + 1));
    apps.push({
      appId: "bear", displayName: "Bear",
      installed: true, active: bear.noteCount > 0, tier: "metadata-only",
      noteCount: bear.noteCount, recentNoteCount: bear.recentCount,
      topTags: bear.tags,
      lastEditAt: bear.lastEdit,
    });
  }

  // Presence detection — check /Applications directly (registry hit alone
  // only proves Anchor knows the app, not that user has it installed)
  const PRESENCE_MAP: Record<string, string> = {
    notion: "Notion", craft: "Craft", roam: "Roam Research",
    logseq: "Logseq", heptabase: "Heptabase", drafts: "Drafts", mem: "Mem",
  };
  const appDirs = [
    "/Applications",
    path.join(HOME, "Applications"),
  ];
  function isInstalled(appName: string): boolean {
    for (const d of appDirs) {
      try {
        if (fs.existsSync(path.join(d, `${appName}.app`))) return true;
      } catch {}
    }
    return false;
  }
  for (const [id, appName] of Object.entries(PRESENCE_MAP)) {
    if (apps.find(a => a.appId === id)) continue;
    if (isInstalled(appName)) {
      apps.push({
        appId: id, displayName: appName,
        installed: true, active: false, tier: "presence-only",
      });
    }
  }

  // Scattered markdown
  const scattered = scanScatteredMarkdown(obsVaults);

  // Primary system determination
  const activeApps = apps.filter(a => a.active);
  const signals: NotesSignal[] = [];
  const totalNoteCount = activeApps.reduce((s, a) => s + (a.noteCount ?? 0), 0);
  const totalRecentCount = activeApps.reduce((s, a) => s + (a.recentNoteCount ?? 0), 0);
  let primarySystem = "";
  if (activeApps.length > 0) {
    const top = [...activeApps].sort((a, b) => (b.noteCount ?? 0) - (a.noteCount ?? 0))[0];
    primarySystem = top.appId;
  } else if (scattered && scattered.count > 5) {
    primarySystem = "scattered-markdown";
  }

  // Signals
  if (apps.length === 0 && !scattered) {
    signals.push({
      name: "no-formal-knowledge-system",
      strength: "strong",
      evidence: "No note-taking apps installed and no scattered .md files found — knowledge likely lives in LLM context / brain only",
    });
  } else if (activeApps.length === 0 && scattered && scattered.count > 0) {
    // "Active" here means an app actually has notes. If apps are installed but
    // empty and user has scattered .md, the real system IS the scattered files.
    signals.push({
      name: "scattered-markdown-knowledge-system",
      strength: "strong",
      evidence: `${scattered.count} .md files scattered across ${scattered.directories.length} directories — user writes knowledge directly as files without an app wrapper` +
        (apps.filter(a => a.installed).length > 0 ? `. Has ${apps.filter(a => a.installed).map(a => a.displayName).join(", ")} installed but unused.` : ""),
    });
  } else if (activeApps.length >= 2) {
    signals.push({
      name: "multi-system-knowledge-worker",
      strength: "medium",
      evidence: `Uses ${activeApps.map(a => a.displayName).join(" + ")} concurrently`,
    });
  }
  if (primarySystem && primarySystem !== "scattered-markdown") {
    signals.push({
      name: `${primarySystem}-primary`,
      strength: "medium",
      evidence: `Primary knowledge system is ${primarySystem}`,
    });
  }
  if (totalRecentCount >= 10) {
    signals.push({
      name: "active-knowledge-worker",
      strength: "medium",
      evidence: `${totalRecentCount} notes modified in last 30 days`,
    });
  } else if (totalNoteCount > 50 && totalRecentCount < 3) {
    signals.push({
      name: "dormant-knowledge-system",
      strength: "medium",
      evidence: `${totalNoteCount} historical notes but <3 recent edits — system abandoned or archived`,
    });
  }

  // Topic recency — merge scattered filenames for topic inference
  const recentTopics: string[] = [];
  for (const app of activeApps) {
    if (app.topKeywords) recentTopics.push(...app.topKeywords);
    if (app.topTags) recentTopics.push(...app.topTags.map(t => `#${t}`));
  }
  if (scattered) {
    for (const fname of scattered.topFilenames.slice(0, 8)) {
      const title = fname.replace(/\.md$/, "");
      for (const w of title.split(/[\s_\-]+/)) {
        const clean = w.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, "");
        if (clean.length >= 3 && !STOPWORDS.has(clean)) recentTopics.push(clean);
      }
    }
  }

  const coverage = buildCoverage(apps, scattered);

  return {
    apps,
    totalAppsInstalled: apps.filter(a => a.installed).length,
    totalActiveSystems: activeApps.length + (scattered && scattered.count > 3 ? 1 : 0),
    primarySystem,
    totalNoteCount,
    totalRecentNoteCount: totalRecentCount,
    recentTopics: dedupe(recentTopics).slice(0, 20),
    scatteredMarkdown: scattered,
    signals,
    coverage,
  };
}

function dedupe(arr: string[]): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const x of arr) { if (!seen[x]) { seen[x] = true; out.push(x); } }
  return out;
}

function buildCoverage(apps: NoteApp[], scattered: NotesUnifiedSummary["scatteredMarkdown"]): string {
  const parts: string[] = [];
  const fullContent = apps.filter(a => a.tier === "full-content" && a.active);
  const metadataOnly = apps.filter(a => a.tier === "metadata-only" && a.active);
  const presence = apps.filter(a => a.tier === "presence-only");
  if (fullContent.length > 0) parts.push(`Full content readable: ${fullContent.map(a => a.displayName).join(", ")}`);
  if (metadataOnly.length > 0) parts.push(`Metadata only (content encrypted): ${metadataOnly.map(a => a.displayName).join(", ")}`);
  if (presence.length > 0) parts.push(`Installed, not integrated: ${presence.map(a => a.displayName).join(", ")}`);
  if (scattered && scattered.count > 0) parts.push(`${scattered.count} scattered .md files detected`);
  if (parts.length === 0) parts.push("No knowledge systems detected — either truly none, or using only paper / voice / LLM");
  return parts.join(". ");
}

// ── Render ───────────────────────────────────────────────────────────────

export function notesUnifiedToText(summary: NotesUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("NOTES / KNOWLEDGE SYSTEM:");
  lines.push(`  Active systems: ${summary.totalActiveSystems}. Total notes: ${summary.totalNoteCount} (${summary.totalRecentNoteCount} modified in last 30 days).`);
  if (summary.primarySystem) lines.push(`  Primary: ${summary.primarySystem}`);

  for (const app of summary.apps) {
    const line = `    [${app.tier}] ${app.displayName}: ${app.noteCount ?? 0} notes`
      + (app.recentNoteCount ? ` (${app.recentNoteCount} recent)` : "")
      + (app.folderCount ? `, ${app.folderCount} folders` : "")
      + (app.lastEditAt ? `, last edit ${app.lastEditAt.slice(0, 10)}` : "");
    lines.push(line);
    if (app.topTags && app.topTags.length > 0) lines.push(`      top tags: ${app.topTags.slice(0, 6).map(t => `#${t}`).join(" ")}`);
    if (app.topKeywords && app.topKeywords.length > 0) lines.push(`      top keywords: ${app.topKeywords.slice(0, 6).join(", ")}`);
  }

  if (summary.scatteredMarkdown) {
    const sm = summary.scatteredMarkdown;
    lines.push(`  Scattered .md files (no vault/app wrapper): ${sm.count} files`);
    if (sm.directories.length > 0) lines.push(`    top directories: ${sm.directories.join(", ")}`);
    if (sm.topFilenames.length > 0) lines.push(`    recent filenames: ${sm.topFilenames.slice(0, 6).join(", ")}`);
  }

  if (summary.recentTopics.length > 0) {
    lines.push(`  Recent topics (from filenames + tags): ${summary.recentTopics.slice(0, 12).join(", ")}`);
  }

  if (summary.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const s of summary.signals) lines.push(`    [${s.strength}] ${s.name} — ${s.evidence}`);
  }
  if (summary.coverage) lines.push(`  Coverage: ${summary.coverage}`);
  return lines.join("\n");
}
