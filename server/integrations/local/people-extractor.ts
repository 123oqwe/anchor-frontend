/**
 * People Extractor — finds people from browser history, WeChat, Telegram.
 *
 * Sources:
 * 1. Chrome history: LinkedIn profiles, X/Twitter profiles, GitHub profiles
 * 2. Chrome history: email addresses in page titles
 * 3. WeChat local contact database
 * 4. Apple Contacts (already in contacts.ts)
 *
 * Output: structured person records, not raw text for LLM.
 * These go directly into graph_nodes — no LLM extraction needed.
 */
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { db, DEFAULT_USER_ID } from "../../infra/storage/db.js";
import { nanoid } from "nanoid";

const HOME = os.homedir();

interface ExtractedPerson {
  name: string;
  source: string; // linkedin, twitter, github, email, wechat
  detail: string;
  domain: string; // relationships
}

// ── Extract from Chrome history ─────────────────────────────────────────────

function extractPeopleFromBrowser(): ExtractedPerson[] {
  const people: ExtractedPerson[] = [];
  const seen = new Set<string>();

  const profiles = [
    path.join(HOME, "Library/Application Support/Google/Chrome/Default/History"),
    path.join(HOME, "Library/Application Support/Google/Chrome/Profile 1/History"),
    path.join(HOME, "Library/Application Support/Google/Chrome/Profile 2/History"),
    path.join(HOME, "Library/Application Support/Google/Chrome/Profile 3/History"),
  ];

  for (const histPath of profiles) {
    if (!fs.existsSync(histPath)) continue;
    const tmpPath = path.join(os.tmpdir(), `anchor_people_${Date.now()}.db`);
    try {
      fs.copyFileSync(histPath, tmpPath);
      const histDb = new Database(tmpPath, { readonly: true });

      // LinkedIn profiles — "Harry Qiao | LinkedIn"
      const linkedin = histDb.prepare(
        "SELECT DISTINCT title FROM urls WHERE url LIKE '%linkedin.com/in/%' AND title LIKE '% | LinkedIn' AND title NOT IN ('Feed | LinkedIn', 'Grow | LinkedIn', 'Search | LinkedIn', 'LinkedIn Login, Sign in | LinkedIn', 'LinkedIn: Log In or Sign Up') AND title NOT LIKE '%Login%' AND title NOT LIKE '%Messaging%' AND title NOT LIKE '%Notifications%' AND title NOT LIKE '%Jobs%' AND title NOT LIKE '%Security%' AND title NOT LIKE '%Verification%' AND length(title) > 15 ORDER BY visit_count DESC LIMIT 30"
      ).all() as any[];

      for (const r of linkedin) {
        const name = r.title.replace(" | LinkedIn", "").replace(/^\(\d+\)\s*/, "").trim();
        const SKIP_NAMES = new Set(["search", "feed", "grow", "linkedin", "login", "security", "notifications", "jobs", "messaging", "home", "premium", "post", "activity", "featured", "education", "experience", "skills", "interests", "projects", "publications", "courses", "licenses", "certifications", "volunteer", "recommendations"]);
        // Also skip "Activity | Name", "Featured | Name", "Education | Name" patterns
        const isPageArtifact = name.includes(" | ") || name.startsWith("Post ") || name.startsWith("Activity ") || name.startsWith("Featured ") || name.startsWith("Education ");
        if (name && name.length > 2 && name.length < 40 && !seen.has(name.toLowerCase()) && !SKIP_NAMES.has(name.toLowerCase()) && !isPageArtifact) {
          seen.add(name.toLowerCase());
          people.push({ name, source: "linkedin", detail: "LinkedIn connection", domain: "relationships" });
        }
      }

      // X/Twitter profiles — "(1) Name (@handle) / X"
      const twitter = histDb.prepare(
        "SELECT DISTINCT title FROM urls WHERE (url LIKE '%twitter.com/%' OR url LIKE '%x.com/%') AND title LIKE '%(@%)%' AND title NOT LIKE '%search%' ORDER BY visit_count DESC LIMIT 20"
      ).all() as any[];

      for (const r of twitter) {
        const match = r.title.match(/^(?:\(\d+\)\s*)?(.+?)\s*\(@(\w+)\)/);
        if (match) {
          const name = match[1].trim();
          const handle = match[2];
          if (name && name.length > 1 && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            people.push({ name: `${name} (@${handle})`, source: "twitter", detail: `X/Twitter: @${handle}`, domain: "relationships" });
          }
        }
      }

      // Email addresses in page titles — "Inbox - john@company.com - Gmail"
      const emails = histDb.prepare(
        "SELECT DISTINCT title FROM urls WHERE title LIKE '%@%.% - %mail%' ORDER BY visit_count DESC LIMIT 10"
      ).all() as any[];

      for (const r of emails) {
        const emailMatch = r.title.match(/([\w.+-]+@[\w.-]+\.\w+)/);
        if (emailMatch) {
          const email = emailMatch[1];
          if (!seen.has(email.toLowerCase())) {
            seen.add(email.toLowerCase());
            people.push({ name: email, source: "email", detail: `Email account`, domain: "relationships" });
          }
        }
      }

      histDb.close();
    } catch {} finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  return people;
}

// ── Extract from WeChat local database ──────────────────────────────────────

function extractPeopleFromWeChat(): ExtractedPerson[] {
  const people: ExtractedPerson[] = [];

  // Find WeChat contact database
  const wechatBase = path.join(HOME, "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files");
  if (!fs.existsSync(wechatBase)) return [];

  try {
    // Find all contact.db files
    const contactDbs: string[] = [];
    const walkDir = (dir: string, depth = 0) => {
      if (depth > 5) return;
      try {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (f === "contact.db") contactDbs.push(full);
          else if (fs.statSync(full).isDirectory() && !f.includes("node_modules")) walkDir(full, depth + 1);
        }
      } catch {}
    };
    walkDir(wechatBase);

    for (const dbPath of contactDbs) {
      const tmpPath = path.join(os.tmpdir(), `anchor_wechat_${Date.now()}.db`);
      try {
        fs.copyFileSync(dbPath, tmpPath);
        const wcDb = new Database(tmpPath, { readonly: true });

        // WeChat contact tables vary by version — try common schemas
        try {
          const contacts = wcDb.prepare(
            "SELECT * FROM sqlite_master WHERE type='table'"
          ).all() as any[];

          // List available tables for debugging
          const tableNames = contacts.map((t: any) => t.name);

          // Try to read from known WeChat table structures
          for (const tableName of tableNames) {
            if (tableName.toLowerCase().includes("friend") || tableName.toLowerCase().includes("contact")) {
              try {
                const rows = wcDb.prepare(`SELECT * FROM "${tableName}" LIMIT 30`).all() as any[];
                for (const row of rows) {
                  // Try common column names
                  const name = row.nickname || row.remark || row.userName || row.name;
                  if (name && typeof name === "string" && name.length > 1 && name.length < 40 && !name.startsWith("wxid_")) {
                    people.push({ name, source: "wechat", detail: "WeChat contact", domain: "relationships" });
                  }
                }
              } catch {}
            }
          }
        } catch {}

        wcDb.close();
      } catch {} finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  } catch {}

  console.log(`[PeopleExtractor] WeChat: ${people.length} contacts found`);
  return people;
}

// ── Relationship categorization ─────────────────────────────────────────────

function categorizeRelationship(source: string, name: string): { category: string; strength: number } {
  switch (source) {
    case "linkedin": return { category: "professional", strength: 0.5 };
    case "twitter": return { category: "online", strength: 0.3 };
    case "email": return { category: "communication", strength: 0.7 };
    case "wechat": return { category: "personal", strength: 0.6 };
    default: return { category: "contact", strength: 0.3 };
  }
}

// ── NO auto-infer edges ─────────────────────────────────────────────────────
// Removed: blind connection of ALL people to ALL work goals was creating
// 180+ junk edges. Edges should only be created when there's EVIDENCE
// (same meeting, same email thread, user manually connects).
// People sit in the graph as standalone nodes until real evidence connects them.

// ── Write people directly to graph (no LLM needed) ──────────────────────────

export function extractAndSavePeople(): { total: number; sources: Record<string, number> } {
  const browserPeople = extractPeopleFromBrowser();
  const wechatPeople = extractPeopleFromWeChat();
  const allPeople = [...browserPeople, ...wechatPeople];

  const sources: Record<string, number> = {};
  let saved = 0;

  for (const person of allPeople) {
    sources[person.source] = (sources[person.source] ?? 0) + 1;

    // Check if person already exists in graph
    const firstName = person.name.split(/[\s(]/)[0];
    if (firstName.length < 2) continue;

    const existing = db.prepare(
      "SELECT id FROM graph_nodes WHERE user_id=? AND type='person' AND label LIKE ?"
    ).get(DEFAULT_USER_ID, `%${firstName}%`) as any;

    if (existing) continue;

    // Categorize relationship
    const { category, strength } = categorizeRelationship(person.source, person.name);
    const detail = `${person.detail} | ${category} | strength: ${strength}`;

    // Create person node
    const personId = nanoid();
    db.prepare(
      "INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail) VALUES (?,?,?,?,?,?,?,?)"
    ).run(personId, DEFAULT_USER_ID, person.domain, person.name, "person", "active", `Extracted from ${person.source}`, detail);



    saved++;
  }

  console.log(`[PeopleExtractor] Saved ${saved} new people from: ${JSON.stringify(sources)}`);
  return { total: saved, sources };
}
