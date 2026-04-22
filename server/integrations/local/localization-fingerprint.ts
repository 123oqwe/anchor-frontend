/**
 * Localization Fingerprint — 5 cheap signals, 0 permissions, huge payoff.
 *
 * Every macOS user has a `defaults` database with settings the OS uses for
 * display (language, date format, keyboard). These are not sensitive — anyone
 * running code under the user's account can read them. But they encode
 * cultural context VERY precisely:
 *
 *   - AppleLanguages           → primary + fallback languages (ordered)
 *   - AppleLocale              → region-scoped locale (e.g. zh_CN, zh_TW, en_US)
 *   - AppleEnabledInputSources → every keyboard / IME the user set up
 *   - System timezone          → where the Mac thinks it is
 *   - Measurement + temp units → metric vs imperial, °C vs °F
 *
 * Combining these catches nuances that the app registry alone misses:
 *
 *   - User has WeChat + Alipay + Taobao but system language = English, TZ = LA,
 *     no Pinyin IME → "Chinese-descent but culturally Western" (2nd gen, or
 *     moved young)
 *
 *   - User has only Western apps but Traditional Chinese + Cangjie IME + TZ HK
 *     → "HK power user working in English stack"
 *
 *   - User has both Pinyin + Cangjie + Japanese IMEs → translator / language
 *     learner / multi-cultural worker
 *
 * These signals are the OS-level TRUTH vs the app-level INFERENCE, and they
 * cross-validate (or contradict) each other — which itself is a signal.
 */
import { execSync } from "child_process";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InputMethod {
  identifier: string;       // e.g. "com.apple.inputmethod.SCIM.ITABC"
  friendlyName: string;     // e.g. "Pinyin - Simplified"
  script: InputScript;
  region: InputRegion;
}

export type InputScript =
  | "latin"
  | "han-simplified"        // simplified Chinese (mainland)
  | "han-traditional"       // traditional Chinese (TW/HK)
  | "kana"                  // Japanese hiragana/katakana
  | "hangul"                // Korean
  | "cyrillic"
  | "arabic"
  | "other";

export type InputRegion =
  | "CN" | "TW" | "HK" | "JP" | "KR"
  | "US" | "UK" | "EU" | "RU" | "AR" | "OTHER";

export interface LocFingerprintSignal {
  name: string;
  strength: "weak" | "medium" | "strong";
  evidence: string;
}

export interface LocalizationFingerprint {
  primaryLanguage: string;              // e.g. "zh-Hans-CN" or "en-US"
  languageChain: string[];              // full ordered list from AppleLanguages
  locale: string;                       // e.g. "zh_CN@rg=uszzzz"
  inferredRegion: "CN" | "TW" | "HK" | "JP" | "KR" | "US" | "EU" | "OTHER";
  inputMethods: InputMethod[];
  timezone: string;                     // e.g. "America/New_York"
  measurementSystem: "metric" | "imperial" | "unknown";
  temperatureUnit: "C" | "F" | "unknown";
  firstWeekday: number | null;          // 1=Sunday, 2=Monday ... macOS convention
  signals: LocFingerprintSignal[];
  contradictions: string[];             // cross-field tensions (e.g. "lang zh but tz US")
}

// ── defaults readers ───────────────────────────────────────────────────────

function readDefault(domain: string, key: string): string | null {
  try {
    const cmd = domain === "-g" ? `defaults read -g ${key} 2>/dev/null` : `defaults read ${domain} ${key} 2>/dev/null`;
    return execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

function readArrayOfStrings(raw: string | null): string[] {
  if (!raw) return [];
  // defaults output for an array looks like:
  // (
  //     "zh-Hans-CN",
  //     "en-US"
  // )
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "").trim();
  if (!inner) return [];
  return inner.split(",")
    .map(s => s.trim().replace(/^"/, "").replace(/",?$/, "").replace(/"$/, ""))
    .filter(Boolean);
}

// ── Input method classifier ────────────────────────────────────────────────

/**
 * Map input-method identifiers to friendly name + script + region.
 * Covers ~50 of the most common IMEs across CN/TW/HK/JP/KR/US/EU.
 */
function classifyInputMethod(id: string): Omit<InputMethod, "identifier"> {
  // Chinese — Simplified (mainland)
  if (id.includes("SCIM.ITABC"))            return { friendlyName: "Pinyin — Simplified",        script: "han-simplified",  region: "CN" };
  if (id.includes("SCIM.Shuangpin"))        return { friendlyName: "Shuangpin — Simplified",     script: "han-simplified",  region: "CN" };
  if (id.includes("SCIM.WBX"))              return { friendlyName: "Wubi Xing — Simplified",     script: "han-simplified",  region: "CN" };
  if (id.includes("Sogou"))                 return { friendlyName: "Sogou Pinyin (3rd-party)",   script: "han-simplified",  region: "CN" };
  if (id.includes("Baidu"))                 return { friendlyName: "Baidu Input (3rd-party)",    script: "han-simplified",  region: "CN" };
  if (id.includes("RIME"))                  return { friendlyName: "RIME (custom IME)",          script: "han-simplified",  region: "CN" };
  if (id.includes("QQ"))                    return { friendlyName: "QQ Pinyin (3rd-party)",      script: "han-simplified",  region: "CN" };

  // Chinese — Traditional (TW / HK)
  if (id.includes("TCIM.Cangjie"))          return { friendlyName: "Cangjie — Traditional",      script: "han-traditional", region: "TW" };
  if (id.includes("TCIM.Zhuyin"))           return { friendlyName: "Zhuyin Bopomofo — TW",       script: "han-traditional", region: "TW" };
  if (id.includes("TCIM.Jianyi"))           return { friendlyName: "Jianyi — Traditional",       script: "han-traditional", region: "TW" };
  if (id.includes("TCIM.Pinyin"))           return { friendlyName: "Pinyin — Traditional",       script: "han-traditional", region: "TW" };
  if (id.includes("TCIM.Sucheng"))          return { friendlyName: "Sucheng — Traditional",      script: "han-traditional", region: "TW" };
  if (id.includes("TCIM.TonePinyin"))       return { friendlyName: "Pinyin (Traditional, tone)", script: "han-traditional", region: "TW" };
  if (id.includes(".Cantonese"))            return { friendlyName: "Cantonese Jyutping — HK",    script: "han-traditional", region: "HK" };

  // Japanese
  if (id.includes("Japanese.Roman"))        return { friendlyName: "Japanese — Romaji",          script: "kana",            region: "JP" };
  if (id.includes("Japanese.Hiragana"))     return { friendlyName: "Japanese — Hiragana",        script: "kana",            region: "JP" };
  if (id.includes("Japanese.Katakana"))     return { friendlyName: "Japanese — Katakana",        script: "kana",            region: "JP" };
  if (id.includes("Japanese"))              return { friendlyName: "Japanese IME",               script: "kana",            region: "JP" };

  // Korean
  if (id.includes("Korean.2Set"))           return { friendlyName: "Korean — 2-Set",             script: "hangul",          region: "KR" };
  if (id.includes("Korean.3Set"))           return { friendlyName: "Korean — 3-Set",             script: "hangul",          region: "KR" };
  if (id.includes("Korean"))                return { friendlyName: "Korean IME",                 script: "hangul",          region: "KR" };

  // Latin — English variants
  if (id.includes("keylayout.US") || id.endsWith(".ABC"))
                                            return { friendlyName: "ABC (US English)",           script: "latin",           region: "US" };
  if (id.includes("keylayout.British"))     return { friendlyName: "British English",            script: "latin",           region: "UK" };
  if (id.includes("keylayout.Dvorak"))      return { friendlyName: "Dvorak",                     script: "latin",           region: "US" };
  if (id.includes("keylayout.Colemak"))     return { friendlyName: "Colemak",                    script: "latin",           region: "US" };

  // European
  if (id.includes("keylayout.German"))      return { friendlyName: "German",                     script: "latin",           region: "EU" };
  if (id.includes("keylayout.French"))      return { friendlyName: "French",                     script: "latin",           region: "EU" };
  if (id.includes("keylayout.Spanish"))     return { friendlyName: "Spanish",                    script: "latin",           region: "EU" };
  if (id.includes("keylayout.Italian"))     return { friendlyName: "Italian",                    script: "latin",           region: "EU" };

  // Russian / Arabic
  if (id.includes("keylayout.Russian"))     return { friendlyName: "Russian",                    script: "cyrillic",        region: "RU" };
  if (id.includes("Arabic") || id.includes("keylayout.Arabic"))
                                            return { friendlyName: "Arabic",                     script: "arabic",          region: "AR" };

  return { friendlyName: id.split(".").pop() ?? id, script: "other", region: "OTHER" };
}

/** Parse AppleEnabledInputSources (a plist array) into normalized list. */
function parseInputMethods(raw: string | null): InputMethod[] {
  if (!raw) return [];
  // raw output is a multi-line plist; InputSourceKind entries look like:
  //     InputSourceKind = "Keyboard Layout";
  //     "KeyboardLayout ID" = -1;
  //     "KeyboardLayout Name" = ABC;
  // and IME entries:
  //     "Bundle ID" = "com.apple.inputmethod.SCIM";
  //     InputSourceKind = "Input Mode";
  //     "Input Mode" = "com.apple.inputmethod.SCIM.ITABC";
  const ids = new Set<string>();

  // Extract from "Input Mode" = "com.apple...";
  const modeMatches = Array.from(raw.matchAll(/"Input Mode"\s*=\s*"([^"]+)"/g));
  for (const m of modeMatches) ids.add(m[1]);

  // Extract from "KeyboardLayout Name" = ABC; (unquoted)
  const klMatches = Array.from(raw.matchAll(/"KeyboardLayout Name"\s*=\s*([A-Za-z0-9_-]+)/g));
  for (const m of klMatches) ids.add("com.apple.keylayout." + m[1]);

  // Also try "Bundle ID" for IMEs without Input Mode specifics
  const bundleMatches = Array.from(raw.matchAll(/"Bundle ID"\s*=\s*"([^"]+)"/g));
  for (const m of bundleMatches) ids.add(m[1]);

  return Array.from(ids).map((identifier) => ({
    identifier,
    ...classifyInputMethod(identifier),
  }));
}

// ── Timezone, measurement ──────────────────────────────────────────────────

function getTimezone(): string {
  try {
    // ls -l /etc/localtime shows the real tz link; faster than systemsetup
    const raw = execSync("readlink /etc/localtime", { encoding: "utf-8", timeout: 2000 }).trim();
    const m = raw.match(/\/zoneinfo\/(.+)$/);
    return m?.[1] ?? raw;
  } catch {
    try { return execSync("date +%Z", { encoding: "utf-8", timeout: 2000 }).trim(); } catch { return "unknown"; }
  }
}

/** Modern macOS often doesn't write these keys unless user changed defaults,
 *  so fall back to locale inference: only en_US / Liberia / Myanmar use imperial. */
function getMeasurementSystem(locale: string): "metric" | "imperial" | "unknown" {
  const val = readDefault("-g", "AppleMetricUnits");
  if (val === "1") return "metric";
  if (val === "0") return "imperial";
  const unit = readDefault("-g", "AppleMeasurementUnits");
  if (unit?.toLowerCase().includes("centi")) return "metric";
  if (unit?.toLowerCase().includes("inch")) return "imperial";
  // Fallback: locale inference
  const loc = locale.toLowerCase();
  if (loc.startsWith("en_us") || loc.startsWith("en_lr") || loc.startsWith("my_mm")) return "imperial";
  return "metric";
}

function getTemperatureUnit(locale: string): "C" | "F" | "unknown" {
  const val = readDefault("-g", "AppleTemperatureUnit");
  if (val === "Celsius") return "C";
  if (val === "Fahrenheit") return "F";
  // Fallback: US uses F, most others use C
  if (locale.toLowerCase().startsWith("en_us")) return "F";
  return "C";
}

// ── Region inference from primary language ─────────────────────────────────

function inferRegionFromLanguage(lang: string, locale: string): LocalizationFingerprint["inferredRegion"] {
  const l = lang.toLowerCase();
  const loc = locale.toLowerCase();
  if (l.startsWith("zh-hans") || loc.startsWith("zh_cn")) return "CN";
  if (l.startsWith("zh-hant") && loc.includes("tw"))      return "TW";
  if (l.startsWith("zh-hant") && loc.includes("hk"))      return "HK";
  if (l.startsWith("zh-hant"))                            return "TW";  // default for traditional
  if (l.startsWith("ja"))                                 return "JP";
  if (l.startsWith("ko"))                                 return "KR";
  if (l.startsWith("en-us") || loc.startsWith("en_us"))   return "US";
  if (l.startsWith("en-gb") || l.startsWith("en-ie") || l.startsWith("de") || l.startsWith("fr") || l.startsWith("es") || l.startsWith("it")) return "EU";
  return "OTHER";
}

// ── Signal derivation — the juicy part ─────────────────────────────────────

function deriveSignals(fp: Pick<LocalizationFingerprint,
  "primaryLanguage" | "languageChain" | "locale" | "inferredRegion" |
  "inputMethods" | "timezone" | "measurementSystem" | "temperatureUnit"
>): { signals: LocFingerprintSignal[]; contradictions: string[] } {
  const signals: LocFingerprintSignal[] = [];
  const contradictions: string[] = [];
  const push = (name: string, strength: LocFingerprintSignal["strength"], evidence: string) =>
    signals.push({ name, strength, evidence });

  const pl = (fp.primaryLanguage ?? "").toLowerCase();
  const tz = fp.timezone;
  const inCN = tz.startsWith("Asia/Shanghai") || tz.startsWith("Asia/Chongqing") || tz.startsWith("Asia/Harbin");
  const inTW = tz.startsWith("Asia/Taipei");
  const inHK = tz.startsWith("Asia/Hong_Kong");
  const inJP = tz.startsWith("Asia/Tokyo");
  const inKR = tz.startsWith("Asia/Seoul");
  const inUS = tz.startsWith("America/");
  const inEU = tz.startsWith("Europe/");

  // ── Primary cultural orientation ──
  if (pl.startsWith("zh-hans")) push("mainland-chinese-os", "strong", "system language zh-Hans");
  if (pl.startsWith("zh-hant")) push("traditional-chinese-os", "strong", "system language zh-Hant");
  if (pl.startsWith("en-us"))   push("us-english-os", "medium", "system language en-US");
  if (pl.startsWith("en-gb"))   push("uk-english-os", "medium", "system language en-GB");
  if (pl.startsWith("ja"))      push("japanese-os", "strong", "system language ja");
  if (pl.startsWith("ko"))      push("korean-os", "strong", "system language ko");

  // ── IME patterns ──
  const scripts = new Set(fp.inputMethods.map(m => m.script));
  const regions = new Set(fp.inputMethods.map(m => m.region));
  if (scripts.has("han-simplified")) push("mainland-typing-capable", "strong", `IME: ${fp.inputMethods.find(m => m.script === "han-simplified")?.friendlyName}`);
  if (scripts.has("han-traditional")) push("traditional-chinese-typing-capable", "strong", `IME: ${fp.inputMethods.find(m => m.script === "han-traditional")?.friendlyName}`);
  if (scripts.has("kana")) push("japanese-typing-capable", "strong", "Japanese IME configured");
  if (scripts.has("hangul")) push("korean-typing-capable", "strong", "Korean IME configured");

  if (scripts.has("han-simplified") && scripts.has("han-traditional")) {
    push("cn-tw-bilingual-typist", "strong", "Both Simplified and Traditional IMEs enabled");
  }
  if (scripts.has("han-simplified") && scripts.has("latin") && fp.inputMethods.length >= 3) {
    push("bilingual-typist-cn-en", "strong", `${fp.inputMethods.length} input methods inc. Pinyin + Latin`);
  }
  if (scripts.has("kana") && scripts.has("latin")) push("bilingual-typist-jp-en", "medium", "Japanese + Latin IMEs");
  if (scripts.has("hangul") && scripts.has("latin")) push("bilingual-typist-kr-en", "medium", "Korean + Latin IMEs");

  // 3rd-party IME detection
  const thirdParty = fp.inputMethods.filter(m => /Sogou|Baidu|RIME|QQ/.test(m.friendlyName));
  if (thirdParty.length > 0) {
    push("custom-ime-power-user", "medium", `Using 3rd-party IME: ${thirdParty.map(m => m.friendlyName.split(" ")[0]).join(", ")}`);
  }

  // ── Location vs language tensions — the really interesting signals ──
  const chineseLang = pl.startsWith("zh");
  const englishLang = pl.startsWith("en");
  const hasChineseIME = scripts.has("han-simplified") || scripts.has("han-traditional");

  if (chineseLang && inUS) {
    push("chinese-abroad-in-us", "strong", `lang=${fp.primaryLanguage}, tz=${tz}`);
  }
  if (englishLang && inCN && hasChineseIME) {
    push("chinese-in-china-using-english-os", "strong", `lang=en, tz=${tz}, has Chinese IME`);
  }
  if (englishLang && (inCN || inTW || inHK) && !hasChineseIME) {
    push("expat-in-greater-china", "medium", `lang=en, tz=${tz}, no Chinese IME`);
  }
  if (chineseLang && inEU) {
    push("chinese-abroad-in-europe", "strong", `lang=${fp.primaryLanguage}, tz=${tz}`);
  }

  // Language chain reveals fallback preferences
  if (fp.languageChain.length >= 2) {
    const secondary = fp.languageChain[1] ?? "";
    if (pl.startsWith("zh-hans") && secondary.toLowerCase().startsWith("en")) {
      push("cn-first-en-secondary", "medium", `language chain: ${fp.languageChain.slice(0, 3).join(" → ")}`);
    }
    if (pl.startsWith("en") && secondary.toLowerCase().startsWith("zh")) {
      push("en-first-cn-secondary", "medium", `language chain: ${fp.languageChain.slice(0, 3).join(" → ")}`);
    }
  }

  // ── Measurement / temp system ──
  if (fp.measurementSystem === "imperial") push("imperial-units-living", "medium", "AppleMeasurementUnits = inches");
  if (fp.measurementSystem === "metric") push("metric-units-living", "weak", "AppleMeasurementUnits = cm");
  if (fp.temperatureUnit === "F") push("fahrenheit-living", "medium", "Apple temperature = Fahrenheit");

  // ── Timezone as lifestyle signal ──
  const tzSignals: Record<string, { name: string; strength: LocFingerprintSignal["strength"] }> = {
    "Asia/Shanghai": { name: "lives-in-mainland-china", strength: "strong" },
    "Asia/Taipei": { name: "lives-in-taiwan", strength: "strong" },
    "Asia/Hong_Kong": { name: "lives-in-hong-kong", strength: "strong" },
    "Asia/Tokyo": { name: "lives-in-japan", strength: "strong" },
    "Asia/Seoul": { name: "lives-in-korea", strength: "strong" },
    "Asia/Singapore": { name: "lives-in-singapore", strength: "strong" },
    "America/Los_Angeles": { name: "west-coast-us", strength: "medium" },
    "America/New_York": { name: "east-coast-us", strength: "medium" },
    "America/Chicago": { name: "central-us", strength: "medium" },
    "Europe/London": { name: "lives-in-uk", strength: "strong" },
    "Europe/Berlin": { name: "lives-in-germany", strength: "strong" },
    "Europe/Paris": { name: "lives-in-france", strength: "strong" },
  };
  const tzSig = tzSignals[tz];
  if (tzSig) push(tzSig.name, tzSig.strength, `tz=${tz}`);

  // ── Contradictions — when OS settings disagree, flag them ──
  if (chineseLang && fp.measurementSystem === "imperial") {
    contradictions.push("Chinese system language but imperial units — possibly lived in US for a while");
  }
  if (englishLang && inCN && hasChineseIME) {
    contradictions.push("English OS + China timezone + Chinese IME — working internationally from China");
  }
  if (chineseLang && tz.startsWith("America")) {
    contradictions.push("Chinese OS + American timezone — not yet culturally assimilated");
  }

  return { signals, contradictions };
}

// ── Main ───────────────────────────────────────────────────────────────────

export function readLocalizationFingerprint(): LocalizationFingerprint {
  const langRaw = readDefault("-g", "AppleLanguages");
  const languageChain = readArrayOfStrings(langRaw);
  const primaryLanguage = languageChain[0] ?? "en-US";

  const locale = readDefault("-g", "AppleLocale") ?? "en_US";

  const imeRaw = readDefault("com.apple.HIToolbox", "AppleEnabledInputSources");
  const inputMethods = parseInputMethods(imeRaw);

  const timezone = getTimezone();
  const measurementSystem = getMeasurementSystem(locale);
  const temperatureUnit = getTemperatureUnit(locale);

  const firstWeekdayRaw = readDefault("-g", "AppleFirstWeekday");
  const firstWeekday = firstWeekdayRaw
    ? (parseInt((firstWeekdayRaw.match(/gregorian\s*=\s*(\d+)/) ?? ["", ""])[1]) || null)
    : null;

  const inferredRegion = inferRegionFromLanguage(primaryLanguage, locale);

  const { signals, contradictions } = deriveSignals({
    primaryLanguage, languageChain, locale, inferredRegion,
    inputMethods, timezone, measurementSystem, temperatureUnit,
  });

  return {
    primaryLanguage,
    languageChain,
    locale,
    inferredRegion,
    inputMethods,
    timezone,
    measurementSystem,
    temperatureUnit,
    firstWeekday,
    signals,
    contradictions,
  };
}

// ── Render for profile text ────────────────────────────────────────────────

export function localizationToText(fp: LocalizationFingerprint): string {
  const lines: string[] = [];
  lines.push("LOCALIZATION FINGERPRINT (OS-level signals, 0 permissions):");
  lines.push(`  Primary language: ${fp.primaryLanguage}` + (fp.languageChain.length > 1 ? `  chain: ${fp.languageChain.slice(0, 3).join(" → ")}` : ""));
  lines.push(`  Locale: ${fp.locale}`);
  lines.push(`  Inferred region (from lang + locale): ${fp.inferredRegion}`);
  lines.push(`  Timezone: ${fp.timezone}`);
  lines.push(`  Units: ${fp.measurementSystem} / ${fp.temperatureUnit}°`);
  if (fp.inputMethods.length > 0) {
    lines.push(`  Input methods (${fp.inputMethods.length}): ${fp.inputMethods.map(m => `${m.friendlyName}[${m.region}]`).join(", ")}`);
  }
  if (fp.signals.length > 0) {
    lines.push("  Derived signals:");
    for (const s of fp.signals) {
      lines.push(`    [${s.strength}] ${s.name} — ${s.evidence}`);
    }
  }
  if (fp.contradictions.length > 0) {
    lines.push("  Contradictions (OS settings disagree — useful flags):");
    for (const c of fp.contradictions) {
      lines.push(`    ! ${c}`);
    }
  }
  return lines.join("\n");
}
