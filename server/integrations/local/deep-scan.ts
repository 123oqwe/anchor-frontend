/**
 * Deep Mac Scanner — discovers EVERYTHING about the user's machine.
 *
 * Unlike browser-history.ts (only URLs), this scans:
 * 1. Installed applications → infer interests, tools, work style
 * 2. Git repositories → infer projects, tech stack, activity
 * 3. Desktop/Documents files → infer current focus, academic work
 * 4. Running processes → infer current activity
 * 5. Homebrew packages → infer technical depth
 * 6. System info → device, storage, environment
 *
 * All data stays local. Only metadata (app names, file names) — never file contents.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();

export interface MacProfile {
  apps: AppInfo[];
  gitProjects: ProjectInfo[];
  desktopFiles: FileInfo[];
  documentFiles: FileInfo[];
  brewPackages: string[];
  runningApps: string[];
  systemInfo: { hostname: string; user: string; shell: string; cores: number; memGB: number };
}

export interface AppInfo {
  name: string;
  category: string; // coding, design, music, finance, social, productivity, entertainment, other
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

// ── App categorization ──────────────────────────────────────────────────────

const APP_CATEGORIES: Record<string, string> = {
  // Coding
  "Cursor": "coding", "Visual Studio Code": "coding", "Xcode": "coding", "IntelliJ": "coding",
  "Codex": "coding", "TRAE SOLO": "coding", "GitHub Desktop": "coding", "Terminal": "coding",
  "iTerm": "coding", "Warp": "coding", "Docker": "coding",
  // AI
  "Claude": "ai", "ChatGPT": "ai", "ChatGPT Atlas": "ai", "Ollama": "ai", "Manus": "ai",
  // Design
  "Figma": "design", "Sketch": "design", "Canva": "design", "Adobe Photoshop": "design",
  // Music
  "rekordbox 7": "music", "Serato DJ Pro": "music", "Serato DJ Lite": "music",
  "djay Pro": "music", "Splice": "music", "GarageBand": "music", "Logic Pro": "music",
  "Ableton": "music",
  // Social
  "WeChat": "social", "Telegram": "social", "Slack": "social", "Discord": "social",
  "WhatsApp": "social", "Zoom": "social", "Microsoft Teams": "social",
  // Finance
  "Numbers": "finance", "Excel": "finance",
  // Productivity
  "Notion": "productivity", "Obsidian": "productivity", "Grammarly Desktop": "productivity",
  "Granola": "productivity", "Pages": "productivity", "Keynote": "productivity",
  // Browser
  "Google Chrome": "browser", "Safari": "browser", "Firefox": "browser",
  "Arc": "browser", "Tor Browser": "browser",
  // Entertainment
  "GGPoker": "entertainment", "Steam": "entertainment", "NeteaseMusic": "entertainment",
  "Spotify": "entertainment",
  // Media
  "iMovie": "media", "Final Cut Pro": "media", "DaVinci Resolve": "media",
};

function categorizeApp(name: string): string {
  // Clean .app suffix
  const clean = name.replace(/\.app$/, "").trim();
  return APP_CATEGORIES[clean] ?? "other";
}

// ── Scan functions ──────────────────────────────────────────────────────────

function scanApps(): AppInfo[] {
  try {
    const apps = fs.readdirSync("/Applications")
      .filter(f => f.endsWith(".app"))
      .map(f => {
        const name = f.replace(/\.app$/, "");
        return { name, category: categorizeApp(f) };
      })
      .filter(a => a.category !== "other"); // Only keep categorizable apps
    return apps;
  } catch { return []; }
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

export function deepScanMac(): MacProfile {
  console.log("[DeepScan] Starting full Mac profile scan...");

  const profile: MacProfile = {
    apps: scanApps(),
    gitProjects: scanGitProjects(),
    desktopFiles: scanDesktopFiles(),
    documentFiles: scanDocuments(),
    brewPackages: scanBrew(),
    runningApps: scanRunningApps(),
    systemInfo: getSystemInfo(),
  };

  console.log(`[DeepScan] Found: ${profile.apps.length} apps, ${profile.gitProjects.length} git projects, ${profile.desktopFiles.length} desktop files, ${profile.brewPackages.length} brew packages`);

  return profile;
}

// ── Convert Mac profile to rich text for LLM extraction ─────────────────────

export function profileToText(profile: MacProfile): string {
  const sections: string[] = [];

  // Infer INTERESTS and ACTIVITIES from apps — not the apps themselves
  const appsByCategory = new Map<string, string[]>();
  for (const app of profile.apps) {
    if (!appsByCategory.has(app.category)) appsByCategory.set(app.category, []);
    appsByCategory.get(app.category)!.push(app.name);
  }
  if (appsByCategory.size > 0) {
    sections.push("USER INTERESTS AND ACTIVITIES (inferred from installed apps):");
    if (appsByCategory.has("music")) sections.push("  This person is actively involved in DJ/music production");
    if (appsByCategory.has("coding") && (appsByCategory.get("coding")?.length ?? 0) >= 3) sections.push("  This person is a serious developer/programmer");
    if (appsByCategory.has("ai") && (appsByCategory.get("ai")?.length ?? 0) >= 2) sections.push("  This person works heavily with AI tools");
    if (appsByCategory.has("social")) sections.push(`  Social apps: ${appsByCategory.get("social")!.join(", ")} — extract any people if possible`);
    if (appsByCategory.has("finance")) sections.push("  Has finance/spreadsheet tools installed");
    if (appsByCategory.has("entertainment")) sections.push(`  Entertainment: ${appsByCategory.get("entertainment")!.join(", ")}`);
    sections.push("  NOTE: Do NOT create nodes for the apps themselves. Only create nodes for goals, projects, people, and patterns.");
  }

  // Git projects
  if (profile.gitProjects.length > 0) {
    sections.push("\nACTIVE PROJECTS:");
    for (const p of profile.gitProjects) {
      sections.push(`  ${p.name} (${p.languages.join(", ") || "unknown"})${p.lastModified ? ` — last modified ${p.lastModified.slice(0, 10)}` : ""}`);
    }
  }

  // Desktop files
  if (profile.desktopFiles.length > 0) {
    const meaningful = profile.desktopFiles.filter(f => f.ext && f.ext !== "");
    if (meaningful.length > 0) {
      sections.push("\nDESKTOP FILES:");
      for (const f of meaningful) {
        sections.push(`  ${f.name}`);
      }
    }
  }

  // Documents
  if (profile.documentFiles.length > 0) {
    sections.push("\nDOCUMENTS:");
    for (const f of profile.documentFiles) {
      sections.push(`  ${f.name}`);
    }
  }

  // Tech stack from brew
  if (profile.brewPackages.length > 0) {
    const notable = profile.brewPackages.filter(p =>
      ["python", "node", "go", "rust", "postgresql", "redis", "docker", "git", "ffmpeg", "ollama", "flyctl"].some(k => p.includes(k))
    );
    if (notable.length > 0) {
      sections.push(`\nTECH STACK: ${notable.join(", ")}`);
    }
  }

  // Running now
  if (profile.runningApps.length > 0) {
    sections.push(`\nCURRENTLY RUNNING: ${profile.runningApps.join(", ")}`);
  }

  // System
  sections.push(`\nSYSTEM: ${profile.systemInfo.hostname}, ${profile.systemInfo.cores} cores, ${profile.systemInfo.memGB}GB RAM`);

  return sections.join("\n");
}
