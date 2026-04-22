/**
 * Anchor App Registry — the knowledge base of "what each app means".
 *
 * Design principle: Anchor should know what signals an app presence conveys
 * BEFORE scanning the user's Mac. Scanning then becomes "locate this user in
 * the app Universe" instead of "try to guess what these apps mean post-hoc".
 *
 * Each entry has four dimensions:
 *   1. category      — what kind of app (fine-grained, 50+ subcategories)
 *   2. regions       — cultural/geographic weight (CN/US/KR/JP/GLOBAL...)
 *   3. signals       — what presence of this app REVEALS about the user
 *   4. scanStrategy  — how Anchor can read data from it (SQLite? AppleScript?
 *                      Accessibility-only? API? permission required?)
 *
 * Registry is source-of-truth. Unknown apps go into unknown_apps table for
 * later LLM classification (one-shot per unknown, cached forever).
 *
 * This file is manually curated — LLMs are good at many things, app registries
 * are one of the places human taste still wins (nuance like "Fantastical is
 * different from Calendar in ways that tell you about the user's relationship
 * with time").
 */

// ── Type definitions ──────────────────────────────────────────────────────

export type AppRegion =
  | "CN"        // Mainland China
  | "TW"        // Taiwan
  | "HK"        // Hong Kong
  | "KR"        // South Korea
  | "JP"        // Japan
  | "IN"        // India
  | "SEA"       // Southeast Asia
  | "US"        // United States
  | "EU"        // Europe
  | "LATAM"     // Latin America
  | "MENA"      // Middle East / North Africa
  | "GLOBAL";   // broadly worldwide

export type AppCategory =
  // Communication — primary daily drivers
  | "comms-primary-personal"       // WeChat, iMessage, WhatsApp — main messenger
  | "comms-primary-work"           // Slack, Teams, DingTalk, Feishu, Lark
  | "comms-community"              // Discord, Telegram (communities), Reddit
  | "comms-broadcast-social"       // Instagram, Weibo, Xiaohongshu, X/Twitter
  | "comms-anonymous-ephemeral"    // Snapchat, BeReal
  | "comms-privacy-focused"        // Signal, Session, Threema
  | "comms-video-call"             // Zoom, Google Meet, FaceTime
  | "comms-email-client"           // Superhuman, Spark, Mimestream, Mail.app

  // Calendar & time
  | "calendar-basic"               // Apple Calendar, Google Calendar
  | "calendar-enhanced"            // Fantastical, Cron/Notion Calendar, Amie, BusyCal, Rise

  // Notes / Knowledge management
  | "note-pkm-graph"               // Obsidian, Roam, Logseq (graph-first)
  | "note-ui-first"                // Notion, Craft, Bear, Mem, Heptabase
  | "note-simple"                  // Apple Notes, Drafts
  | "note-outliner"                // OmniOutliner, Workflowy, Dynalist

  // Tasks
  | "task-personal-elegant"        // Things, OmniFocus (design-conscious)
  | "task-gtd-utility"             // TickTick, Todoist, Apple Reminders
  | "task-work-engineering"        // Linear, Jira, Height
  | "task-work-marketing"          // Asana, ClickUp, Monday

  // Development
  | "dev-editor-ai"                // Cursor, Windsurf, Zed (AI-native)
  | "dev-editor-classic"           // VS Code, Sublime, Vim, Emacs
  | "dev-editor-jetbrains"         // WebStorm/IntelliJ/PyCharm (paid, serious)
  | "dev-editor-native"            // Xcode, Android Studio
  | "dev-terminal-classic"         // Terminal.app
  | "dev-terminal-modern"          // iTerm2, Warp, Ghostty, Wezterm, Alacritty
  | "dev-git-gui"                  // GitHub Desktop, Sourcetree, Fork, Tower, GitKraken
  | "dev-db-client"                // TablePlus, DBeaver, Postico, Sequel Pro
  | "dev-api-tester"               // Postman, Insomnia, Bruno, Paw
  | "dev-container"                // Docker Desktop, OrbStack, Rancher
  | "dev-cloud-console"            // AWS, GCP, Cloudflare dashboards (as native wrappers)

  // Design
  | "design-ui-vector"             // Figma, Sketch
  | "design-raster-photo"          // Photoshop, Affinity Photo, Pixelmator
  | "design-illustration"          // Illustrator, Affinity Designer, Procreate
  | "design-3d"                    // Blender, Cinema 4D, Spline
  | "design-motion"                // After Effects, Rive, Principle, ProtoPie
  | "design-no-code"               // Framer, Webflow, Notion (as site builder)

  // Creative — music, video, audio
  | "creative-music-dj"            // rekordbox, Serato, Traktor, djay Pro
  | "creative-music-daw"           // Ableton, Logic Pro, FL Studio, Pro Tools, Bitwig, Reason
  | "creative-music-entry"         // GarageBand
  | "creative-video-pro"           // Final Cut Pro, DaVinci Resolve, Premiere
  | "creative-video-casual"        // iMovie, CapCut, Descript
  | "creative-video-stream"        // OBS, Streamlabs
  | "creative-audio-podcast"       // Descript, Audacity, Hindenburg
  | "creative-writing-pro"         // Scrivener, Ulysses, iA Writer

  // AI
  | "ai-chat-assistant"            // Claude, ChatGPT, Perplexity, Gemini, Grok, Poe
  | "ai-code-assistant"            // Cursor (also editor), GitHub Copilot standalone
  | "ai-local-llm"                 // Ollama, LM Studio, Jan, GPT4All
  | "ai-agent-platform"            // OpenClaw, Manus, Devin, Lindy, Relevance
  | "ai-image-generation"          // Midjourney (web), DrawThings, InvokeAI
  | "ai-voice-transcription"       // Otter, Whisper-based tools

  // Finance
  | "finance-trading-us"           // Robinhood, Webull, TD, Schwab, TradingView
  | "finance-trading-cn"           // Futu (富途), Tiger, 雪球
  | "finance-trading-pro"          // Bloomberg, ThinkOrSwim, Interactive Brokers
  | "finance-crypto-wallet"        // Phantom, Metamask, Ledger Live, Exodus, Rainbow
  | "finance-crypto-exchange"      // Coinbase, Binance, OKX, Kraken
  | "finance-personal-budget"      // Copilot, Monarch, YNAB, Mint (shut)
  | "finance-banking-traditional"  // Chase, BofA apps
  | "finance-banking-neobank"      // Wise, Revolut, Monzo
  | "finance-payment-cn"           // Alipay (支付宝), WeChat Pay
  | "finance-tax"                  // TurboTax, FreeTaxUSA

  // Reading / Research
  | "reading-longform"             // Kindle, Apple Books, Readwise
  | "reading-news-rss"             // Reeder, NetNewsWire, Feedly
  | "reading-later"                // Pocket, Instapaper, Matter, Omnivore
  | "reading-research"             // Zotero, Mendeley

  // Health
  | "health-fitness"               // Strava, Peloton, Fitbod, Gentler Streak
  | "health-sleep-tracker"         // AutoSleep, SleepWatch
  | "health-meditation"            // Calm, Headspace, Waking Up, Balance
  | "health-nutrition"             // MacroFactor, MyFitnessPal, Cronometer
  | "health-medical"               // Epic MyChart, One Medical

  // Entertainment
  | "entertainment-music-stream-west"  // Spotify, Apple Music, Tidal, YouTube Music
  | "entertainment-music-stream-cn"    // QQ Music, NetEase Cloud Music, KuGou
  | "entertainment-video-west"         // Netflix, Prime, Disney+, Apple TV+, HBO, YouTube
  | "entertainment-video-cn"           // Bilibili, iQiyi, Youku, Tencent Video, Migu
  | "entertainment-gaming-launcher"    // Steam, Epic, Battle.net, GOG
  | "entertainment-gambling"           // PokerStars, GGPoker
  | "entertainment-short-video-cn"     // Douyin (抖音), Kuaishou (快手)
  | "entertainment-short-video-west"   // TikTok, YouTube Shorts

  // Shopping / Lifestyle
  | "shopping-west-general"        // Amazon, Etsy
  | "shopping-cn-general"          // Taobao, Tmall, JD, Pinduoduo
  | "shopping-fashion"             // Shein, SSENSE, Farfetch, Xiaohongshu (also)
  | "shopping-grocery-food"        // Instacart, Meituan, Ele.me
  | "shopping-food-delivery"       // DoorDash, Uber Eats, Caviar, Meituan
  | "travel-booking"               // Booking, Airbnb, Expedia, Trip.com, Agoda
  | "travel-rides"                 // Uber, Lyft, Didi (滴滴)
  | "travel-maps"                  // Apple Maps, Google Maps, Amap (高德), Baidu Maps

  // Browser
  | "browser-mainstream"           // Chrome, Safari, Edge, Firefox
  | "browser-power-user"           // Arc, Dia, Vivaldi, Zen
  | "browser-privacy"              // Brave, Tor, Orion, LibreWolf
  | "browser-dev"                  // Chromium Canary, Firefox Dev Edition

  // Productivity utilities
  | "productivity-launcher"        // Raycast, Alfred, LaunchBar
  | "productivity-window-mgr"      // Rectangle, Magnet, BetterTouchTool, Moom
  | "productivity-automation"      // Hazel, Keyboard Maestro, Shortcuts
  | "productivity-text-expansion"  // TextExpander, Espanso
  | "productivity-clipboard"       // Paste, Alfred Clipboard, Maccy
  | "productivity-office-apple"    // Pages, Numbers, Keynote
  | "productivity-office-ms"       // Word, Excel, PowerPoint, Outlook
  | "productivity-office-google"   // Google Docs/Sheets/Slides (as native wrapper like Station)

  // Security & infrastructure
  | "vpn"                          // NordVPN, Mullvad, Tailscale, WireGuard, Proton, Ray
  | "password-manager"             // 1Password, Bitwarden, LastPass, Dashlane
  | "backup-cloud-sync"            // Dropbox, iCloud Drive, Google Drive, OneDrive
  | "system-utility"               // CleanMyMac, BetterZip, TheUnarchiver
  | "system-hardware"              // Logitech G HUB, CalDigit, Razer Synapse

  // Chinese-unique categories
  | "cn-super-app"                 // Alipay, WeChat, Baidu (as ecosystem entry)
  | "cn-live-streaming"            // YY, Douyu, Huya
  | "cn-qa-community"              // Zhihu (知乎), Douban (豆瓣)
  | "cn-ride-hail"                 // Didi
  | "cn-input-method"              // Sogou Pinyin, Baidu Input, QQ Input

  // Catchall
  | "other";

export type ScanMethod =
  | "sqlite-direct"           // we can open their SQLite file (e.g. iMessage chat.db)
  | "applescript"             // osascript with automation permission
  | "accessibility-only"      // Accessibility API can read window title + focused elements
  | "api-oauth"               // official API with user-granted OAuth
  | "fs-config"               // read app's config/preference files
  | "presence-only";          // can only tell whether it's installed + running, no data

export type TccPermission =
  | "contacts"        // TCC: Contacts
  | "calendar"        // TCC: Calendar
  | "reminders"       // TCC: Reminders
  | "fdda"            // Full Disk Access
  | "accessibility"   // Accessibility
  | "screen-record"   // Screen Recording
  | "automation"      // App automation (per-app)
  | "none";

export interface ScanStrategy {
  canReadContent: boolean;                  // can we read messages/docs/events themselves?
  method: ScanMethod;
  path?: string;                            // file path if applicable (supports ~)
  permission?: TccPermission;
  notes?: string;
  degradesTo?: ScanStrategy;                // fallback if permission denied
}

export interface AppSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
}

export interface AppProfile {
  id: string;                               // canonical lowercase-slug
  name: string;                             // display name
  aliases?: string[];                       // alt names including CN/JP characters
  bundleId?: string;                        // macOS bundle identifier if known
  category: AppCategory;
  subcategories?: AppCategory[];
  regions: AppRegion[];
  signals: AppSignal[];
  scanStrategy: ScanStrategy;
  launchedYear?: number;
  platforms?: Array<"macos" | "windows" | "linux" | "ios" | "android" | "web">;
}

// ── Scan-strategy shorthand constants ─────────────────────────────────────

const PRESENCE: ScanStrategy = {
  canReadContent: false, method: "presence-only",
  notes: "Only installation + run frequency is observable",
};
const ACCESSIBILITY: ScanStrategy = {
  canReadContent: false, method: "accessibility-only", permission: "accessibility",
  notes: "Window title + focused element text; no message history",
};
const FS_CONFIG: ScanStrategy = {
  canReadContent: false, method: "fs-config",
  notes: "Read config/preference files — tells us about setup, not usage",
};

// Shorthand signal helpers
const sig = (name: string, strength: AppSignal["strength"] = "medium"): AppSignal => ({ name, strength });
const strong = (name: string): AppSignal => sig(name, "strong");
const weak = (name: string): AppSignal => sig(name, "weak");

// ── THE REGISTRY ──────────────────────────────────────────────────────────

export const APP_REGISTRY: AppProfile[] = [

  // ═══════════ COMMUNICATION ═══════════

  // CN comms
  {
    id: "wechat", name: "WeChat", aliases: ["微信", "Weixin", "WeChat.app"],
    bundleId: "com.tencent.xinWeChat",
    category: "comms-primary-personal",
    regions: ["CN", "HK", "TW", "GLOBAL"],
    signals: [
      strong("chinese-cultural-context"),
      strong("personal-work-mixed-network"),
      strong("payment-ecosystem-user"),           // WeChat Pay integrated
      sig("mobile-first-mindset"),
    ],
    scanStrategy: {
      canReadContent: false, method: "accessibility-only", permission: "accessibility",
      notes: "Chat DB is encrypted on macOS. Can only read window title + badge count.",
    },
    platforms: ["macos", "windows", "ios", "android", "web"],
    launchedYear: 2011,
  },
  {
    id: "qq", name: "QQ", aliases: ["腾讯QQ", "TencentQQ"],
    bundleId: "com.tencent.qq",
    category: "comms-primary-personal",
    regions: ["CN"],
    signals: [
      strong("chinese-cultural-context"),
      sig("gen-z-or-older-cohort"),             // QQ skews either very young or pre-WeChat era
      weak("gaming-adjacent"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "dingtalk", name: "DingTalk", aliases: ["钉钉"],
    bundleId: "com.alibaba.DingTalkMac",
    category: "comms-primary-work",
    regions: ["CN"],
    signals: [
      strong("chinese-tech-workplace"),
      strong("alibaba-ecosystem-tangent"),
      sig("work-life-low-boundary"),            // DingTalk culture is famously aggressive
    ],
    scanStrategy: ACCESSIBILITY,
  },
  {
    id: "feishu", name: "Feishu", aliases: ["飞书", "Lark"],
    bundleId: "com.bytedance.lark",
    category: "comms-primary-work",
    regions: ["CN", "SEA"],
    signals: [
      strong("bytedance-ecosystem"),
      sig("modern-cn-tech-workplace"),          // Feishu = new-gen vs DingTalk
      sig("english-friendly-in-cn-firm"),       // Lark is Feishu's English face
    ],
    scanStrategy: ACCESSIBILITY,
  },
  {
    id: "weibo", name: "Weibo", aliases: ["微博"],
    bundleId: "com.sina.weibo.mac",
    category: "comms-broadcast-social",
    regions: ["CN"],
    signals: [
      strong("chinese-cultural-context"),
      sig("news-junkie-cn"),
      sig("public-sphere-engagement"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "xiaohongshu", name: "Xiaohongshu", aliases: ["小红书", "RED", "XHS"],
    category: "comms-broadcast-social",
    subcategories: ["shopping-fashion"],
    regions: ["CN", "HK", "TW"],
    signals: [
      strong("chinese-cultural-context"),
      strong("lifestyle-content-consumer"),
      sig("gen-z-or-millennial"),
      sig("fashion-or-travel-curious"),
    ],
    scanStrategy: PRESENCE,
    platforms: ["ios", "android", "web"],
  },
  {
    id: "douyin", name: "Douyin", aliases: ["抖音"],
    category: "entertainment-short-video-cn",
    regions: ["CN"],
    signals: [
      strong("chinese-cultural-context"),
      strong("short-video-consumer"),
      weak("attention-fragmentation-risk"),
    ],
    scanStrategy: PRESENCE,
    platforms: ["ios", "android", "web"],
  },
  {
    id: "bilibili", name: "Bilibili", aliases: ["B站", "哔哩哔哩"],
    category: "entertainment-video-cn",
    regions: ["CN"],
    signals: [
      strong("chinese-cultural-context"),
      sig("anime-gaming-tech-interests"),
      sig("long-form-video-learner"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "zhihu", name: "Zhihu", aliases: ["知乎"],
    category: "cn-qa-community",
    regions: ["CN"],
    signals: [
      strong("chinese-intellectual-reader"),
      sig("deep-research-habit"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "douban", name: "Douban", aliases: ["豆瓣"],
    category: "cn-qa-community",
    regions: ["CN"],
    signals: [
      strong("chinese-cultural-sophisticate"),  // Douban users tend to be readers/cinephiles
      sig("literary-cinephile"),
    ],
    scanStrategy: PRESENCE,
  },

  // Western / global comms
  {
    id: "imessage", name: "Messages", aliases: ["iMessage", "Messages.app"],
    bundleId: "com.apple.MobileSMS",
    category: "comms-primary-personal",
    regions: ["US", "GLOBAL"],
    signals: [
      strong("apple-ecosystem-native"),
      strong("western-personal-comms"),
      sig("close-circle-only"),                 // iMessage tends to be family/close friends
    ],
    scanStrategy: {
      canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Messages/chat.db",
      permission: "fdda",
      notes: "Full Disk Access grants read of chat.db. This is the ONLY major chat app we can read messages from on macOS.",
      degradesTo: ACCESSIBILITY,
    },
  },
  {
    id: "whatsapp", name: "WhatsApp",
    bundleId: "net.whatsapp.WhatsApp",
    category: "comms-primary-personal",
    regions: ["GLOBAL", "IN", "LATAM", "MENA", "EU"],
    signals: [
      strong("international-family-friends"),
      sig("non-china-non-korea-likely"),
    ],
    scanStrategy: {
      canReadContent: false, method: "accessibility-only", permission: "accessibility",
      notes: "Mac app stores encrypted cache. Message body not readable locally.",
    },
  },
  {
    id: "telegram", name: "Telegram",
    bundleId: "ru.keepcoder.Telegram",
    category: "comms-community",
    regions: ["GLOBAL", "EU", "MENA"],
    signals: [
      sig("tech-crypto-adjacent"),
      sig("privacy-value-but-not-extreme"),
      sig("community-group-member"),
    ],
    scanStrategy: {
      canReadContent: false, method: "fs-config",
      path: "~/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/account-*/postbox",
      notes: "Telegram stores in sqlite but DB is partly encrypted. Contact list sometimes readable.",
    },
  },
  {
    id: "signal", name: "Signal",
    bundleId: "org.whispersystems.signal-desktop",
    category: "comms-privacy-focused",
    regions: ["US", "EU", "GLOBAL"],
    signals: [
      strong("privacy-conscious"),
      sig("security-aware"),
      weak("journalism-activism-adjacent"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "discord", name: "Discord",
    bundleId: "com.hnc.Discord",
    category: "comms-community",
    regions: ["US", "GLOBAL"],
    signals: [
      strong("gaming-or-tech-community-member"),
      sig("dev-community-if-combined-with-github"),
    ],
    scanStrategy: PRESENCE,  // Electron app, data mostly unreadable locally
  },
  {
    id: "slack", name: "Slack",
    bundleId: "com.tinyspeck.slackmacgap",
    category: "comms-primary-work",
    regions: ["US", "EU", "GLOBAL"],
    signals: [
      strong("western-tech-workplace"),
      sig("remote-or-hybrid-work"),
    ],
    scanStrategy: {
      canReadContent: false, method: "accessibility-only", permission: "accessibility",
      notes: "Local cache encrypted. OAuth via Slack API needed for real read access.",
    },
  },
  {
    id: "ms-teams", name: "Microsoft Teams",
    bundleId: "com.microsoft.teams2",
    category: "comms-primary-work",
    regions: ["US", "EU", "GLOBAL"],
    signals: [
      strong("enterprise-workplace"),
      weak("non-startup-culture"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "zoom", name: "Zoom", aliases: ["zoom.us"],
    bundleId: "us.zoom.xos",
    category: "comms-video-call",
    regions: ["GLOBAL"],
    signals: [sig("video-meeting-regular")],
    scanStrategy: PRESENCE,
  },
  {
    id: "facetime", name: "FaceTime",
    bundleId: "com.apple.FaceTime",
    category: "comms-video-call",
    regions: ["US", "GLOBAL"],
    signals: [strong("apple-ecosystem-native")],
    scanStrategy: PRESENCE,
  },
  {
    id: "instagram", name: "Instagram",
    category: "comms-broadcast-social",
    regions: ["GLOBAL", "US"],
    signals: [
      sig("visual-culture-consumer"),
      sig("younger-demographic"),
    ],
    scanStrategy: PRESENCE,
    platforms: ["ios", "android", "web"],
  },
  {
    id: "snapchat", name: "Snapchat",
    category: "comms-anonymous-ephemeral",
    regions: ["US"],
    signals: [
      sig("gen-z-primary"),
      sig("close-friends-ephemeral"),
    ],
    scanStrategy: PRESENCE,
    platforms: ["ios", "android"],
  },
  {
    id: "x-twitter", name: "X",
    aliases: ["Twitter", "X.app"],
    category: "comms-broadcast-social",
    regions: ["US", "GLOBAL"],
    signals: [
      sig("public-discourse-engager"),
      weak("tech-politics-thought-leader-aspirant"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "linkedin", name: "LinkedIn",
    category: "comms-broadcast-social",
    regions: ["US", "GLOBAL", "EU"],
    signals: [
      sig("career-conscious"),
      weak("open-to-recruiter-contact"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "reddit", name: "Reddit",
    category: "comms-community",
    regions: ["US", "GLOBAL"],
    signals: [sig("community-lurker-or-participant")],
    scanStrategy: PRESENCE,
  },
  {
    id: "line", name: "LINE",
    category: "comms-primary-personal",
    regions: ["JP", "TW", "SEA"],
    signals: [
      strong("japan-or-taiwan-cultural-context"),
      sig("manga-anime-adjacent"),
    ],
    scanStrategy: PRESENCE,
  },
  {
    id: "kakaotalk", name: "KakaoTalk", aliases: ["카카오톡"],
    category: "comms-primary-personal",
    regions: ["KR"],
    signals: [
      strong("korean-cultural-context"),
    ],
    scanStrategy: PRESENCE,
  },

  // Email clients
  { id: "apple-mail", name: "Mail", aliases: ["Apple Mail"], bundleId: "com.apple.mail",
    category: "comms-email-client", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")],
    scanStrategy: { canReadContent: true, method: "applescript", permission: "automation",
      notes: "AppleScript access to Mail.app. Requires automation permission." } },
  { id: "superhuman", name: "Superhuman", category: "comms-email-client", regions: ["US"],
    signals: [strong("email-power-user-paid"), sig("productivity-maximalist")],
    scanStrategy: PRESENCE },
  { id: "spark", name: "Spark Mail", category: "comms-email-client", regions: ["GLOBAL"],
    signals: [sig("power-email-user-free-tier")],
    scanStrategy: PRESENCE },
  { id: "mimestream", name: "Mimestream", category: "comms-email-client", regions: ["US"],
    signals: [strong("gmail-heavy-user-wanting-native"), sig("mac-aesthetic-conscious")],
    scanStrategy: PRESENCE },

  // ═══════════ CALENDAR ═══════════

  { id: "apple-calendar", name: "Calendar", aliases: ["Apple Calendar"],
    bundleId: "com.apple.iCal",
    category: "calendar-basic", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")],
    scanStrategy: { canReadContent: true, method: "applescript", permission: "calendar",
      notes: "Apple Calendar aggregates iCloud + any CalDAV synced via Internet Accounts (incl Google)." } },
  { id: "fantastical", name: "Fantastical", category: "calendar-enhanced", regions: ["US", "GLOBAL"],
    signals: [strong("power-scheduler"), sig("willing-to-pay-for-polish")],
    scanStrategy: { canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Group Containers/*.flexibits*/Library/Application Support/Fantastical*",
      notes: "Has own DB alongside syncing from Apple Calendar." } },
  { id: "notion-calendar", name: "Notion Calendar", aliases: ["Cron Calendar", "Cron"],
    category: "calendar-enhanced", regions: ["US"],
    signals: [strong("notion-ecosystem"), sig("calendly-replacement-user"), sig("modern-meeting-culture")],
    scanStrategy: PRESENCE },
  { id: "busycal", name: "BusyCal", category: "calendar-enhanced", regions: ["US"],
    signals: [sig("mature-mac-user-preference")], scanStrategy: PRESENCE },
  { id: "amie", name: "Amie", category: "calendar-enhanced", regions: ["EU", "US"],
    signals: [sig("design-forward-cal-user"), sig("newer-tech-wave-2023+")],
    scanStrategy: PRESENCE, launchedYear: 2022 },

  // ═══════════ NOTES & PKM ═══════════

  { id: "obsidian", name: "Obsidian", bundleId: "md.obsidian",
    category: "note-pkm-graph", regions: ["GLOBAL"],
    signals: [strong("knowledge-system-builder"), strong("local-first-values"), sig("technical-note-taker")],
    scanStrategy: { canReadContent: true, method: "fs-config",
      notes: "Vault is just markdown files. Path depends on user's choice — commonly ~/Obsidian or ~/Documents/Vault." } },
  { id: "roam", name: "Roam Research", category: "note-pkm-graph", regions: ["US"],
    signals: [strong("knowledge-system-builder"), sig("early-wave-pkm-2020")],
    scanStrategy: PRESENCE, launchedYear: 2019 },
  { id: "logseq", name: "Logseq", category: "note-pkm-graph", regions: ["GLOBAL"],
    signals: [strong("local-first-values"), strong("oss-preference"), sig("daily-journaler")],
    scanStrategy: { canReadContent: true, method: "fs-config" }, launchedYear: 2020 },
  { id: "notion", name: "Notion", bundleId: "notion.id",
    category: "note-ui-first", regions: ["US", "GLOBAL"],
    signals: [sig("team-workspace-user"), sig("database-thinker"), weak("project-sprawl-risk")],
    scanStrategy: PRESENCE, launchedYear: 2016 },
  { id: "craft", name: "Craft", category: "note-ui-first", regions: ["EU", "US"],
    signals: [sig("design-aesthetic-writer"), sig("apple-ecosystem-premium")], scanStrategy: PRESENCE },
  { id: "bear", name: "Bear", category: "note-ui-first", regions: ["GLOBAL"],
    signals: [sig("writer-over-database-user"), sig("apple-ecosystem-minimalist")], scanStrategy: PRESENCE },
  { id: "heptabase", name: "Heptabase", category: "note-pkm-graph", regions: ["TW", "GLOBAL"],
    signals: [strong("visual-thinker"), strong("research-deep-diver"), sig("2023+-wave")],
    scanStrategy: PRESENCE, launchedYear: 2022 },
  { id: "apple-notes", name: "Notes", aliases: ["Apple Notes"], bundleId: "com.apple.Notes",
    category: "note-simple", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native"), weak("low-effort-note-taker")],
    scanStrategy: { canReadContent: false, method: "sqlite-direct",
      path: "~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
      notes: "Notes DB is readable in structure but content is compressed/encrypted per-note." } },
  { id: "drafts", name: "Drafts", category: "note-simple", regions: ["US"],
    signals: [sig("quick-capture-workflow"), sig("apple-shortcuts-user")], scanStrategy: PRESENCE },

  // ═══════════ TASKS ═══════════

  { id: "things", name: "Things", aliases: ["Things 3"],
    bundleId: "com.culturedcode.ThingsMac",
    category: "task-personal-elegant", regions: ["EU", "US", "GLOBAL"],
    signals: [strong("apple-aesthetic-premium"), sig("gtd-practitioner")],
    scanStrategy: { canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite" } },
  { id: "omnifocus", name: "OmniFocus", category: "task-personal-elegant", regions: ["US"],
    signals: [strong("gtd-serious-practitioner"), sig("mature-mac-professional")],
    scanStrategy: PRESENCE },
  { id: "ticktick", name: "TickTick", category: "task-gtd-utility", regions: ["CN", "GLOBAL"],
    signals: [sig("chinese-origin-tool"), sig("cross-platform-user")], scanStrategy: PRESENCE },
  { id: "todoist", name: "Todoist", category: "task-gtd-utility", regions: ["GLOBAL"],
    signals: [sig("gtd-casual-practitioner")], scanStrategy: PRESENCE },
  { id: "apple-reminders", name: "Reminders", bundleId: "com.apple.reminders",
    category: "task-gtd-utility", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")],
    scanStrategy: { canReadContent: true, method: "applescript", permission: "reminders" } },
  { id: "linear", name: "Linear", category: "task-work-engineering", regions: ["US", "GLOBAL"],
    signals: [strong("startup-engineering-culture"), sig("design-conscious-dev")],
    scanStrategy: PRESENCE, launchedYear: 2019 },
  { id: "jira", name: "Jira", category: "task-work-engineering", regions: ["GLOBAL"],
    signals: [sig("enterprise-software-culture"), weak("bureaucracy-exposure")], scanStrategy: PRESENCE },
  { id: "asana", name: "Asana", category: "task-work-marketing", regions: ["US"],
    signals: [sig("marketing-ops-or-non-tech-team")], scanStrategy: PRESENCE },

  // ═══════════ DEV — EDITORS ═══════════

  { id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92",
    category: "dev-editor-ai", regions: ["US", "GLOBAL"],
    signals: [strong("ai-native-developer"), strong("early-adopter-2024"), sig("productivity-obsessive")],
    scanStrategy: { canReadContent: false, method: "fs-config",
      notes: "~/.cursor/ has config + MCP settings. Config depth = usage depth." },
    launchedYear: 2023 },
  { id: "windsurf", name: "Windsurf", aliases: ["Codeium Windsurf"],
    category: "dev-editor-ai", regions: ["US", "GLOBAL"],
    signals: [strong("ai-native-developer"), strong("early-adopter-2024")],
    scanStrategy: PRESENCE, launchedYear: 2024 },
  { id: "zed", name: "Zed", category: "dev-editor-ai", regions: ["US"],
    signals: [sig("performance-focused-dev"), sig("rust-appreciator"), sig("newer-wave-2023+")],
    scanStrategy: PRESENCE, launchedYear: 2023 },
  { id: "vscode", name: "Visual Studio Code", bundleId: "com.microsoft.VSCode",
    category: "dev-editor-classic", regions: ["GLOBAL"],
    signals: [sig("mainstream-dev-baseline")],
    scanStrategy: { canReadContent: false, method: "fs-config",
      notes: "~/Library/Application Support/Code/ extensions + settings." } },
  { id: "xcode", name: "Xcode", bundleId: "com.apple.dt.Xcode",
    category: "dev-editor-native", regions: ["GLOBAL"],
    signals: [strong("apple-native-developer"), sig("swift-or-ios-work")],
    scanStrategy: PRESENCE },
  { id: "webstorm", name: "WebStorm", category: "dev-editor-jetbrains", regions: ["GLOBAL"],
    signals: [sig("paid-jetbrains-serious"), sig("mature-team-engineer")], scanStrategy: PRESENCE },
  { id: "pycharm", name: "PyCharm", category: "dev-editor-jetbrains", regions: ["GLOBAL"],
    signals: [sig("python-first-dev"), sig("data-science-or-django")], scanStrategy: PRESENCE },
  { id: "intellij", name: "IntelliJ IDEA", category: "dev-editor-jetbrains", regions: ["GLOBAL"],
    signals: [sig("jvm-ecosystem-dev"), sig("enterprise-java-or-kotlin")], scanStrategy: PRESENCE },
  { id: "sublime-text", name: "Sublime Text", category: "dev-editor-classic", regions: ["GLOBAL"],
    signals: [sig("minimalist-dev"), sig("pre-vscode-era-loyalty")], scanStrategy: PRESENCE },
  { id: "neovim", name: "Neovim", category: "dev-editor-classic", regions: ["GLOBAL"],
    signals: [strong("terminal-first-dev"), strong("power-user-tinkerer")], scanStrategy: PRESENCE },
  { id: "android-studio", name: "Android Studio", category: "dev-editor-native", regions: ["GLOBAL"],
    signals: [strong("android-developer")], scanStrategy: PRESENCE },

  // ═══════════ DEV — TERMINAL ═══════════
  { id: "apple-terminal", name: "Terminal", bundleId: "com.apple.Terminal",
    category: "dev-terminal-classic", regions: ["GLOBAL"],
    signals: [weak("default-user")], scanStrategy: PRESENCE },
  { id: "iterm2", name: "iTerm2", bundleId: "com.googlecode.iterm2",
    category: "dev-terminal-modern", regions: ["GLOBAL"],
    signals: [sig("mac-dev-baseline"), weak("pre-warp-era")], scanStrategy: FS_CONFIG },
  { id: "warp", name: "Warp", category: "dev-terminal-modern", regions: ["US", "GLOBAL"],
    signals: [strong("ai-native-dev"), sig("newer-wave-2022+")], scanStrategy: PRESENCE, launchedYear: 2022 },
  { id: "ghostty", name: "Ghostty", category: "dev-terminal-modern", regions: ["US"],
    signals: [strong("performance-obsessed-dev"), strong("early-adopter-2024")],
    scanStrategy: PRESENCE, launchedYear: 2024 },
  { id: "wezterm", name: "WezTerm", category: "dev-terminal-modern", regions: ["GLOBAL"],
    signals: [sig("config-tinkerer"), sig("lua-friendly")], scanStrategy: PRESENCE },

  // ═══════════ DEV — GIT/API/DB/CONTAINER ═══════════

  { id: "github-desktop", name: "GitHub Desktop", category: "dev-git-gui", regions: ["GLOBAL"],
    signals: [sig("beginner-to-intermediate-git"), sig("team-workflow")], scanStrategy: PRESENCE },
  { id: "sourcetree", name: "Sourcetree", category: "dev-git-gui", regions: ["GLOBAL"],
    signals: [sig("visual-git-user"), sig("atlassian-ecosystem")], scanStrategy: PRESENCE },
  { id: "fork", name: "Fork", category: "dev-git-gui", regions: ["GLOBAL"],
    signals: [sig("paid-git-gui-preference")], scanStrategy: PRESENCE },
  { id: "postman", name: "Postman", category: "dev-api-tester", regions: ["GLOBAL"],
    signals: [sig("api-developer")], scanStrategy: PRESENCE },
  { id: "insomnia", name: "Insomnia", category: "dev-api-tester", regions: ["GLOBAL"],
    signals: [sig("api-developer-oss-preference")], scanStrategy: PRESENCE },
  { id: "bruno", name: "Bruno", category: "dev-api-tester", regions: ["GLOBAL"],
    signals: [sig("local-first-api-tool"), sig("newer-wave-2023+")], scanStrategy: PRESENCE, launchedYear: 2023 },
  { id: "tableplus", name: "TablePlus", category: "dev-db-client", regions: ["GLOBAL"],
    signals: [sig("db-heavy-developer"), sig("apple-aesthetic")], scanStrategy: PRESENCE },
  { id: "dbeaver", name: "DBeaver", category: "dev-db-client", regions: ["GLOBAL"],
    signals: [sig("enterprise-or-oss-dev")], scanStrategy: PRESENCE },
  { id: "docker-desktop", name: "Docker", aliases: ["Docker Desktop"], bundleId: "com.docker.docker",
    category: "dev-container", regions: ["GLOBAL"],
    signals: [strong("containerized-workflow"), sig("backend-or-devops")], scanStrategy: PRESENCE },
  { id: "orbstack", name: "OrbStack", category: "dev-container", regions: ["GLOBAL"],
    signals: [strong("performance-obsessive"), sig("docker-replacement-seeker"), sig("2023+-wave")],
    scanStrategy: PRESENCE, launchedYear: 2022 },

  // ═══════════ DESIGN ═══════════

  { id: "figma", name: "Figma", bundleId: "com.figma.Desktop",
    category: "design-ui-vector", regions: ["GLOBAL"],
    signals: [strong("product-designer-baseline"), sig("collaborative-design")], scanStrategy: PRESENCE },
  { id: "sketch", name: "Sketch", category: "design-ui-vector", regions: ["GLOBAL"],
    signals: [sig("pre-figma-designer"), sig("mac-only-design-preference")], scanStrategy: PRESENCE },
  { id: "framer", name: "Framer", category: "design-no-code", regions: ["GLOBAL"],
    signals: [strong("designer-engineer-hybrid"), sig("no-code-site-builder")], scanStrategy: PRESENCE },
  { id: "webflow", name: "Webflow", category: "design-no-code", regions: ["US"],
    signals: [sig("visual-web-builder")], scanStrategy: PRESENCE },
  { id: "photoshop", name: "Photoshop", aliases: ["Adobe Photoshop"],
    category: "design-raster-photo", regions: ["GLOBAL"],
    signals: [sig("creative-pro-or-hobbyist-photo")], scanStrategy: PRESENCE },
  { id: "blender", name: "Blender", category: "design-3d", regions: ["GLOBAL"],
    signals: [sig("3d-artist-oss-preference"), sig("self-taught-creator")], scanStrategy: PRESENCE },
  { id: "after-effects", name: "After Effects", aliases: ["Adobe After Effects"],
    category: "design-motion", regions: ["GLOBAL"],
    signals: [sig("motion-design-serious")], scanStrategy: PRESENCE },

  // ═══════════ CREATIVE — MUSIC/VIDEO ═══════════

  { id: "rekordbox", name: "rekordbox", aliases: ["rekordbox 7"],
    category: "creative-music-dj", regions: ["GLOBAL"],
    signals: [strong("pioneer-dj-ecosystem"), strong("dj-practitioner")], scanStrategy: PRESENCE },
  { id: "serato", name: "Serato DJ Pro", aliases: ["Serato DJ Lite", "Serato"],
    category: "creative-music-dj", regions: ["GLOBAL"],
    signals: [strong("dj-practitioner"), sig("vinyl-or-battle-dj-lineage")], scanStrategy: PRESENCE },
  { id: "ableton", name: "Ableton Live",
    category: "creative-music-daw", regions: ["GLOBAL"],
    signals: [strong("electronic-music-producer"), sig("performance-composer-hybrid")], scanStrategy: PRESENCE },
  { id: "logic-pro", name: "Logic Pro",
    bundleId: "com.apple.logic10",
    category: "creative-music-daw", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-pro-creator"), sig("serious-music-producer")], scanStrategy: PRESENCE },
  { id: "fl-studio", name: "FL Studio", category: "creative-music-daw", regions: ["GLOBAL"],
    signals: [strong("producer"), sig("hip-hop-electronic-adjacent")], scanStrategy: PRESENCE },
  { id: "garageband", name: "GarageBand", bundleId: "com.apple.garageband10",
    category: "creative-music-entry", regions: ["GLOBAL"],
    signals: [weak("music-curious"), weak("default-app")], scanStrategy: PRESENCE },
  { id: "final-cut-pro", name: "Final Cut Pro", bundleId: "com.apple.FinalCut",
    category: "creative-video-pro", regions: ["GLOBAL"],
    signals: [strong("apple-native-video-editor"), sig("creator-economy-participant")], scanStrategy: PRESENCE },
  { id: "davinci-resolve", name: "DaVinci Resolve",
    category: "creative-video-pro", regions: ["GLOBAL"],
    signals: [strong("serious-video-editor"), sig("color-grading-interest")], scanStrategy: PRESENCE },
  { id: "capcut", name: "CapCut",
    category: "creative-video-casual", regions: ["CN", "GLOBAL"],
    signals: [sig("social-video-creator"), sig("bytedance-ecosystem-tangent")], scanStrategy: PRESENCE },
  { id: "descript", name: "Descript", category: "creative-audio-podcast", regions: ["US"],
    signals: [strong("podcast-or-content-creator"), sig("ai-native-editor")], scanStrategy: PRESENCE },
  { id: "obs", name: "OBS", aliases: ["OBS Studio"],
    category: "creative-video-stream", regions: ["GLOBAL"],
    signals: [strong("streamer-or-recorder"), sig("twitch-or-youtube-pipeline")], scanStrategy: PRESENCE },
  { id: "scrivener", name: "Scrivener", category: "creative-writing-pro", regions: ["GLOBAL"],
    signals: [strong("longform-writer"), sig("novelist-or-academic")], scanStrategy: PRESENCE },
  { id: "ulysses", name: "Ulysses", category: "creative-writing-pro", regions: ["EU"],
    signals: [sig("markdown-writer"), sig("apple-aesthetic-premium")], scanStrategy: PRESENCE },

  // ═══════════ AI ═══════════

  { id: "claude-app", name: "Claude", aliases: ["Claude.app"],
    bundleId: "com.anthropic.claudefordesktop",
    category: "ai-chat-assistant", regions: ["US", "GLOBAL"],
    signals: [strong("ai-native-power-user"), sig("anthropic-preference"), sig("2024-2025-wave")],
    scanStrategy: PRESENCE, launchedYear: 2024 },
  { id: "chatgpt", name: "ChatGPT", aliases: ["ChatGPT.app"],
    category: "ai-chat-assistant", regions: ["US", "GLOBAL"],
    signals: [sig("ai-mainstream-user")], scanStrategy: PRESENCE },
  { id: "chatgpt-atlas", name: "ChatGPT Atlas",
    category: "ai-chat-assistant", regions: ["US"],
    signals: [strong("openai-power-user"), strong("early-adopter-2025"), sig("agent-browser-curious")],
    scanStrategy: PRESENCE, launchedYear: 2025 },
  { id: "perplexity", name: "Perplexity", category: "ai-chat-assistant", regions: ["US"],
    signals: [sig("research-heavy-user"), sig("search-replacement-seeker")], scanStrategy: PRESENCE },
  { id: "gemini", name: "Gemini", category: "ai-chat-assistant", regions: ["US", "GLOBAL"],
    signals: [sig("google-ecosystem")], scanStrategy: PRESENCE },
  { id: "grok", name: "Grok", category: "ai-chat-assistant", regions: ["US"],
    signals: [sig("x-ecosystem"), sig("edgy-ai-preference")], scanStrategy: PRESENCE },
  { id: "ollama", name: "Ollama", category: "ai-local-llm", regions: ["GLOBAL"],
    signals: [strong("local-llm-power-user"), strong("privacy-or-hacker-mindset")], scanStrategy: PRESENCE },
  { id: "lm-studio", name: "LM Studio", category: "ai-local-llm", regions: ["GLOBAL"],
    signals: [strong("local-llm-hobbyist")], scanStrategy: PRESENCE },
  { id: "manus", name: "Manus", category: "ai-agent-platform", regions: ["GLOBAL", "CN"],
    signals: [strong("agent-platform-curious"), strong("2025-wave")], scanStrategy: PRESENCE, launchedYear: 2025 },
  { id: "openclaw", name: "OpenClaw", category: "ai-agent-platform", regions: ["GLOBAL"],
    signals: [strong("agent-builder"), strong("2026-wave")], scanStrategy: PRESENCE, launchedYear: 2025 },
  { id: "draw-things", name: "Draw Things", category: "ai-image-generation", regions: ["GLOBAL"],
    signals: [sig("local-stable-diffusion-user")], scanStrategy: PRESENCE },

  // ═══════════ FINANCE ═══════════

  { id: "robinhood", name: "Robinhood", category: "finance-trading-us", regions: ["US"],
    signals: [sig("retail-trader-us"), sig("gamified-investing")], scanStrategy: PRESENCE },
  { id: "webull", name: "Webull", category: "finance-trading-us", regions: ["US", "CN"],
    signals: [sig("chinese-origin-retail-broker")], scanStrategy: PRESENCE },
  { id: "futu", name: "Futu", aliases: ["富途", "富途牛牛"],
    category: "finance-trading-cn", regions: ["CN", "HK"],
    signals: [strong("chinese-investor-us-market-focus"), sig("hong-kong-or-mainland-hk-bridge")],
    scanStrategy: PRESENCE },
  { id: "tiger-brokers", name: "Tiger Brokers", aliases: ["老虎证券"],
    category: "finance-trading-cn", regions: ["CN", "SEA"],
    signals: [sig("chinese-investor-global")], scanStrategy: PRESENCE },
  { id: "tradingview", name: "TradingView", category: "finance-trading-us", regions: ["GLOBAL"],
    signals: [strong("active-trader"), sig("chart-analysis-heavy")], scanStrategy: PRESENCE },
  { id: "thinkorswim", name: "thinkorswim", category: "finance-trading-pro", regions: ["US"],
    signals: [strong("options-trader"), sig("serious-retail")], scanStrategy: PRESENCE },
  { id: "phantom", name: "Phantom", category: "finance-crypto-wallet", regions: ["GLOBAL"],
    signals: [strong("solana-ecosystem"), sig("crypto-native")], scanStrategy: PRESENCE },
  { id: "metamask", name: "MetaMask", category: "finance-crypto-wallet", regions: ["GLOBAL"],
    signals: [strong("eth-ecosystem"), sig("defi-participant")], scanStrategy: PRESENCE },
  { id: "ledger-live", name: "Ledger Live", category: "finance-crypto-wallet", regions: ["GLOBAL"],
    signals: [strong("crypto-hardware-wallet"), sig("security-conscious-crypto")], scanStrategy: PRESENCE },
  { id: "coinbase", name: "Coinbase", category: "finance-crypto-exchange", regions: ["US"],
    signals: [sig("crypto-mainstream-us")], scanStrategy: PRESENCE },
  { id: "binance", name: "Binance", category: "finance-crypto-exchange", regions: ["GLOBAL"],
    signals: [strong("crypto-active-trader")], scanStrategy: PRESENCE },
  { id: "copilot-money", name: "Copilot", aliases: ["Copilot Money"],
    category: "finance-personal-budget", regions: ["US"],
    signals: [strong("personal-finance-serious"), sig("apple-ecosystem-premium")], scanStrategy: PRESENCE },
  { id: "ynab", name: "YNAB", category: "finance-personal-budget", regions: ["US"],
    signals: [strong("budget-methodology-follower")], scanStrategy: PRESENCE },
  { id: "wise", name: "Wise", aliases: ["TransferWise"],
    category: "finance-banking-neobank", regions: ["GLOBAL", "EU"],
    signals: [strong("international-remittance"), sig("bi-country-living")], scanStrategy: PRESENCE },
  { id: "revolut", name: "Revolut", category: "finance-banking-neobank", regions: ["EU"],
    signals: [sig("european-neobank-user"), sig("crypto-adjacent")], scanStrategy: PRESENCE },
  { id: "alipay", name: "Alipay", aliases: ["支付宝"],
    category: "finance-payment-cn", regions: ["CN"],
    signals: [strong("chinese-lifestyle-ecosystem"), strong("cashless-mainland")], scanStrategy: PRESENCE,
    platforms: ["ios", "android"] },

  // ═══════════ CN SHOPPING/LIFESTYLE ═══════════

  { id: "taobao", name: "Taobao", aliases: ["淘宝"],
    category: "shopping-cn-general", regions: ["CN"],
    signals: [strong("chinese-mainland-shopping")], scanStrategy: PRESENCE, platforms: ["ios", "android"] },
  { id: "tmall", name: "Tmall", aliases: ["天猫"],
    category: "shopping-cn-general", regions: ["CN"],
    signals: [strong("chinese-mainland-premium-shopper")], scanStrategy: PRESENCE },
  { id: "meituan", name: "Meituan", aliases: ["美团"],
    category: "shopping-food-delivery", regions: ["CN"],
    signals: [strong("chinese-mainland-lifestyle"), sig("urban-resident-cn")], scanStrategy: PRESENCE },
  { id: "didi", name: "DiDi", aliases: ["滴滴出行"],
    category: "cn-ride-hail", regions: ["CN"],
    signals: [strong("chinese-mainland-commuter")], scanStrategy: PRESENCE },

  // ═══════════ ENTERTAINMENT ═══════════

  { id: "spotify", name: "Spotify", bundleId: "com.spotify.client",
    category: "entertainment-music-stream-west", regions: ["US", "EU", "GLOBAL"],
    signals: [strong("western-music-consumer"), sig("non-cn-primary")], scanStrategy: PRESENCE },
  { id: "apple-music", name: "Music", aliases: ["Apple Music"], bundleId: "com.apple.Music",
    category: "entertainment-music-stream-west", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")], scanStrategy: PRESENCE },
  { id: "netease-music", name: "NetEase Cloud Music", aliases: ["网易云音乐", "网易云"],
    category: "entertainment-music-stream-cn", regions: ["CN"],
    signals: [strong("chinese-music-consumer"), sig("music-reviewer-culture")], scanStrategy: PRESENCE },
  { id: "qq-music", name: "QQ Music", aliases: ["QQ音乐"],
    category: "entertainment-music-stream-cn", regions: ["CN"],
    signals: [strong("chinese-music-consumer"), sig("tencent-ecosystem")], scanStrategy: PRESENCE },
  { id: "netflix", name: "Netflix",
    category: "entertainment-video-west", regions: ["US", "GLOBAL"],
    signals: [sig("western-video-consumer")], scanStrategy: PRESENCE },
  { id: "steam", name: "Steam", bundleId: "com.valvesoftware.steam",
    category: "entertainment-gaming-launcher", regions: ["GLOBAL"],
    signals: [strong("pc-gamer")], scanStrategy: PRESENCE },
  { id: "poker-stars", name: "PokerStars",
    category: "entertainment-gambling", regions: ["GLOBAL"],
    signals: [strong("poker-player-serious")], scanStrategy: PRESENCE },
  { id: "ggpoker", name: "GGPoker",
    category: "entertainment-gambling", regions: ["GLOBAL"],
    signals: [strong("poker-player-online")], scanStrategy: PRESENCE },

  // ═══════════ BROWSERS ═══════════

  { id: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome",
    category: "browser-mainstream", regions: ["GLOBAL"],
    signals: [sig("mainstream-internet-user")],
    scanStrategy: { canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Application Support/Google/Chrome/Default/History",
      notes: "SQLite DB readable after copy (file is locked while Chrome runs)." } },
  { id: "safari", name: "Safari", bundleId: "com.apple.Safari",
    category: "browser-mainstream", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")],
    scanStrategy: { canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Safari/History.db", permission: "fdda",
      notes: "Requires Full Disk Access on modern macOS." } },
  { id: "arc", name: "Arc", bundleId: "company.thebrowser.Browser",
    category: "browser-power-user", regions: ["US", "GLOBAL"],
    signals: [strong("browser-power-user"), sig("early-adopter-2023"), sig("design-conscious")],
    scanStrategy: { canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Application Support/Arc/User Data/Default/History",
      notes: "Chromium base — same format as Chrome." } },
  { id: "dia", name: "Dia",
    category: "browser-power-user", regions: ["US"],
    signals: [strong("ai-native-browser-user"), strong("early-adopter-2025")],
    scanStrategy: PRESENCE, launchedYear: 2025 },
  { id: "brave", name: "Brave", bundleId: "com.brave.Browser",
    category: "browser-privacy", regions: ["GLOBAL"],
    signals: [strong("privacy-conscious-browser"), sig("crypto-curious")],
    scanStrategy: { canReadContent: true, method: "sqlite-direct",
      path: "~/Library/Application Support/BraveSoftware/Brave-Browser/Default/History" } },
  { id: "firefox", name: "Firefox", bundleId: "org.mozilla.firefox",
    category: "browser-mainstream", regions: ["GLOBAL"],
    signals: [sig("anti-google-bias"), sig("oss-preference")], scanStrategy: PRESENCE },
  { id: "zen-browser", name: "Zen Browser",
    category: "browser-power-user", regions: ["GLOBAL"],
    signals: [sig("firefox-based-power-user"), sig("2024-wave")], scanStrategy: PRESENCE, launchedYear: 2024 },

  // ═══════════ PRODUCTIVITY UTILITIES ═══════════

  { id: "raycast", name: "Raycast", bundleId: "com.raycast.macos",
    category: "productivity-launcher", regions: ["GLOBAL"],
    signals: [strong("power-user-launcher"), strong("2021+-wave"), sig("extension-ecosystem-user")],
    scanStrategy: FS_CONFIG },
  { id: "alfred", name: "Alfred", category: "productivity-launcher", regions: ["GLOBAL"],
    signals: [sig("mature-mac-power-user"), weak("pre-raycast-era")], scanStrategy: FS_CONFIG },
  { id: "rectangle", name: "Rectangle", category: "productivity-window-mgr", regions: ["GLOBAL"],
    signals: [sig("oss-preference"), sig("window-mgmt-user")], scanStrategy: PRESENCE },
  { id: "better-touch-tool", name: "BetterTouchTool", category: "productivity-window-mgr", regions: ["GLOBAL"],
    signals: [strong("mac-automation-power-user"), strong("shortcut-obsessive")], scanStrategy: PRESENCE },
  { id: "hazel", name: "Hazel", category: "productivity-automation", regions: ["GLOBAL"],
    signals: [strong("file-automation-power-user")], scanStrategy: PRESENCE },
  { id: "keyboard-maestro", name: "Keyboard Maestro", category: "productivity-automation", regions: ["US"],
    signals: [strong("mac-power-user-automator")], scanStrategy: PRESENCE },
  { id: "shortcuts", name: "Shortcuts", bundleId: "com.apple.shortcuts",
    category: "productivity-automation", regions: ["GLOBAL"],
    signals: [strong("apple-automation-native")],
    scanStrategy: { canReadContent: true, method: "applescript",
      notes: "Can enumerate user's Shortcuts, which themselves are signals." } },

  // ═══════════ INFRASTRUCTURE ═══════════

  { id: "1password", name: "1Password", category: "password-manager", regions: ["GLOBAL"],
    signals: [sig("security-hygiene")], scanStrategy: PRESENCE },
  { id: "bitwarden", name: "Bitwarden", category: "password-manager", regions: ["GLOBAL"],
    signals: [sig("oss-preference"), sig("security-hygiene")], scanStrategy: PRESENCE },
  { id: "tailscale", name: "Tailscale", category: "vpn", regions: ["GLOBAL"],
    signals: [strong("technical-vpn-user"), sig("home-lab-or-multi-machine-dev")], scanStrategy: PRESENCE },
  { id: "wireguard", name: "WireGuard", category: "vpn", regions: ["GLOBAL"],
    signals: [sig("technical-vpn-setup")], scanStrategy: PRESENCE },
  { id: "dropbox", name: "Dropbox", category: "backup-cloud-sync", regions: ["GLOBAL"],
    signals: [sig("cross-platform-file-sync")], scanStrategy: PRESENCE },
  { id: "google-drive", name: "Google Drive", category: "backup-cloud-sync", regions: ["GLOBAL"],
    signals: [sig("google-ecosystem")], scanStrategy: PRESENCE },

  // ═══════════ READING ═══════════

  { id: "kindle", name: "Kindle", category: "reading-longform", regions: ["GLOBAL"],
    signals: [sig("book-reader"), sig("amazon-ecosystem")], scanStrategy: PRESENCE },
  { id: "apple-books", name: "Books", aliases: ["Apple Books"], bundleId: "com.apple.iBooksX",
    category: "reading-longform", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native"), weak("reading-default")], scanStrategy: PRESENCE },
  { id: "readwise", name: "Readwise", category: "reading-longform", regions: ["US"],
    signals: [strong("active-knowledge-worker"), sig("spaced-repetition-believer")], scanStrategy: PRESENCE },
  { id: "reeder", name: "Reeder", category: "reading-news-rss", regions: ["GLOBAL"],
    signals: [sig("rss-survivor"), sig("news-aggregation-believer")], scanStrategy: PRESENCE },

  // ═══════════ HEALTH ═══════════

  { id: "strava", name: "Strava", category: "health-fitness", regions: ["US", "GLOBAL"],
    signals: [strong("endurance-sports")], scanStrategy: PRESENCE },
  { id: "headspace", name: "Headspace", category: "health-meditation", regions: ["US"],
    signals: [sig("meditation-habit")], scanStrategy: PRESENCE },
  { id: "calm", name: "Calm", category: "health-meditation", regions: ["US"],
    signals: [sig("meditation-habit-or-sleep-aid")], scanStrategy: PRESENCE },
  { id: "macrofactor", name: "MacroFactor", category: "health-nutrition", regions: ["US"],
    signals: [strong("quantified-self-nutrition")], scanStrategy: PRESENCE },

  // ═══════════ OFFICE ═══════════

  { id: "apple-pages", name: "Pages", bundleId: "com.apple.iWork.Pages",
    category: "productivity-office-apple", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")], scanStrategy: PRESENCE },
  { id: "apple-numbers", name: "Numbers", bundleId: "com.apple.iWork.Numbers",
    category: "productivity-office-apple", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")], scanStrategy: PRESENCE },
  // ═══════════ APPS DISCOVERED VIA REAL SCAN ═══════════

  { id: "djay-pro", name: "djay Pro", aliases: ["djay"],
    category: "creative-music-dj", regions: ["GLOBAL"],
    signals: [strong("dj-practitioner"), sig("apple-ecosystem-dj"), weak("beginner-to-intermediate-dj")],
    scanStrategy: PRESENCE },
  { id: "imovie", name: "iMovie", bundleId: "com.apple.iMovieApp",
    category: "creative-video-casual", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native"), weak("casual-video-editor")],
    scanStrategy: PRESENCE },
  { id: "splice", name: "Splice", category: "creative-music-daw", regions: ["GLOBAL"],
    signals: [strong("music-producer-sample-library"), sig("electronic-music-creator")],
    scanStrategy: PRESENCE },
  { id: "grammarly", name: "Grammarly Desktop", aliases: ["Grammarly"],
    category: "productivity-text-expansion", regions: ["US", "GLOBAL"],
    signals: [sig("writing-conscious"), sig("non-native-english-or-polished-writer")],
    scanStrategy: PRESENCE },
  { id: "granola", name: "Granola",
    category: "ai-voice-transcription", regions: ["US"],
    signals: [strong("ai-native-meeting-note-taker"), strong("early-adopter-2024"), sig("product-tech-role")],
    scanStrategy: PRESENCE, launchedYear: 2024 },
  { id: "hammerspoon", name: "Hammerspoon",
    category: "productivity-automation", regions: ["GLOBAL"],
    signals: [strong("extreme-mac-power-user"), strong("lua-scripter"), strong("custom-workflow-obsessive")],
    scanStrategy: FS_CONFIG },
  { id: "tor-browser", name: "Tor Browser",
    category: "browser-privacy", regions: ["GLOBAL"],
    signals: [strong("privacy-extreme"), sig("censorship-circumvention"), sig("technical-security-user")],
    scanStrategy: PRESENCE },
  { id: "wireshark", name: "Wireshark",
    category: "dev-api-tester", // network diagnostic
    regions: ["GLOBAL"],
    signals: [strong("network-engineer-or-security-dev"), sig("infra-debugging-capability")],
    scanStrategy: PRESENCE },
  { id: "trae", name: "Trae", aliases: ["TRAE SOLO", "TRAE"],
    category: "dev-editor-ai", regions: ["CN", "GLOBAL"],
    signals: [strong("bytedance-ecosystem"), strong("chinese-ai-tool-user"), strong("multi-coding-assistant-user"), sig("2025-wave")],
    scanStrategy: PRESENCE, launchedYear: 2024 },
  { id: "codex-cli", name: "Codex", aliases: ["Codex CLI"],
    category: "ai-code-assistant", regions: ["US"],
    signals: [strong("openai-ecosystem"), strong("ai-native-developer-multi-tool"), sig("2025-wave")],
    scanStrategy: PRESENCE, launchedYear: 2025 },
  { id: "littlebird", name: "Littlebird",
    category: "ai-agent-platform", regions: ["US"],
    signals: [strong("ai-assistant-curious"), strong("competitive-intelligence-or-user"), sig("2026-wave")],
    scanStrategy: PRESENCE, launchedYear: 2026 },
  { id: "cluely", name: "Cluely",
    category: "ai-chat-assistant", regions: ["US"],
    signals: [sig("ai-native-gen-z"), weak("interview-or-screen-assist-user"), sig("2024-wave")],
    scanStrategy: PRESENCE },
  { id: "youdao-translate", name: "NetEase Youdao", aliases: ["网易有道翻译", "有道翻译"],
    category: "productivity-office-apple", // translation utility; no perfect fit
    regions: ["CN"],
    signals: [strong("chinese-cultural-context"), sig("bilingual-workflow"), sig("netease-ecosystem")],
    scanStrategy: PRESENCE },
  { id: "transocks", name: "Transocks",
    category: "vpn", regions: ["CN"],
    signals: [strong("china-vpn-user"), sig("cross-gfw-workflow")],
    scanStrategy: PRESENCE },

  { id: "apple-keynote", name: "Keynote", bundleId: "com.apple.iWork.Keynote",
    category: "productivity-office-apple", regions: ["GLOBAL"],
    signals: [strong("apple-ecosystem-native")], scanStrategy: PRESENCE },
  { id: "ms-word", name: "Microsoft Word", category: "productivity-office-ms", regions: ["GLOBAL"],
    signals: [sig("microsoft-ecosystem-or-work-mandate")], scanStrategy: PRESENCE },
  { id: "ms-excel", name: "Microsoft Excel", category: "productivity-office-ms", regions: ["GLOBAL"],
    signals: [sig("excel-worker"), weak("finance-or-ops-adjacent")], scanStrategy: PRESENCE },
];

// ── Lookup helpers ────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/\.app$/i, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

const _lookupIndex: Map<string, AppProfile> = (() => {
  const m = new Map<string, AppProfile>();
  for (const app of APP_REGISTRY) {
    m.set(normalize(app.id), app);
    m.set(normalize(app.name), app);
    for (const a of app.aliases ?? []) m.set(normalize(a), app);
    if (app.bundleId) m.set(normalize(app.bundleId), app);
  }
  return m;
})();

/** Look up app by any name form (display name, alias, bundle id, .app filename). */
export function findApp(name: string): AppProfile | null {
  if (!name) return null;
  const n = normalize(name);
  return _lookupIndex.get(n) ?? null;
}

export function getAppsByCategory(cat: AppCategory): AppProfile[] {
  return APP_REGISTRY.filter(a => a.category === cat || (a.subcategories?.includes(cat) ?? false));
}

export function getAppsByRegion(region: AppRegion): AppProfile[] {
  return APP_REGISTRY.filter(a => a.regions.includes(region));
}

/**
 * Match every installed app name against the registry. Returns matched entries
 * plus a list of unknowns that should be sent for LLM classification later.
 */
export function classifyInstalledApps(installedAppFilenames: string[]): {
  matched: { source: string; app: AppProfile }[];
  unknown: string[];
} {
  const matched: { source: string; app: AppProfile }[] = [];
  const unknown: string[] = [];
  for (const raw of installedAppFilenames) {
    const clean = raw.replace(/\.app$/i, "").trim();
    const app = findApp(clean);
    if (app) matched.push({ source: raw, app });
    else if (clean && clean.length > 1) unknown.push(clean);
  }
  return { matched, unknown };
}

/**
 * Aggregate signals across matched apps. Combines signal strengths; a signal
 * appearing as "strong" from 2 apps wins over "weak" from 5 apps, etc.
 */
export function aggregateSignals(matched: { app: AppProfile }[]): {
  signal: string;
  score: number;
  sources: string[];
}[] {
  const tally = new Map<string, { score: number; sources: string[] }>();
  const weight = { weak: 1, medium: 3, strong: 7 } as const;
  for (const { app } of matched) {
    for (const s of app.signals) {
      const entry = tally.get(s.name) ?? { score: 0, sources: [] };
      entry.score += weight[s.strength];
      entry.sources.push(app.id);
      tally.set(s.name, entry);
    }
  }
  return Array.from(tally.entries())
    .map(([signal, v]) => ({ signal, score: v.score, sources: v.sources }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Region affinity: for each region, sum signals from apps that target that
 * region. Use max-normalized for "user is primarily X region" confidence.
 */
export function inferRegionAffinity(matched: { app: AppProfile }[]): {
  region: AppRegion;
  score: number;
  apps: string[];
}[] {
  const tally = new Map<AppRegion, { score: number; apps: string[] }>();
  const weight = { weak: 1, medium: 3, strong: 7 } as const;
  for (const { app } of matched) {
    // GLOBAL apps weight less for region-specific inference
    const specificRegions = app.regions.filter(r => r !== "GLOBAL");
    for (const r of specificRegions) {
      const entry = tally.get(r) ?? { score: 0, apps: [] };
      // region score = sum of signal strengths of this app (proxy for usage importance)
      const appWeight = app.signals.reduce((s, sig) => s + weight[sig.strength], 0);
      entry.score += appWeight;
      entry.apps.push(app.id);
      tally.set(r, entry);
    }
  }
  return Array.from(tally.entries())
    .map(([region, v]) => ({ region, score: v.score, apps: v.apps }))
    .sort((a, b) => b.score - a.score);
}

/** What data CAN we actually read from the installed apps? */
export function scanCapabilityReport(matched: { app: AppProfile }[]): {
  readableContent: AppProfile[];
  accessibilityOnly: AppProfile[];
  presenceOnly: AppProfile[];
  needsPermission: { app: AppProfile; permission: string }[];
} {
  const readableContent: AppProfile[] = [];
  const accessibilityOnly: AppProfile[] = [];
  const presenceOnly: AppProfile[] = [];
  const needsPermission: { app: AppProfile; permission: string }[] = [];
  for (const { app } of matched) {
    const s = app.scanStrategy;
    if (s.canReadContent) readableContent.push(app);
    else if (s.method === "accessibility-only") accessibilityOnly.push(app);
    else if (s.method === "presence-only") presenceOnly.push(app);
    if (s.permission && s.permission !== "none") {
      needsPermission.push({ app, permission: s.permission });
    }
  }
  return { readableContent, accessibilityOnly, presenceOnly, needsPermission };
}

/** Convenience: registry size for debugging. */
export function registrySize(): { total: number; byRegion: Record<string, number>; byCategoryPrefix: Record<string, number> } {
  const byRegion: Record<string, number> = {};
  const byCategoryPrefix: Record<string, number> = {};
  for (const a of APP_REGISTRY) {
    for (const r of a.regions) byRegion[r] = (byRegion[r] ?? 0) + 1;
    const prefix = a.category.split("-")[0];
    byCategoryPrefix[prefix] = (byCategoryPrefix[prefix] ?? 0) + 1;
  }
  return { total: APP_REGISTRY.length, byRegion, byCategoryPrefix };
}
