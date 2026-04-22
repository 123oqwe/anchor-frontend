/**
 * App Pair Signatures — higher-order patterns built from app combinations.
 *
 * Single-app signals are words; pairs / triples / quintets are sentences.
 * "Cursor installed" means 4 different things across 4 user types, but
 * "Cursor + Claude + ChatGPT Atlas + Codex + Trae + Ollama + Manus" means
 * one specific thing: this person RESEARCHES the AI tool space, they're
 * not just using tools.
 *
 * Each signature declares:
 *   - requires       — app ids that MUST be present (or at least requiresMin)
 *   - forbidden      — if any of these are present, the pattern does NOT fire
 *     (used both to dedupe and to carry absence semantics)
 *   - signal         — the higher-order signal emitted
 *   - description    — human-readable framing
 *   - strength       — medium/strong (absence of corroborating signals
 *                      should usually be medium; strong requires a tight
 *                      combo of ≥3 specific apps)
 *   - category       — ai / finance / creative / lifestyle / dev / geo
 *                      / identity / absence
 *
 * A signature with empty `requires` + non-empty `forbidden` is an ABSENCE
 * pattern — it fires when NONE of the forbidden apps are installed.
 *
 * Patterns here are curated based on observed real user profiles, NOT
 * generated programmatically. Nuance (e.g. "Fantastical vs Apple Calendar
 * reveals a different kind of power user") survives in human curation.
 */

import type { AppProfile } from "./app-registry.js";
import type { LocalizationFingerprint } from "./localization-fingerprint.js";

export type SignatureCategory =
  | "ai"
  | "finance"
  | "creative"
  | "lifestyle"
  | "dev"
  | "geo"
  | "identity"
  | "absence"
  | "privacy"
  | "entertainment";

export interface PairSignature {
  id: string;
  signal: string;                    // name of signal emitted (snake_case)
  description: string;               // human-readable reframe
  category: SignatureCategory;
  strength: "medium" | "strong";
  requires?: string[];               // app ids from registry; all (or requiresMin) must be present
  requiresMin?: number;              // if set, at least N of `requires` must match
  forbidden?: string[];              // any present → pattern aborts (also used for absence semantics)
  requiresLocaleRegion?: string[];   // must match primary localization region
  requiresTzPrefix?: string[];       // timezone must start with one of these
}

export interface MatchedSignature {
  id: string;
  signal: string;
  description: string;
  category: SignatureCategory;
  strength: "medium" | "strong";
  reqMatched: string[];              // which requires were present
}

// ── THE LIBRARY ───────────────────────────────────────────────────────────

export const PAIR_SIGNATURES: PairSignature[] = [

  // ═══════════ AI ECOSYSTEM PATTERNS ═══════════

  {
    id: "ai-tooling-researcher",
    signal: "ai-tooling-researcher",
    description: "Researches the AI tool space itself — installs everything to compare, not just to use",
    category: "ai", strength: "strong",
    requires: ["cursor", "claude-app", "chatgpt", "chatgpt-atlas", "codex-cli", "trae", "windsurf", "ollama", "lm-studio", "perplexity", "manus", "openclaw", "littlebird", "granola"],
    requiresMin: 5,
  },
  {
    id: "cn-us-ai-bridge",
    signal: "cn-us-ai-ecosystem-bridge",
    description: "Deeply participates in both Chinese and American AI ecosystems (rare crossover identity)",
    category: "ai", strength: "strong",
    requires: ["trae"],           // CN AI anchor
    requiresMin: 1,
  },
  // Stronger version: the above PLUS at least one US AI
  {
    id: "cn-us-ai-bridge-strong",
    signal: "cn-us-ai-ecosystem-bridge-strong",
    description: "Actively uses AI tools from BOTH China (ByteDance) and US (OpenAI/Anthropic)",
    category: "ai", strength: "strong",
    requires: ["trae", "claude-app", "chatgpt", "chatgpt-atlas", "codex-cli", "cursor"],
    requiresMin: 3,               // Trae + 2 US tools
  },
  {
    id: "llm-comparison-shopper",
    signal: "llm-comparison-shopper",
    description: "Uses 3+ LLM chat apps in parallel — compares models rather than committing to one",
    category: "ai", strength: "medium",
    requires: ["claude-app", "chatgpt", "chatgpt-atlas", "perplexity", "gemini", "grok"],
    requiresMin: 3,
  },
  {
    id: "local-llm-hobbyist",
    signal: "local-llm-privacy-hobbyist",
    description: "Runs LLMs on their own hardware — privacy-conscious or hacker-mindset",
    category: "ai", strength: "medium",
    requires: ["ollama", "lm-studio"],
    requiresMin: 1,
  },
  {
    id: "local-llm-extreme",
    signal: "local-llm-serious-infrastructure",
    description: "Serious about local LLM — has both easy GUI and CLI tools",
    category: "ai", strength: "strong",
    requires: ["ollama", "lm-studio"],
    requiresMin: 2,
  },
  {
    id: "agent-platform-builder",
    signal: "agent-platform-builder-or-power-user",
    description: "Participates in the emerging AI agent platform space — not just user, likely builder",
    category: "ai", strength: "strong",
    requires: ["manus", "openclaw", "littlebird", "ollama", "claude-app"],
    requiresMin: 3,
  },
  {
    id: "ai-meeting-knowledge-capture",
    signal: "ai-first-meeting-knowledge-worker",
    description: "Uses AI to capture meetings + notes — productivity in the 2024+ AI meeting wave",
    category: "ai", strength: "medium",
    requires: ["granola"],
    requiresMin: 1,
  },

  // ═══════════ DEV STACK PATTERNS ═══════════

  {
    id: "ai-native-dev-stack",
    signal: "ai-native-developer-2024-stack",
    description: "AI-first development stack — AI editor + modern AI-integrated terminal",
    category: "dev", strength: "strong",
    requires: ["cursor", "windsurf", "zed", "warp", "ghostty"],
    requiresMin: 2,
  },
  {
    id: "product-engineer-stack",
    signal: "product-engineer-design-conscious",
    description: "Full product-building stack: AI code + design + project mgmt + docs",
    category: "dev", strength: "strong",
    requires: ["cursor", "figma", "linear", "notion"],
    requiresMin: 3,
  },
  {
    id: "full-stack-modern",
    signal: "full-stack-modern-developer",
    description: "Classic full-stack setup — editor + container + DB client + API tester",
    category: "dev", strength: "medium",
    requires: ["cursor", "vscode", "docker-desktop", "orbstack", "tableplus", "postman", "insomnia", "bruno"],
    requiresMin: 3,
  },
  {
    id: "mac-automation-extreme",
    signal: "mac-automation-power-user",
    description: "Deep mac customization — scripts every workflow, invests in tooling layers",
    category: "dev", strength: "strong",
    requires: ["hammerspoon", "raycast", "better-touch-tool", "alfred", "shortcuts"],
    requiresMin: 2,
  },
  {
    id: "apple-native-developer",
    signal: "apple-native-developer",
    description: "Build for Apple platforms — iOS/macOS/watchOS native dev",
    category: "dev", strength: "strong",
    requires: ["xcode"],
    requiresMin: 1,
  },
  {
    id: "security-research-dev",
    signal: "security-or-network-researcher",
    description: "Network / security-adjacent developer",
    category: "dev", strength: "strong",
    requires: ["wireshark", "tor-browser"],
    requiresMin: 1,                // either alone is a strong signal
  },

  // ═══════════ CREATIVE / MUSIC PATTERNS ═══════════

  {
    id: "producer-dj-hybrid",
    signal: "producer-dj-hybrid",
    description: "Bridges production AND DJing — not pure DJ, not pure producer",
    category: "creative", strength: "strong",
    requires: ["ableton", "logic-pro", "fl-studio", "rekordbox", "serato", "djay-pro"],
    requiresMin: 2,                // at least 1 DAW + 1 DJ tool (or 2 of either)
  },
  {
    id: "dj-stack-transition",
    signal: "dj-stack-in-transition-or-comparison",
    description: "Has multiple DJ tools from different brands — switching or comparing",
    category: "creative", strength: "strong",
    requires: ["rekordbox", "serato", "djay-pro"],
    requiresMin: 2,
  },
  {
    id: "content-creator-serious",
    signal: "serious-content-creator",
    description: "Full creator stack: pro video + streaming + audio editing",
    category: "creative", strength: "strong",
    requires: ["final-cut-pro", "davinci-resolve", "obs", "descript"],
    requiresMin: 2,
  },
  {
    id: "apple-creative-native",
    signal: "apple-creative-ecosystem-pro",
    description: "Built on Apple's creative pro stack — deep iLife/iWork/pro-app user",
    category: "creative", strength: "medium",
    requires: ["logic-pro", "final-cut-pro", "garageband", "imovie"],
    requiresMin: 3,
  },
  {
    id: "electronic-music-producer",
    signal: "electronic-music-producer",
    description: "Electronic music production focus — DAW + sample library",
    category: "creative", strength: "strong",
    requires: ["ableton", "logic-pro", "fl-studio"],
    requiresMin: 1,                // DAW is required
    // Note: adding splice would strengthen (tracked via requires mixed with optionals)
  },
  {
    id: "electronic-music-producer-splice",
    signal: "electronic-music-producer-commercial",
    description: "Electronic music producer with commercial sample workflow",
    category: "creative", strength: "strong",
    requires: ["ableton", "splice"],
    requiresMin: 2,
  },

  // ═══════════ FINANCE PATTERNS ═══════════

  {
    id: "cn-investor-us-markets",
    signal: "cn-investor-us-markets",
    description: "Chinese investor who trades US equities — classic CN/US bridge retail investor",
    category: "finance", strength: "strong",
    requires: ["futu", "tiger-brokers", "tradingview"],
    requiresMin: 2,
  },
  {
    id: "quant-finance-stack",
    signal: "quant-or-data-driven-investor",
    description: "Python + charting + brokerage — quantitative / data-driven investor",
    category: "finance", strength: "strong",
    requires: ["tradingview", "thinkorswim"],
    requiresMin: 1,
  },
  {
    id: "crypto-native",
    signal: "crypto-native-multi-chain",
    description: "Multi-chain crypto user — Solana + Ethereum + hardware wallet security",
    category: "finance", strength: "strong",
    requires: ["phantom", "metamask", "ledger-live"],
    requiresMin: 2,
  },
  {
    id: "poker-professional",
    signal: "serious-poker-player",
    description: "Has multiple poker sites — likely plays seriously",
    category: "entertainment", strength: "strong",
    requires: ["poker-stars", "ggpoker"],
    requiresMin: 2,
  },

  // ═══════════ GEO / CULTURAL LIFESTYLE PATTERNS ═══════════

  {
    id: "mainland-cn-full-lifestyle",
    signal: "mainland-cn-lifestyle-full-stack",
    description: "Mainland China daily life ecosystem — payments, delivery, transport, shopping",
    category: "geo", strength: "strong",
    requires: ["wechat", "alipay", "taobao", "meituan", "didi"],
    requiresMin: 3,
  },
  {
    id: "cross-border-cn-overseas",
    signal: "cross-border-worker-cn-overseas",
    description: "Chinese-origin user with overseas work stack — needs GFW bridge",
    category: "geo", strength: "strong",
    requires: ["wechat", "telegram", "slack"],
    requiresMin: 2,
    // Bonus if VPN present
  },
  {
    id: "china-internet-gfw-bridge",
    signal: "gfw-circumvention-user",
    description: "Running China-specific VPN — user in or regularly accesses the mainland internet",
    category: "geo", strength: "strong",
    requires: ["transocks"],
    requiresMin: 1,
  },
  {
    id: "apple-ecosystem-devotee",
    signal: "apple-ecosystem-devotee",
    description: "Lives inside Apple's walled garden — uses all Apple-first productivity apps",
    category: "identity", strength: "medium",
    requires: ["apple-mail", "apple-calendar", "apple-music", "apple-pages", "apple-numbers", "apple-keynote", "apple-notes", "apple-reminders"],
    requiresMin: 4,
  },

  // ═══════════ LOCALIZATION-DEPENDENT CULTURAL PATTERNS ═══════════

  {
    id: "chinese-heritage-us-resident",
    signal: "chinese-heritage-us-resident",
    description: "Ethnic/heritage Chinese living in the US — retains CN app usage but OS is Americanized",
    category: "geo", strength: "strong",
    requires: ["wechat", "netease-music", "qq", "xiaohongshu", "douyin", "youdao-translate"],
    requiresMin: 1,
    requiresLocaleRegion: ["US"],
    requiresTzPrefix: ["America/"],
  },
  {
    id: "expat-in-greater-china",
    signal: "expat-in-greater-china",
    description: "English-OS user living in China/TW/HK — probably foreign expat",
    category: "geo", strength: "strong",
    requiresLocaleRegion: ["US", "EU"],
    requiresTzPrefix: ["Asia/Shanghai", "Asia/Taipei", "Asia/Hong_Kong", "Asia/Chongqing"],
    forbidden: ["wechat"],         // expats might have WeChat but without Chinese IME it's a different story — keep this simple for now
  },

  // ═══════════ PRIVACY / SECURITY PATTERNS ═══════════

  {
    id: "privacy-extreme",
    signal: "privacy-extreme-user",
    description: "Extreme privacy stack — encrypted comms, anonymized browser, hardened infra",
    category: "privacy", strength: "strong",
    requires: ["signal", "tor-browser", "brave", "wireguard"],
    requiresMin: 3,
  },
  {
    id: "security-aware",
    signal: "security-aware-power-user",
    description: "Above-average security hygiene — password manager + VPN + dedicated privacy browser",
    category: "privacy", strength: "medium",
    requires: ["1password", "bitwarden", "tailscale", "wireguard", "brave", "tor-browser"],
    requiresMin: 2,
  },

  // ═══════════ IDENTITY / COHORT PATTERNS ═══════════

  {
    id: "startup-engineer-2024",
    signal: "startup-engineer-2024-cohort",
    description: "Modern startup engineer stack — AI-native + design-conscious project mgmt",
    category: "identity", strength: "strong",
    requires: ["cursor", "linear", "figma", "notion", "arc"],
    requiresMin: 3,
  },
  {
    id: "indie-hacker-stack",
    signal: "indie-hacker-cohort",
    description: "Classic indie-hacker combo — ship solo with AI + docs + design",
    category: "identity", strength: "medium",
    requires: ["cursor", "notion", "figma", "claude-app", "chatgpt"],
    requiresMin: 3,
  },
  {
    id: "early-adopter-extreme",
    signal: "extreme-early-adopter-2024+",
    description: "Lives on the bleeding edge — uses apps launched in last 24 months",
    category: "identity", strength: "strong",
    // These all launched 2022+
    requires: ["cursor", "windsurf", "zed", "warp", "ghostty", "arc", "dia", "orbstack", "amie", "heptabase", "granola", "bruno", "notion-calendar", "chatgpt-atlas", "codex-cli", "trae", "manus", "openclaw", "littlebird", "zen-browser"],
    requiresMin: 4,
  },
  {
    id: "chinese-ai-tool-insider",
    signal: "chinese-ai-tool-insider",
    description: "Deeply plugged into Chinese AI tool ecosystem (ByteDance/Manus/etc)",
    category: "ai", strength: "strong",
    requires: ["trae", "manus"],
    requiresMin: 2,
  },
  {
    id: "competitive-intel-anchor-peer",
    signal: "anchor-peer-or-competitor-researcher",
    description: "Studying other personal AI assistants — competitive intelligence or active user",
    category: "identity", strength: "strong",
    requires: ["littlebird", "granola", "manus"],
    requiresMin: 2,
  },

  // ═══════════ CREATOR / STREAMING ═══════════

  {
    id: "streamer-setup",
    signal: "streamer-or-content-recorder",
    description: "Streaming / gaming content creator setup",
    category: "entertainment", strength: "strong",
    requires: ["obs", "discord", "steam"],
    requiresMin: 2,
  },

  // ═══════════ ABSENCE PATTERNS (what's missing tells us a lot) ═══════════

  {
    id: "absence-note-app",
    signal: "no-note-or-pkm-app-installed",
    description: "Does NOT use any note-taking or PKM app — either keeps knowledge in LLMs/text files or doesn't formalize knowledge capture",
    category: "absence", strength: "medium",
    forbidden: ["notion", "obsidian", "roam", "logseq", "craft", "bear", "heptabase", "apple-notes", "drafts", "mem"],
  },
  {
    id: "absence-task-app",
    signal: "no-formal-task-system",
    description: "Does NOT use any task manager — relies on calendar or memory for task tracking",
    category: "absence", strength: "medium",
    forbidden: ["things", "omnifocus", "todoist", "ticktick", "apple-reminders", "linear", "jira", "asana"],
  },
  {
    id: "absence-enhanced-calendar",
    signal: "calendar-minimalist",
    description: "Uses only default Apple Calendar — no power-user calendar investment",
    category: "absence", strength: "medium",
    forbidden: ["fantastical", "notion-calendar", "amie", "busycal"],
  },
  {
    id: "absence-design-tools",
    signal: "non-visual-worker",
    description: "No design/visual tools installed — pure engineering or text-first role",
    category: "absence", strength: "medium",
    forbidden: ["figma", "sketch", "photoshop", "illustrator", "framer", "blender", "after-effects"],
  },
  {
    id: "absence-social-broadcast",
    signal: "low-social-media-presence",
    description: "No broadcast social media apps — private or focus-oriented person",
    category: "absence", strength: "medium",
    forbidden: ["instagram", "x-twitter", "snapchat", "weibo", "xiaohongshu"],
  },
  {
    id: "absence-short-video-cn",
    signal: "no-cn-short-video-dopamine",
    description: "Despite Chinese presence, does not consume Douyin/Kuaishou short video",
    category: "absence", strength: "medium",
    requires: ["wechat"],          // requires being in CN ecosystem for this to be meaningful
    requiresMin: 1,
    forbidden: ["douyin"],
  },
];

// ── Matcher ────────────────────────────────────────────────────────────────

export interface SignatureMatchContext {
  installedAppIds: Set<string>;
  localization?: LocalizationFingerprint | null;
}

export function matchPairSignatures(
  matchedApps: { app: AppProfile }[],
  localization?: LocalizationFingerprint | null,
): MatchedSignature[] {
  const installedIds = new Set(matchedApps.map(m => m.app.id));
  const results: MatchedSignature[] = [];

  for (const sig of PAIR_SIGNATURES) {
    // Check `forbidden` first — any present aborts
    if (sig.forbidden && sig.forbidden.some(id => installedIds.has(id))) continue;

    // Check `requires`
    let reqMatched: string[] = [];
    if (sig.requires && sig.requires.length > 0) {
      reqMatched = sig.requires.filter(id => installedIds.has(id));
      const needed = sig.requiresMin ?? sig.requires.length;
      if (reqMatched.length < needed) continue;
    }

    // Localization region requirement
    if (sig.requiresLocaleRegion && sig.requiresLocaleRegion.length > 0) {
      if (!localization) continue;
      if (!sig.requiresLocaleRegion.includes(localization.inferredRegion)) continue;
    }

    // Timezone prefix requirement
    if (sig.requiresTzPrefix && sig.requiresTzPrefix.length > 0) {
      if (!localization) continue;
      if (!sig.requiresTzPrefix.some(p => localization.timezone.startsWith(p))) continue;
    }

    results.push({
      id: sig.id,
      signal: sig.signal,
      description: sig.description,
      category: sig.category,
      strength: sig.strength,
      reqMatched,
    });
  }

  return results;
}

// ── Render for profile text ────────────────────────────────────────────────

export function signaturesToText(matched: MatchedSignature[]): string {
  if (matched.length === 0) return "HIGHER-ORDER SIGNATURES: (none matched)";

  const byCategory = new Map<SignatureCategory, MatchedSignature[]>();
  for (const m of matched) {
    if (!byCategory.has(m.category)) byCategory.set(m.category, []);
    byCategory.get(m.category)!.push(m);
  }

  const lines: string[] = [];
  lines.push(`HIGHER-ORDER SIGNATURES (${matched.length} activated — combinations of apps that together mean something specific):`);

  const categoryOrder: SignatureCategory[] = [
    "identity", "ai", "dev", "creative", "finance", "geo", "privacy", "entertainment", "absence", "lifestyle",
  ];
  for (const cat of categoryOrder) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;
    lines.push(`\n  ${cat.toUpperCase()}:`);
    for (const m of list) {
      const label = `[${m.strength}]`.padEnd(8);
      const evidence = m.reqMatched.length > 0 ? ` — evidence: ${m.reqMatched.slice(0, 4).join(", ")}${m.reqMatched.length > 4 ? ", ..." : ""}` : "";
      lines.push(`    ${label} ${m.signal}${evidence}`);
      lines.push(`             └─ ${m.description}`);
    }
  }
  return lines.join("\n");
}
