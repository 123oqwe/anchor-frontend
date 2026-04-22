/**
 * Deep Mac Scanner — discovers EVERYTHING about the user's machine.
 *
 * Step 2 of the scanning redesign: the hardcoded APP_CATEGORIES dict is gone.
 * Every installed app is now looked up against server/integrations/local/
 * app-registry.ts which carries 180+ curated entries with category, regions,
 * signals, and scan strategy. Output is no longer a flat "apps: string[]"
 * but a rich profile with region affinity, aggregated signals, and a
 * scan-capability assessment. Unknown apps get queued into unknown_apps
 * table for future batch LLM classification.
 *
 * What this scanner touches (all metadata, never contents):
 * 1. /Applications          → registry match → category+region+signal
 * 2. Git repos              → project + language inference
 * 3. Desktop / Documents    → filenames only
 * 4. Running processes      → current focus
 * 5. Homebrew packages      → technical depth
 * 6. System info            → device + env
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { db, DEFAULT_USER_ID } from "../../infra/storage/db.js";
import {
  classifyInstalledApps,
  aggregateSignals,
  inferRegionAffinity,
  scanCapabilityReport,
  type AppProfile,
  type AppRegion,
} from "./app-registry.js";
import {
  readLocalizationFingerprint,
  localizationToText,
  type LocalizationFingerprint,
} from "./localization-fingerprint.js";
import {
  matchPairSignatures,
  signaturesToText,
  type MatchedSignature,
} from "./app-pair-signatures.js";
import {
  calendarSummaryToText,
  type CalendarSummary,
} from "./calendar-unified.js";
import {
  scanIMessage,
  chatSummaryToText,
  type ChatSummary,
} from "./imessage-scanner.js";
import {
  scanMessagesUnified,
  messagesUnifiedToText,
  type MessagesUnifiedSummary,
} from "./messages-unified.js";
import {
  scanNotesUnified,
  notesUnifiedToText,
  type NotesUnifiedSummary,
} from "./notes-unified.js";
import {
  scanTasksUnified,
  tasksUnifiedToText,
  type TasksUnifiedSummary,
} from "./tasks-unified.js";
import {
  scanEmailUnified,
  emailUnifiedToText,
  type EmailUnifiedSummary,
} from "./email-unified.js";
import {
  scanCodeUnified,
  codeUnifiedToText,
  type CodeUnifiedSummary,
} from "./code-unified.js";

const HOME = os.homedir();

export interface MacProfile {
  apps: AppInfo[];
  gitProjects: ProjectInfo[];
  desktopFiles: FileInfo[];
  documentFiles: FileInfo[];
  brewPackages: string[];
  runningApps: string[];
  systemInfo: { hostname: string; user: string; shell: string; cores: number; memGB: number };

  // Registry-derived insights (Step 2)
  regionAffinity: { region: AppRegion; score: number; apps: string[] }[];
  topSignals: { signal: string; score: number; sources: string[] }[];
  scanCapabilities: {
    readableContent: { name: string; method: string }[];
    accessibilityOnly: string[];
    presenceOnly: string[];
    permissionsNeeded: { app: string; permission: string }[];
  };
  unknownApps: string[];

  // Step 3 — 0-permission OS-level signals
  localization: LocalizationFingerprint;

  // Step 4 — higher-order app pair/combination signatures
  pairSignatures: MatchedSignature[];

  // Step 5 — unified calendar summary (optional; populated only if scan ran)
  calendarSummary?: CalendarSummary;

  // Step 6 — iMessage relationship strength (optional; needs FDDA)
  chatSummary?: ChatSummary;

  // Messages Unification — iMessage + Telegram/Slack/WeChat activity fusion
  messagesUnified?: MessagesUnifiedSummary;

  // Notes Unification — Obsidian + Apple Notes + Bear + scattered markdown
  notesUnified?: NotesUnifiedSummary;

  // Tasks Unification — Reminders + Things + presence for Linear/Todoist/etc
  tasksUnified?: TasksUnifiedSummary;

  // Email Unification — Apple Mail + Gmail OAuth + presence
  emailUnified?: EmailUnifiedSummary;

  // Code Activity Unification — local git velocity + commit themes
  codeUnified?: CodeUnifiedSummary;
}

export interface AppInfo {
  name: string;
  category: string;
  known: boolean;
  regions?: AppRegion[];
  signals?: string[];        // flattened to name list (strength preserved in signal name via suffix)
  scanMethod?: string;       // sqlite-direct / applescript / accessibility-only / presence-only / fs-config / api-oauth
  launchedYear?: number;
}

export interface ProjectInfo {
  name: string;
  path: string;
  lastModified: string;
  hasPackageJson: boolean;
  languages: string[];
}

export interface FileInfo {
  name: string;
  ext: string;
  modified: string;
}

// ── App scan: registry-driven ───────────────────────────────────────────────

/** Log an unknown app for later LLM classification (upsert with seen_count++). */
function recordUnknownApp(name: string): void {
  try {
    db.prepare(
      `INSERT INTO unknown_apps (name, first_seen_at, last_seen_at, seen_count)
       VALUES (?, datetime('now'), datetime('now'), 1)
       ON CONFLICT(name) DO UPDATE SET
         last_seen_at = datetime('now'),
         seen_count   = unknown_apps.seen_count + 1`
    ).run(name);
  } catch {}
}

function toAppInfo(app: AppProfile, source: string): AppInfo {
  return {
    name: source.replace(/\.app$/i, ""),
    category: app.category,
    known: true,
    regions: app.regions,
    signals: app.signals.map(s => `${s.name}:${s.strength}`),
    scanMethod: app.scanStrategy.method,
    launchedYear: app.launchedYear,
  };
}

function scanApps(): { matched: AppInfo[]; unknown: string[] } {
  try {
    const filenames = fs.readdirSync("/Applications").filter(f => f.endsWith(".app"));
    const { matched, unknown } = classifyInstalledApps(filenames);

    // Log unknowns for later batch LLM classification
    for (const u of unknown) recordUnknownApp(u);

    const apps: AppInfo[] = matched.map(m => toAppInfo(m.app, m.source));
    // Unknowns still surface in the list with known=false so downstream can see them
    for (const u of unknown) {
      apps.push({ name: u, category: "other", known: false });
    }

    return { matched: apps, unknown };
  } catch {
    return { matched: [], unknown: [] };
  }
}

function scanGitProjects(): ProjectInfo[] {
  try {
    const raw = execSync(
      `find ${HOME} -maxdepth 3 -name ".git" -type d 2>/dev/null`,
      { timeout: 10000, encoding: "utf-8" }
    );
    return raw.split("\n").filter(Boolean).map(gitDir => {
      const projectDir = path.dirname(gitDir);
      const name = path.basename(projectDir);
      let lastModified = "";
      try { lastModified = fs.statSync(projectDir).mtime.toISOString(); } catch {}
      const hasPackageJson = fs.existsSync(path.join(projectDir, "package.json"));
      const languages: string[] = [];
      try {
        const files = fs.readdirSync(projectDir);
        if (files.some(f => f.endsWith(".ts") || f.endsWith(".tsx"))) languages.push("TypeScript");
        if (files.some(f => f.endsWith(".py"))) languages.push("Python");
        if (files.some(f => f.endsWith(".rs"))) languages.push("Rust");
        if (files.some(f => f.endsWith(".go"))) languages.push("Go");
        if (files.some(f => f.endsWith(".swift"))) languages.push("Swift");
        if (hasPackageJson) languages.push("Node.js");
      } catch {}
      return { name, path: projectDir, lastModified, hasPackageJson, languages };
    }).filter(p => !p.path.includes("node_modules") && !p.path.includes(".openclaw/workspace"));
  } catch { return []; }
}

function scanDesktopFiles(): FileInfo[] {
  try {
    return fs.readdirSync(path.join(HOME, "Desktop"))
      .slice(0, 20)
      .map(f => {
        const ext = path.extname(f).toLowerCase();
        let modified = "";
        try { modified = fs.statSync(path.join(HOME, "Desktop", f)).mtime.toISOString(); } catch {}
        return { name: f, ext, modified };
      });
  } catch { return []; }
}

function scanDocuments(): FileInfo[] {
  try {
    return fs.readdirSync(path.join(HOME, "Documents"))
      .slice(0, 20)
      .map(f => {
        const ext = path.extname(f).toLowerCase();
        let modified = "";
        try { modified = fs.statSync(path.join(HOME, "Documents", f)).mtime.toISOString(); } catch {}
        return { name: f, ext, modified };
      });
  } catch { return []; }
}

function scanBrew(): string[] {
  try {
    return execSync("brew list --formula 2>/dev/null", { timeout: 5000, encoding: "utf-8" })
      .split("\n").filter(Boolean);
  } catch { return []; }
}

function scanRunningApps(): string[] {
  try {
    const raw = execSync(
      `ps aux | awk '{print $11}' | grep -i "/Applications/" | sed 's|.*/||' | sort -u`,
      { timeout: 5000, encoding: "utf-8" }
    );
    return raw.split("\n").filter(Boolean).map(a => a.replace(/\.app.*/, ""));
  } catch { return []; }
}

function getSystemInfo() {
  return {
    hostname: os.hostname(),
    user: os.userInfo().username,
    shell: process.env.SHELL ?? "unknown",
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1073741824),
  };
}

// ── Master: collect everything ──────────────────────────────────────────────

export async function deepScanMacAsync(): Promise<MacProfile> {
  const profile = deepScanMac();
  const [messages, notes, tasks, email, code] = await Promise.all([
    scanMessagesUnified(),
    scanNotesUnified(),
    scanTasksUnified(),
    scanEmailUnified(),
    scanCodeUnified(),
  ]);
  profile.messagesUnified = messages;
  profile.notesUnified = notes;
  profile.tasksUnified = tasks;
  profile.emailUnified = email;
  profile.codeUnified = code;
  return profile;
}

export function deepScanMac(): MacProfile {
  console.log("[DeepScan] Starting full Mac profile scan...");

  const { matched: appInfos, unknown } = scanApps();

  // Re-derive AppProfile objects from AppInfo so we can feed registry helpers
  // that expect the full profile shape. (classifyInstalledApps was already run
  // inside scanApps; we reconstruct the shape here for aggregate helpers.)
  const filenames = (() => {
    try { return fs.readdirSync("/Applications").filter(f => f.endsWith(".app")); }
    catch { return []; }
  })();
  const { matched: registryMatched } = classifyInstalledApps(filenames);

  const regionAffinity = inferRegionAffinity(registryMatched);
  const topSignals = aggregateSignals(registryMatched).slice(0, 20);
  const capReport = scanCapabilityReport(registryMatched);

  const scanCapabilities = {
    readableContent: capReport.readableContent.map(a => ({ name: a.name, method: a.scanStrategy.method })),
    accessibilityOnly: capReport.accessibilityOnly.map(a => a.name),
    presenceOnly: capReport.presenceOnly.map(a => a.name),
    permissionsNeeded: capReport.needsPermission.map(p => ({ app: p.app.name, permission: p.permission })),
  };

  const localization = readLocalizationFingerprint();
  const pairSignatures = matchPairSignatures(registryMatched, localization);
  const chatSummary = scanIMessage(90);

  const profile: MacProfile = {
    apps: appInfos,
    gitProjects: scanGitProjects(),
    desktopFiles: scanDesktopFiles(),
    documentFiles: scanDocuments(),
    brewPackages: scanBrew(),
    runningApps: scanRunningApps(),
    systemInfo: getSystemInfo(),
    regionAffinity,
    topSignals,
    scanCapabilities,
    unknownApps: unknown,
    localization,
    pairSignatures,
    chatSummary,
  };

  const knownCount = appInfos.filter(a => a.known).length;
  console.log(`[DeepScan] Apps: ${knownCount}/${appInfos.length} known. Git: ${profile.gitProjects.length}. Desktop: ${profile.desktopFiles.length}. Brew: ${profile.brewPackages.length}. Unknown queued: ${unknown.length}.`);
  if (regionAffinity.length > 0) {
    const top = regionAffinity.slice(0, 2).map(r => `${r.region}(${r.score})`).join(" / ");
    console.log(`[DeepScan] Region affinity: ${top}`);
  }

  return profile;
}

// ── Convert Mac profile to rich text for LLM extraction ─────────────────────

export function profileToText(profile: MacProfile): string {
  const sections: string[] = [];

  // ── Step 3: Localization fingerprint first — 0-permission OS-level signals
  // provide the strongest single-shot cultural anchor, so LLM sees it up front.
  if (profile.localization) {
    sections.push(localizationToText(profile.localization));
    sections.push("");
  }

  // ── Step 4: Higher-order pair signatures — this is the LLM's single best
  // input because each signature is already a curated reframe of a combo.
  if (profile.pairSignatures && profile.pairSignatures.length > 0) {
    sections.push(signaturesToText(profile.pairSignatures));
    sections.push("");
  }

  // ── Step 5: Calendar summary — rhythm + schedule signals
  if (profile.calendarSummary) {
    sections.push(calendarSummaryToText(profile.calendarSummary));
    sections.push("");
  }

  // ── Step 6: iMessage relationship strength — who actually matters
  if (profile.chatSummary) {
    sections.push(chatSummaryToText(profile.chatSummary));
    sections.push("");
  }

  // ── Messages Unification — cross-app chat view
  if (profile.messagesUnified) {
    sections.push(messagesUnifiedToText(profile.messagesUnified));
    sections.push("");
  }

  // ── Notes Unification — formal PKM apps + scattered markdown pattern
  if (profile.notesUnified) {
    sections.push(notesUnifiedToText(profile.notesUnified));
    sections.push("");
  }

  // ── Tasks Unification — Reminders + Things + presence
  if (profile.tasksUnified) {
    sections.push(tasksUnifiedToText(profile.tasksUnified));
    sections.push("");
  }

  // ── Email Unification — Apple Mail + subscriptions + recipient graph
  if (profile.emailUnified) {
    sections.push(emailUnifiedToText(profile.emailUnified));
    sections.push("");
  }

  // ── Code Activity Unification — git velocity + themes + rhythm
  if (profile.codeUnified) {
    sections.push(codeUnifiedToText(profile.codeUnified));
    sections.push("");
  }

  // ── Region affinity — new in Step 2, first because it's the most important framing ──
  if (profile.regionAffinity.length > 0) {
    sections.push("CULTURAL/REGIONAL AFFINITY (inferred from app portfolio):");
    const top = profile.regionAffinity.slice(0, 3);
    for (const r of top) {
      sections.push(`  ${r.region}: score ${r.score} (apps: ${r.apps.slice(0, 5).join(", ")}${r.apps.length > 5 ? ", ..." : ""})`);
    }
    if (top.length >= 2 && Math.abs(top[0].score - top[1].score) / top[0].score < 0.2) {
      sections.push(`  → This user is BI-CULTURAL (${top[0].region} and ${top[1].region} scores are within 20%)`);
    } else if (top.length >= 1) {
      sections.push(`  → Primary cultural context: ${top[0].region}`);
    }
  }

  // ── Top aggregated behavioral signals — weighted by app strength sum ──
  if (profile.topSignals.length > 0) {
    sections.push("\nBEHAVIORAL SIGNALS (aggregated across all matched apps, highest-first):");
    for (const s of profile.topSignals.slice(0, 12)) {
      sections.push(`  [${String(s.score).padStart(3)}] ${s.signal} — evidence: ${s.sources.slice(0, 4).join(", ")}${s.sources.length > 4 ? "..." : ""}`);
    }
  }

  // ── Apps grouped by category for LLM context (not for node creation) ──
  const knownApps = profile.apps.filter(a => a.known);
  if (knownApps.length > 0) {
    const byCategoryPrefix = new Map<string, { name: string; regions: string }[]>();
    for (const a of knownApps) {
      const prefix = (a.category ?? "other").split("-")[0];
      if (!byCategoryPrefix.has(prefix)) byCategoryPrefix.set(prefix, []);
      byCategoryPrefix.get(prefix)!.push({
        name: a.name,
        regions: (a.regions ?? []).filter(r => r !== "GLOBAL").join(",") || "",
      });
    }
    sections.push("\nINSTALLED APPS BY CATEGORY (context only — do NOT create app nodes):");
    const ordered = Array.from(byCategoryPrefix.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [prefix, apps] of ordered) {
      const rendered = apps.map(a => a.regions ? `${a.name}(${a.regions})` : a.name).join(", ");
      sections.push(`  ${prefix.toUpperCase()}: ${rendered}`);
    }
  }

  // ── Scan capability — tells the extractor what data depth is realistic ──
  const cap = profile.scanCapabilities;
  if (cap.readableContent.length > 0 || cap.permissionsNeeded.length > 0) {
    sections.push("\nDATA ACCESS AVAILABLE:");
    if (cap.readableContent.length > 0) {
      sections.push(`  Full content readable: ${cap.readableContent.map(a => `${a.name} (${a.method})`).join(", ")}`);
    }
    if (cap.permissionsNeeded.length > 0) {
      sections.push(`  Permissions needed for deeper access: ${cap.permissionsNeeded.map(p => `${p.app}→${p.permission}`).join(", ")}`);
    }
  }

  // Git projects
  if (profile.gitProjects.length > 0) {
    sections.push("\nACTIVE PROJECTS (git repos):");
    for (const p of profile.gitProjects) {
      sections.push(`  ${p.name} (${p.languages.join(", ") || "unknown"})${p.lastModified ? ` — last modified ${p.lastModified.slice(0, 10)}` : ""}`);
    }
  }

  // Desktop files
  if (profile.desktopFiles.length > 0) {
    const meaningful = profile.desktopFiles.filter(f => f.ext && f.ext !== "");
    if (meaningful.length > 0) {
      sections.push("\nDESKTOP FILES:");
      for (const f of meaningful) sections.push(`  ${f.name}`);
    }
  }

  // Documents
  if (profile.documentFiles.length > 0) {
    sections.push("\nDOCUMENTS:");
    for (const f of profile.documentFiles) sections.push(`  ${f.name}`);
  }

  // Tech stack from brew
  if (profile.brewPackages.length > 0) {
    const notable = profile.brewPackages.filter(p =>
      ["python", "node", "go", "rust", "postgresql", "redis", "docker", "git", "ffmpeg", "ollama", "flyctl"].some(k => p.includes(k))
    );
    if (notable.length > 0) sections.push(`\nTECH STACK: ${notable.join(", ")}`);
  }

  // Running now
  if (profile.runningApps.length > 0) {
    sections.push(`\nCURRENTLY RUNNING: ${profile.runningApps.join(", ")}`);
  }

  // System
  sections.push(`\nSYSTEM: ${profile.systemInfo.hostname}, ${profile.systemInfo.cores} cores, ${profile.systemInfo.memGB}GB RAM`);

  // Extractor guidance — unchanged message from Step 1 but kept at end
  sections.push(
    "\nNOTE for extractor: Do NOT create nodes for apps themselves. Use the CULTURAL AFFINITY, " +
    "BEHAVIORAL SIGNALS, and ACTIVE PROJECTS sections to infer user's identity facets, " +
    "goals, tensions, and patterns. The app list is context, not the subject."
  );

  return sections.join("\n");
}
