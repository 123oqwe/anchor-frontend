/**
 * End-to-end sync + project-state smoke test.
 * Starts server in-process, hits endpoints, asserts behavior, cleans up.
 */
import { appendEvent, getOrCreateManifest, verifyHashChain } from "../infra/storage/scanner-events.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

const BASE = "http://localhost:3099";

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function ok(cond: boolean, label: string) {
  if (cond) console.log(`  ✅ ${label}`);
  else { console.log(`  ❌ ${label}`); process.exitCode = 1; }
}

async function run() {
  console.log("\n━━━ SYNC SMOKE TEST ━━━");

  // Clean any events from prior test runs so the tip is deterministic
  db.prepare("DELETE FROM scanner_events WHERE kind='sync_test'").run();
  db.prepare("DELETE FROM derivation_manifest WHERE scanner='sync_test'").run();

  // Seed: append 3 events locally
  const manifestId = getOrCreateManifest({ scanner: "sync_test" });
  appendEvent({ source: "manual", kind: "sync_test", payload: { n: 1 }, occurredAt: "2026-04-23T10:00:00Z", stableFields: { n: 1 }, manifestId });
  appendEvent({ source: "manual", kind: "sync_test", payload: { n: 2 }, occurredAt: "2026-04-23T10:01:00Z", stableFields: { n: 2 }, manifestId });
  appendEvent({ source: "manual", kind: "sync_test", payload: { n: 3 }, occurredAt: "2026-04-23T10:02:00Z", stableFields: { n: 3 }, manifestId });

  const tipBefore = db.prepare("SELECT seq, this_hash FROM scanner_events WHERE user_id=? ORDER BY seq DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
  console.log("  local tip:", tipBefore.seq, tipBefore.this_hash.slice(0, 8));

  // Export
  const bundle = await req("POST", "/api/sync/export", { afterSeq: tipBefore.seq - 3 });
  ok(bundle.events.length === 3, `export returned 3 events (got ${bundle.events.length})`);
  ok(!!bundle.bundleHash, "bundle has hash");
  ok(bundle.lastHash === tipBefore.this_hash, "bundle last hash == local tip");

  // Tamper → import should reject
  const tampered = { ...bundle, events: [...bundle.events] };
  tampered.events[1] = { ...tampered.events[1], payload: { n: 999 } };
  let rejectErr: any = null;
  try { await req("POST", "/api/sync/import", tampered); }
  catch (e) { rejectErr = e; }
  ok(rejectErr !== null, "tampered bundle rejected");

  // Simulate "Device B" scenario: delete the 3 events locally (back to
  // pre-append state), then import the honest bundle. Import should
  // chain-continue from the earlier tip and restore all 3.
  db.prepare("DELETE FROM scanner_events WHERE kind='sync_test'").run();
  const reimport = await req("POST", "/api/sync/import", bundle);
  ok(reimport.imported === 3, `restored 3 events via import (got ${reimport.imported})`);
  ok(reimport.chainValid === true, "chain valid after restore");

  // Idempotent re-import: same bundle again → all duplicate
  const reimport2 = await req("POST", "/api/sync/import", bundle);
  ok(reimport2.duplicate === 3, `idempotent re-import → 3 duplicates (got ${reimport2.duplicate})`);
  ok(reimport2.imported === 0, "zero new on idempotent re-run");

  // Peers
  const peers = await req("GET", "/api/sync/peers");
  ok(peers.self.chainValid === true, "peers endpoint reports chainValid");
  ok(typeof peers.self.latestSeq === "number", "peers endpoint reports latestSeq");

  // Cleanup
  db.prepare("DELETE FROM scanner_events WHERE kind='sync_test'").run();
  db.prepare("DELETE FROM derivation_manifest WHERE scanner='sync_test'").run();

  console.log("\n━━━ PROJECT-STATE SMOKE TEST ━━━");

  const created = await req<{ id: string }>("POST", "/api/projects-lh", {
    name: "Career Pivot Q3 2026",
    goal: "Land offer at AI-first company by Sep 30",
    state: { milestones: [{ name: "Update resume", status: "pending" }], notes: "initial" },
    nextCheckIn: "2026-04-30",
  });
  ok(!!created.id, `project created (id=${created.id})`);

  const got = await req(`GET`, `/api/projects-lh/${created.id}`);
  ok(got.name === "Career Pivot Q3 2026", "GET returns name");
  ok(Array.isArray(got.state.milestones), "state.milestones present");
  ok(got.state.milestones[0].status === "pending", "milestone status pending");

  // Merge state update
  const merged = await req("PUT", `/api/projects-lh/${created.id}/state`, {
    merge: true,
    state: { notes: "updated after interview prep", agent_context: "fresh session" },
  });
  ok(merged.state.notes === "updated after interview prep", "merge applied notes");
  ok(Array.isArray(merged.state.milestones), "merge preserved existing fields");

  // Update status
  await req("PUT", `/api/projects-lh/${created.id}`, { status: "paused" });
  const afterPause = await req(`GET`, `/api/projects-lh/${created.id}`);
  ok(afterPause.status === "paused", "status updated to paused");

  // Cleanup
  db.prepare("DELETE FROM project_state WHERE id=?").run(created.id);

  console.log("\n━━━ DONE ━━━");
}

run().catch(err => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
