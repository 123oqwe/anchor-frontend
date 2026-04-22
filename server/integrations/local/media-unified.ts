/**
 * Media Consumption Unification — taste + culture signals from music + video.
 *
 * Why it matters: media consumption reveals cultural taste (Spotify vs
 * NetEase), creative practice (Rekordbox DJ library), time allocation
 * (passive video vs active DJing). For CN/US bridge users, the split
 * between Spotify and NetEase is itself a strong identity signal.
 *
 * Sources:
 *   full-content  Apple Music (AppleScript — track count, recently played, top artists)
 *   presence+size Rekordbox (DJ library — folder presence + size)
 *   presence      Spotify, NetEase, QQ Music, YouTube, Bilibili, Tidal
 *   api (future)  Spotify OAuth, YouTube Google API
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { getTokens } from "../token-store.js";
import { DEFAULT_USER_ID } from "../../infra/storage/db.js";

const HOME = os.homedir();

export type MediaTier = "full-content" | "api" | "presence-only";

export interface MediaSource {
  appId: string;
  displayName: string;
  installed: boolean;
  active: boolean;
  tier: MediaTier;
  category: "music-stream" | "music-dj" | "music-daw" | "video-stream" | "audiobook" | "podcast";
  region: "US" | "CN" | "GLOBAL";
  trackCount?: number;
  playlistCount?: number;
  recentlyPlayedCount?: number;
  topArtists?: string[];
  libraryPath?: string;
  librarySizeBytes?: number;
}

export interface MediaUnifiedSummary {
  sources: MediaSource[];
  musicSplit: { westShare: number; cnShare: number; djShare: number };
  totalActive: number;
  primaryMusicSource: string;
  signals: MediaSignal[];
  coverage: string;
}

export interface MediaSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

function runAppleScript(script: string, timeoutMs = 10000): string {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: timeoutMs, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch { return ""; }
}

function isInstalled(appName: string): boolean {
  for (const d of ["/Applications", path.join(HOME, "Applications")]) {
    try { if (fs.existsSync(path.join(d, `${appName}.app`))) return true; } catch {}
  }
  return false;
}

function dirSizeBytes(dir: string, depthCap = 4): number {
  let size = 0;
  function walk(d: string, depth: number) {
    if (depth > depthCap) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else try { size += fs.statSync(full).size; } catch {}
    }
  }
  walk(dir, 0);
  return size;
}

// ── Apple Music ─────────────────────────────────────────────────────────

function scanAppleMusic(): MediaSource | null {
  if (!isInstalled("Music")) return null;
  const trackCountRaw = runAppleScript(`tell application "Music" to count of tracks`, 5000);
  const trackCount = parseInt(trackCountRaw, 10);
  if (isNaN(trackCount)) {
    return {
      appId: "apple-music", displayName: "Apple Music",
      installed: true, active: false, tier: "full-content",
      category: "music-stream", region: "GLOBAL",
    };
  }
  let playlistCount = 0;
  const plRaw = runAppleScript(`tell application "Music" to count of playlists`, 5000);
  if (!isNaN(parseInt(plRaw, 10))) playlistCount = parseInt(plRaw, 10);

  // Top artists from library (not streaming history — Music.app doesn't expose that directly)
  let topArtists: string[] = [];
  try {
    const script = `
      tell application "Music"
        set output to ""
        set uniqueArtists to {}
        set counter to 0
        repeat with t in (tracks whose played count > 0)
          if counter > 500 then exit repeat
          set counter to counter + 1
          set a to artist of t
          if a is not "" then
            if uniqueArtists does not contain a then
              set end of uniqueArtists to a
              set output to output & a & "|" & (played count of t as string) & "\\n"
            end if
          end if
        end repeat
        return output
      end tell`;
    const raw = runAppleScript(script, 15000);
    const artistCounts = new Map<string, number>();
    for (const line of raw.split("\n").filter(Boolean)) {
      const [artist, playsRaw] = line.split("|");
      if (!artist) continue;
      const plays = parseInt(playsRaw, 10) || 0;
      artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + plays);
    }
    topArtists = Array.from(artistCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a]) => a);
  } catch {}

  return {
    appId: "apple-music", displayName: "Apple Music",
    installed: true, active: trackCount > 0, tier: "full-content",
    category: "music-stream", region: "GLOBAL",
    trackCount, playlistCount, topArtists,
  };
}

// ── Rekordbox (DJ library) ──────────────────────────────────────────────

function scanRekordbox(): MediaSource | null {
  const libPath = path.join(HOME, "Documents/rekordbox");
  const altPath = path.join(HOME, "Library/Pioneer/rekordbox");
  let libraryPath = "";
  let librarySizeBytes = 0;

  for (const p of [libPath, altPath]) {
    if (fs.existsSync(p)) {
      libraryPath = p;
      librarySizeBytes = dirSizeBytes(p);
      break;
    }
  }

  const installed = isInstalled("rekordbox") || isInstalled("rekordbox 7");
  if (!installed && !libraryPath) return null;

  return {
    appId: "rekordbox", displayName: "rekordbox",
    installed, active: !!libraryPath && librarySizeBytes > 1_000_000,
    tier: "presence-only",          // we don't parse the library DB content
    category: "music-dj", region: "GLOBAL",
    libraryPath: libraryPath || undefined,
    librarySizeBytes: librarySizeBytes || undefined,
  };
}

// ── Presence detection for streaming + video apps ───────────────────────

interface PresenceSpec {
  appId: string;
  displayName: string;
  category: MediaSource["category"];
  region: MediaSource["region"];
  appNames: string[];   // /Applications lookup
}

const PRESENCE: PresenceSpec[] = [
  { appId: "spotify",        displayName: "Spotify",        category: "music-stream", region: "US",     appNames: ["Spotify"] },
  { appId: "netease-music",  displayName: "NetEase Music",  category: "music-stream", region: "CN",     appNames: ["NeteaseMusic", "NetEase Music"] },
  { appId: "qq-music",       displayName: "QQ Music",       category: "music-stream", region: "CN",     appNames: ["QQMusic", "QQ Music"] },
  { appId: "tidal",          displayName: "Tidal",          category: "music-stream", region: "US",     appNames: ["Tidal"] },
  { appId: "youtube-music",  displayName: "YouTube Music",  category: "music-stream", region: "GLOBAL", appNames: ["YouTube Music"] },
  { appId: "serato",         displayName: "Serato DJ",      category: "music-dj",     region: "GLOBAL", appNames: ["Serato DJ Pro", "Serato DJ Lite"] },
  { appId: "djay-pro",       displayName: "djay Pro",       category: "music-dj",     region: "GLOBAL", appNames: ["djay Pro"] },
  { appId: "traktor",        displayName: "Traktor",        category: "music-dj",     region: "GLOBAL", appNames: ["Traktor Pro"] },
  { appId: "ableton",        displayName: "Ableton Live",   category: "music-daw",    region: "GLOBAL", appNames: ["Ableton Live"] },
  { appId: "logic-pro",      displayName: "Logic Pro",      category: "music-daw",    region: "GLOBAL", appNames: ["Logic Pro"] },
  { appId: "bilibili",       displayName: "Bilibili",       category: "video-stream", region: "CN",     appNames: ["Bilibili"] },
  { appId: "netflix",        displayName: "Netflix",        category: "video-stream", region: "US",     appNames: ["Netflix"] },
];

// ── Main ────────────────────────────────────────────────────────────────

export async function scanMediaUnified(): Promise<MediaUnifiedSummary> {
  const sources: MediaSource[] = [];
  const appleMusic = scanAppleMusic();
  if (appleMusic) sources.push(appleMusic);
  const rekordbox = scanRekordbox();
  if (rekordbox) sources.push(rekordbox);

  for (const spec of PRESENCE) {
    if (sources.find(s => s.appId === spec.appId)) continue;
    const installed = spec.appNames.some(isInstalled);
    if (!installed) continue;
    sources.push({
      appId: spec.appId, displayName: spec.displayName,
      installed, active: false,
      tier: "presence-only", category: spec.category, region: spec.region,
    });
  }

  // Spotify OAuth presence
  const spotifyToken = getTokens(DEFAULT_USER_ID, "spotify");
  const spotifyEntry = sources.find(s => s.appId === "spotify");
  if (spotifyEntry && spotifyToken) {
    spotifyEntry.tier = "api";
  }

  const musicSources = sources.filter(s => s.category === "music-stream");
  const djSources = sources.filter(s => s.category === "music-dj");
  const dawSources = sources.filter(s => s.category === "music-daw");

  const westSources = musicSources.filter(s => s.region === "US");
  const cnSources = musicSources.filter(s => s.region === "CN");

  const totalMusicApps = musicSources.length;
  const westShare = totalMusicApps > 0 ? westSources.length / totalMusicApps : 0;
  const cnShare = totalMusicApps > 0 ? cnSources.length / totalMusicApps : 0;
  const djShare = (djSources.length + dawSources.length) / Math.max(1, musicSources.length + djSources.length + dawSources.length);

  // Primary music source heuristic: prefer one with actual track count signal
  let primary = "";
  if (appleMusic && (appleMusic.trackCount ?? 0) > 10) primary = "apple-music";
  else if (cnSources.length > 0 && westSources.length === 0) primary = cnSources[0].appId;
  else if (westSources.length > 0) primary = westSources[0].appId;

  const signals: MediaSignal[] = [];
  if (djSources.length + dawSources.length >= 2) {
    signals.push({ name: "serious-music-creator", strength: "strong",
      evidence: `${djSources.map(s => s.displayName).concat(dawSources.map(s => s.displayName)).join(" + ")} installed — not just consuming` });
  }
  if (djSources.length >= 2) {
    signals.push({ name: "dj-stack-multi-platform", strength: "medium",
      evidence: `Multiple DJ apps: ${djSources.map(s => s.displayName).join(" + ")}` });
  }
  if (rekordbox?.librarySizeBytes && rekordbox.librarySizeBytes > 1_000_000_000) {
    const gb = (rekordbox.librarySizeBytes / 1_073_741_824).toFixed(1);
    signals.push({ name: "deep-dj-library", strength: "strong",
      evidence: `rekordbox library ~${gb}GB — years of curation` });
  }
  if (westSources.length > 0 && cnSources.length > 0) {
    signals.push({ name: "cn-us-music-split", strength: "strong",
      evidence: `Active music across both: ${westSources.map(s => s.displayName).join(", ")} + ${cnSources.map(s => s.displayName).join(", ")}` });
  }
  if (cnSources.length >= 2) {
    signals.push({ name: "cn-music-ecosystem-user", strength: "medium",
      evidence: `Multiple CN music apps: ${cnSources.map(s => s.displayName).join(", ")}` });
  }
  if (musicSources.length === 0 && djSources.length === 0 && dawSources.length === 0) {
    signals.push({ name: "silent-lifestyle", strength: "medium",
      evidence: "No music apps detected — quiet life or uses web players only" });
  }
  if (appleMusic?.trackCount === 0 || (appleMusic?.trackCount !== undefined && appleMusic.trackCount < 20)) {
    signals.push({ name: "apple-music-not-primary", strength: "weak",
      evidence: `Apple Music library is minimal (${appleMusic?.trackCount ?? 0} tracks)` });
  }

  const coverage = [
    `Music streaming: ${musicSources.length} app${musicSources.length === 1 ? "" : "s"} (${westSources.length} western, ${cnSources.length} CN)`,
    djSources.length > 0 ? `DJ: ${djSources.length} apps` : "",
    dawSources.length > 0 ? `DAW: ${dawSources.length} apps` : "",
    rekordbox?.libraryPath ? `Rekordbox library: ${rekordbox.librarySizeBytes ? (rekordbox.librarySizeBytes / 1_073_741_824).toFixed(1) + "GB" : "present"}` : "",
    !spotifyToken && sources.find(s => s.appId === "spotify") ? "Spotify OAuth: not granted (would unlock listening history)" : "",
  ].filter(Boolean).join(". ");

  return {
    sources,
    musicSplit: {
      westShare: Math.round(westShare * 100) / 100,
      cnShare: Math.round(cnShare * 100) / 100,
      djShare: Math.round(djShare * 100) / 100,
    },
    totalActive: sources.filter(s => s.active).length,
    primaryMusicSource: primary,
    signals,
    coverage,
  };
}

// ── Render ──────────────────────────────────────────────────────────────

export function mediaUnifiedToText(s: MediaUnifiedSummary): string {
  const lines: string[] = [];
  lines.push("MEDIA CONSUMPTION:");
  lines.push(`  ${s.sources.length} media apps detected. Primary music: ${s.primaryMusicSource || "none"}`);
  lines.push(`  Split — West: ${Math.round(s.musicSplit.westShare * 100)}% · CN: ${Math.round(s.musicSplit.cnShare * 100)}% · DJ/DAW: ${Math.round(s.musicSplit.djShare * 100)}%`);

  const byCategory = new Map<string, MediaSource[]>();
  for (const src of s.sources) {
    if (!byCategory.has(src.category)) byCategory.set(src.category, []);
    byCategory.get(src.category)!.push(src);
  }
  byCategory.forEach((list, cat) => {
    lines.push(`  ${cat}:`);
    for (const src of list) {
      const meta: string[] = [];
      if (src.trackCount !== undefined) meta.push(`${src.trackCount} tracks`);
      if (src.playlistCount) meta.push(`${src.playlistCount} playlists`);
      if (src.librarySizeBytes) meta.push(`${(src.librarySizeBytes / 1_073_741_824).toFixed(1)}GB`);
      if (src.topArtists && src.topArtists.length > 0) meta.push(`top: ${src.topArtists.slice(0, 3).join(", ")}`);
      lines.push(`    [${src.tier}] ${src.displayName} (${src.region}): ${meta.join(", ") || "installed"}`);
    }
  });

  if (s.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const sig of s.signals) lines.push(`    [${sig.strength}] ${sig.name} — ${sig.evidence}`);
  }
  if (s.coverage) lines.push(`  Coverage: ${s.coverage}`);
  return lines.join("\n");
}
