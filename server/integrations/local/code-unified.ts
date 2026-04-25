/**
 * Code Activity Unification — "what you're actually building".
 *
 * Deep Scan already finds local .git dirs. This scanner ADDS time-series
 * understanding: commit frequency, active vs dormant repos, peak hour/day,
 * commit message themes, language distribution across actively-used repos.
 *
 * For developer users (Anchor's primary commercial segment), THIS is the
 * shape of their real work life. "127 commits across 8 repos in last 30
 * days with 68% concentrated in anchor-ui" is orders of magnitude more
 * useful than "has 23 git repos".
 *
 * Sources:
 *   full-content  local git via git log (read-only, no external calls)
 *   api           GitHub (oauth_tokens) — presence detection only here;
 *                 future step can call /user/events for richer data
 *
 * Privacy: we read commit messages for topic inference but limit each to
 * 80 chars and never persist raw messages — only aggregated top-word
 * frequencies.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { getTokens } from "../token-store.js";
import { DEFAULT_USER_ID } from "../../infra/storage/db.js";
import { shadowEmit } from "../../infra/storage/scanner-events.js";

const HOME = os.homedir();

export type CodeTier = "full-content" | "api" | "presence-only";

export interface RepoActivity {
  name: string;
  path: string;
  languages: string[];
  totalCommitsLast30d: number;
  totalCommitsAllTime?: number;
  lastCommitAt?: string;
  firstCommitAt?: string;
  peakHour?: number;
  commitsByDay?: number[];         // 7 slots for day-of-week distribution
  topMessageWords?: string[];
  state: "active" | "dormant" | "abandoned";    // active ≥1 in 30d, dormant <30d no commits, abandoned <90d
}

export interface CodeUnifiedSummary {
  sources: { localRepos: number; githubOAuth: boolean };
  totalCommitsLast30d: number;
  activeRepos: number;
  dormantRepos: number;
  abandonedRepos: number;
  repos: RepoActivity[];               // top 20 by recent activity
  primaryRepo?: string;
  peakHourGlobal?: number;
  peakDayGlobal?: string;
  topMessageThemes: string[];          // aggregated across repos
  topLanguages: Array<{ language: string; repoCount: number }>;
  signals: CodeSignal[];
  coverage: string;
}

export interface CodeSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeExec(cmd: string, opts: { cwd?: string; timeout?: number } = {}): string {
  try {
    return execSync(cmd, { cwd: opts.cwd, timeout: opts.timeout ?? 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 }).trim();
  } catch { return ""; }
}

function findGitRepos(maxDepth = 3): string[] {
  // find exits non-zero when it hits permission-denied dirs; `|| true` forces
  // success so we get the partial results that DID succeed.
  const output = safeExec(
    `find "${HOME}" -maxdepth ${maxDepth} -name ".git" -type d 2>/dev/null || true`,
    { timeout: 15_000 }
  );
  return output.split("\n").filter(Boolean)
    .map(g => path.dirname(g))
    .filter(p => !p.includes("node_modules") && !p.includes(".openclaw/workspace"));
}

function detectLanguages(repoPath: string): string[] {
  const out: string[] = [];
  try {
    const files = fs.readdirSync(repoPath).slice(0, 200);  // shallow
    if (files.some(f => f.endsWith(".ts") || f.endsWith(".tsx"))) out.push("TypeScript");
    if (files.some(f => f.endsWith(".js") || f.endsWith(".jsx"))) out.push("JavaScript");
    if (files.some(f => f.endsWith(".py"))) out.push("Python");
    if (files.some(f => f.endsWith(".rs") || f.includes("Cargo.toml"))) out.push("Rust");
    if (files.some(f => f.endsWith(".go") || f === "go.mod")) out.push("Go");
    if (files.some(f => f.endsWith(".swift"))) out.push("Swift");
    if (files.some(f => f.endsWith(".kt"))) out.push("Kotlin");
    if (files.some(f => f.endsWith(".rb") || f === "Gemfile")) out.push("Ruby");
    if (files.some(f => f.endsWith(".java"))) out.push("Java");
    if (files.some(f => f === "package.json")) out.push("Node.js");
  } catch {}
  return out;
}

const STOP = new Set([
  "fix", "add", "update", "remove", "delete", "change", "improve", "the", "and",
  "for", "with", "from", "this", "that", "bug", "test", "tests", "typo", "chore",
  "feat", "feature", "refactor", "docs", "style", "ci", "wip", "minor", "better",
]);

function topWordsFromMessages(messages: string[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    const words = msg.toLowerCase().split(/[^\w\u4e00-\u9fff]+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

// ── Per-repo git log extraction ──────────────────────────────────────────

interface GitLogEntry { iso: string; message: string }

let _userEmail: string | null = null;
function getUserEmail(repoPath: string): string {
  // Prefer global user.email, fall back to this-repo user.email. Cached.
  if (_userEmail !== null) return _userEmail;
  const local = safeExec(`git config --global user.email 2>/dev/null || true`, { cwd: repoPath, timeout: 2000 });
  _userEmail = local || "";
  return _userEmail;
}

function readGitLog(repoPath: string, since = "30 days ago"): GitLogEntry[] {
  // Filter to commits BY the user — avoids counting commits in cloned research
  // repos (e.g. hermes-agent with 2000+ upstream commits that aren't the
  // user's work).
  const email = getUserEmail(repoPath);
  const authorFlag = email ? `--author="${email.replace(/"/g, '\\"')}"` : "";
  const out = safeExec(
    `git log ${authorFlag} --pretty=format:"%ci|%s" --since="${since}" --all 2>/dev/null || true`,
    { cwd: repoPath, timeout: 5000 }
  );
  if (!out) return [];
  return out.split("\n").filter(Boolean).map(line => {
    const sep = line.indexOf("|");
    if (sep < 0) return { iso: "", message: line };
    return { iso: line.slice(0, sep), message: line.slice(sep + 1).slice(0, 80) };
  });
}

function readAllTimeCommitCount(repoPath: string): number {
  const out = safeExec(`git rev-list --all --count 2>/dev/null`, { cwd: repoPath, timeout: 5000 });
  return parseInt(out, 10) || 0;
}

function readFirstCommit(repoPath: string): string | undefined {
  const out = safeExec(`git log --reverse --pretty=format:"%ci" --all | head -1`, { cwd: repoPath, timeout: 5000 });
  return out || undefined;
}

function analyzeRepo(repoPath: string): RepoActivity {
  const name = path.basename(repoPath);
  const languages = detectLanguages(repoPath);
  const log30 = readGitLog(repoPath, "30 days ago");
  const log90 = log30.length === 0 ? readGitLog(repoPath, "90 days ago") : [];
  const allTime = readAllTimeCommitCount(repoPath);
  const firstCommit = readFirstCommit(repoPath);

  const hourBins = new Array(24).fill(0);
  const dayBins = new Array(7).fill(0);
  let lastAt = "";
  for (const entry of log30) {
    if (!entry.iso) continue;
    const d = new Date(entry.iso);
    if (isNaN(d.getTime())) continue;
    hourBins[d.getHours()]++;
    dayBins[d.getDay()]++;
    if (entry.iso > lastAt) lastAt = entry.iso;
  }
  const peakHour = log30.length > 0 ? hourBins.indexOf(Math.max(...hourBins)) : undefined;
  const topMessages = topWordsFromMessages(log30.map(e => e.message));

  let state: RepoActivity["state"];
  if (log30.length > 0) state = "active";
  else if (log90.length > 0) state = "dormant";
  else state = "abandoned";

  return {
    name, path: repoPath, languages,
    totalCommitsLast30d: log30.length,
    totalCommitsAllTime: allTime,
    lastCommitAt: lastAt || (log90[0]?.iso),
    firstCommitAt: firstCommit,
    peakHour, commitsByDay: dayBins,
    topMessageWords: topMessages,
    state,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

export async function scanCodeUnified(): Promise<CodeUnifiedSummary> {
  const repoPaths = findGitRepos(3);
  const repos: RepoActivity[] = [];
  // Cap to avoid runaway — analyze top 30 most-recently-modified
  const withMtime = repoPaths.map(p => {
    let mtime = 0;
    try { mtime = fs.statSync(p).mtime.getTime(); } catch {}
    return { path: p, mtime };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, 30);

  for (const { path: p } of withMtime) {
    repos.push(analyzeRepo(p));
  }

  // Sort by recency + activity
  repos.sort((a, b) => (b.totalCommitsLast30d - a.totalCommitsLast30d) ||
    ((b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "")));

  const active = repos.filter(r => r.state === "active");
  const dormant = repos.filter(r => r.state === "dormant");
  const abandoned = repos.filter(r => r.state === "abandoned");
  const totalCommits30 = active.reduce((s, r) => s + r.totalCommitsLast30d, 0);

  // Global hour/day stats across active repos
  const hourBins = new Array(24).fill(0);
  const dayBins = new Array(7).fill(0);
  for (const r of active) {
    if (r.peakHour !== undefined && r.totalCommitsLast30d > 0) {
      // Re-analyze to aggregate hourly: cheap path is to trust repo-level dayBins
      r.commitsByDay?.forEach((c, i) => (dayBins[i] += c));
    }
  }
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const peakDayIdx = dayBins.indexOf(Math.max(...dayBins));

  // Top themes across ALL active repos (merge top words)
  const themeCounts = new Map<string, number>();
  for (const r of active) {
    for (const w of r.topMessageWords ?? []) themeCounts.set(w, (themeCounts.get(w) ?? 0) + 1);
  }
  const topThemes = Array.from(themeCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);

  // Language aggregate (from active repos)
  const langCounts = new Map<string, number>();
  for (const r of active) for (const l of r.languages) langCounts.set(l, (langCounts.get(l) ?? 0) + 1);
  const topLangs = Array.from(langCounts.entries()).sort((a, b) => b[1] - a[1])
    .map(([language, repoCount]) => ({ language, repoCount }));

  const primaryRepo = active[0]?.name;

  const signals: CodeSignal[] = [];
  if (totalCommits30 === 0 && repos.length > 0) {
    signals.push({ name: "developer-pause", strength: "strong",
      evidence: `${repos.length} git repos found but zero commits in last 30 days` });
  } else if (totalCommits30 >= 100) {
    signals.push({ name: "high-velocity-developer", strength: "strong",
      evidence: `${totalCommits30} commits in 30d across ${active.length} repos` });
  } else if (totalCommits30 >= 30) {
    signals.push({ name: "active-developer", strength: "medium",
      evidence: `${totalCommits30} commits in 30d across ${active.length} repos` });
  }
  if (active.length > 0) {
    const primaryShare = active[0].totalCommitsLast30d / Math.max(1, totalCommits30);
    if (primaryShare >= 0.7) {
      signals.push({ name: "single-project-focus", strength: "strong",
        evidence: `${active[0].name} = ${Math.round(primaryShare * 100)}% of all commits` });
    } else if (active.length >= 5 && primaryShare < 0.35) {
      signals.push({ name: "fragmented-project-portfolio", strength: "medium",
        evidence: `${active.length} active repos, top = only ${Math.round(primaryShare * 100)}%` });
    }
  }
  if (abandoned.length >= 10) {
    signals.push({ name: "repo-graveyard", strength: "medium",
      evidence: `${abandoned.length} abandoned repos (>90d no commits) — likely experiment accumulation` });
  }
  // Late-night coder signal
  let allHourBins = new Array(24).fill(0);
  for (const r of active) {
    if (r.peakHour !== undefined) allHourBins[r.peakHour] += r.totalCommitsLast30d;
  }
  const globalPeakHour = allHourBins.indexOf(Math.max(...allHourBins));
  if (globalPeakHour >= 22 || globalPeakHour < 4) {
    signals.push({ name: "late-night-coder", strength: "medium",
      evidence: `Peak commit hour: ${globalPeakHour}:00` });
  }
  // Weekend vs weekday coder
  const weekend = dayBins[0] + dayBins[6];
  const weekday = dayBins[1] + dayBins[2] + dayBins[3] + dayBins[4] + dayBins[5];
  const weekendShare = (weekend + weekday) > 0 ? weekend / (weekend + weekday) : 0;
  if (weekendShare >= 0.35) {
    signals.push({ name: "weekend-heavy-coder", strength: "medium",
      evidence: `${Math.round(weekendShare * 100)}% of commits land Sat/Sun` });
  }

  // GitHub presence
  const ghToken = getTokens(DEFAULT_USER_ID, "github");

  const coverage = [
    `Local: ${repos.length} repos (${active.length} active, ${dormant.length} dormant, ${abandoned.length} abandoned)`,
    ghToken ? "GitHub OAuth: granted (API data not yet integrated)" : "GitHub OAuth: not granted — public PR / review data missing",
  ].join(". ");

  const result: CodeUnifiedSummary = {
    sources: { localRepos: repos.length, githubOAuth: !!ghToken },
    totalCommitsLast30d: totalCommits30,
    activeRepos: active.length,
    dormantRepos: dormant.length,
    abandonedRepos: abandoned.length,
    repos: repos.slice(0, 20),
    primaryRepo,
    peakHourGlobal: globalPeakHour,
    peakDayGlobal: dayBins.some(n => n > 0) ? DAYS[peakDayIdx] : undefined,
    topMessageThemes: topThemes,
    topLanguages: topLangs,
    signals,
    coverage,
  };

  shadowEmit({
    scanner: "code-unified",
    source: "code",
    kind: "code_scan_summary",
    stableFields: { scanDay: new Date().toISOString().slice(0, 10) },
    payload: {
      totalCommitsLast30d: result.totalCommitsLast30d,
      activeRepos: result.activeRepos,
      dormantRepos: result.dormantRepos,
      abandonedRepos: result.abandonedRepos,
      primaryRepo: result.primaryRepo,
      peakHourGlobal: result.peakHourGlobal,
      peakDayGlobal: result.peakDayGlobal,
      topLanguages: result.topLanguages?.slice(0, 8),
      topMessageThemes: result.topMessageThemes?.slice(0, 10),
      githubOAuth: result.sources.githubOAuth,
      localRepos: result.sources.localRepos,
    },
  });

  return result;
}

// ── Render ──────────────────────────────────────────────────────────────

export function codeUnifiedToText(s: CodeUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("CODE ACTIVITY:");
  lines.push(`  ${s.totalCommitsLast30d} commits in last 30d across ${s.activeRepos} active repos (${s.dormantRepos} dormant, ${s.abandonedRepos} abandoned)`);
  if (s.primaryRepo) lines.push(`  Primary: ${s.primaryRepo}`);
  if (s.peakDayGlobal !== undefined && s.peakHourGlobal !== undefined) {
    lines.push(`  Peak: ${s.peakDayGlobal} ~${s.peakHourGlobal}:00`);
  }
  if (s.topLanguages.length > 0) {
    lines.push(`  Languages: ${s.topLanguages.slice(0, 5).map(l => `${l.language}(${l.repoCount})`).join(", ")}`);
  }
  if (s.topMessageThemes.length > 0) {
    lines.push(`  Top commit themes: ${s.topMessageThemes.slice(0, 10).join(", ")}`);
  }
  const topRepos = s.repos.filter(r => r.state === "active").slice(0, 8);
  if (topRepos.length > 0) {
    lines.push("  Top active repos (30d commits):");
    for (const r of topRepos) {
      lines.push(`    ${String(r.totalCommitsLast30d).padStart(3)}  ${r.name.padEnd(30)} [${r.languages.join(",")}]${r.topMessageWords && r.topMessageWords.length > 0 ? ` — topics: ${r.topMessageWords.slice(0, 4).join(", ")}` : ""}`);
    }
  }
  if (s.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const sig of s.signals) lines.push(`    [${sig.strength}] ${sig.name} — ${sig.evidence}`);
  }
  if (s.coverage) lines.push(`  Coverage: ${s.coverage}`);
  return lines.join("\n");
}
