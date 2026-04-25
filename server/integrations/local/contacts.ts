/**
 * Local Apple Contacts Scanner — reads contacts via AppleScript.
 * macOS will show TCC permission dialog on first run.
 */
import { execSync } from "child_process";
import type { IngestionEvent } from "../types.js";
import { shadowEmit } from "../../infra/storage/scanner-events.js";

export function scanContacts(): IngestionEvent[] {
  try {
    const script = `
      tell application "Contacts"
        set output to ""
        set personCount to count of people
        if personCount > 200 then set personCount to 200
        repeat with i from 1 to personCount
          set p to person i
          set n to name of p
          try
            set e to value of first email of p
          on error
            set e to ""
          end try
          try
            set o to organization of p
          on error
            set o to ""
          end try
          try
            set t to value of first phone of p
          on error
            set t to ""
          end try
          set output to output & n & "|" & e & "|" & o & "|" & t & "\\n"
        end repeat
        return output
      end tell
    `;

    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 30000,
      encoding: "utf-8",
    });

    const lines = raw.split("\n").filter(Boolean);
    const events: IngestionEvent[] = [];

    for (const line of lines) {
      const [name, email, org, phone] = line.split("|");
      if (!name || name.trim().length < 2) continue;

      const parts = [
        `Contact: ${name.trim()}`,
        email ? `Email: ${email.trim()}` : "",
        org ? `Organization: ${org.trim()}` : "",
        phone ? `Phone: ${phone.trim()}` : "",
      ].filter(Boolean);

      events.push({
        source: "gmail" as const, // reuse type
        externalId: `contact:${name.trim()}`,
        occurredAt: new Date().toISOString(),
        rawText: parts.join("\n"),
        metadata: { source: "apple_contacts", name: name.trim(), email: email?.trim(), org: org?.trim() },
      });
    }

    console.log(`[LocalScan] Contacts: ${events.length} people`);

    const scanDay = new Date().toISOString().slice(0, 10);
    const withEmail = events.filter(e => (e.metadata as any)?.email).length;
    const withOrg = events.filter(e => (e.metadata as any)?.org).length;
    shadowEmit({
      scanner: "apple-contacts",
      source: "contacts",
      kind: "contacts_scan_summary",
      stableFields: { scanDay },
      payload: {
        peopleCount: events.length,
        withEmail,
        withOrg,
        topNames: events.slice(0, 30).map(e => (e.metadata as any)?.name).filter(Boolean),
      },
    });

    return events;
  } catch (err: any) {
    if (err.message?.includes("not allowed") || err.message?.includes("-1743")) {
      console.log("[LocalScan] Contacts: permission denied by macOS. User needs to grant access.");
    } else {
      console.error("[LocalScan] Contacts error:", err.message);
    }
    return [];
  }
}
