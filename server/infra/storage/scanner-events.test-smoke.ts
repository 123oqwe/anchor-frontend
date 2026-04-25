import { appendEvent, getOrCreateManifest, getEventStats, verifyHashChain, getEvents } from "./scanner-events.js";
import { db } from "./db.js";

console.log("=== before ===");
console.log(getEventStats());

const manifestId = getOrCreateManifest({
  scanner: "test_scanner",
  modelId: "test-model",
  promptHash: "abcdef",
  temperature: 0,
});
console.log("manifest id:", manifestId);

const manifestId2 = getOrCreateManifest({
  scanner: "test_scanner",
  modelId: "test-model",
  promptHash: "abcdef",
  temperature: 0,
});
console.log("manifest id (dedup):", manifestId2, "| same?", manifestId === manifestId2);

console.log("\n=== append 3 events ===");
const e1 = appendEvent({
  source: "manual", kind: "smoke_test", payload: { msg: "hello" },
  occurredAt: "2026-04-23T10:00:00Z", stableFields: { n: 1 }, manifestId,
});
console.log("e1:", e1);

const e1dup = appendEvent({
  source: "manual", kind: "smoke_test", payload: { msg: "hello" },
  occurredAt: "2026-04-23T10:00:00Z", stableFields: { n: 1 }, manifestId,
});
console.log("e1 dup (must have duplicate=true, same seq):", e1dup);

const e2 = appendEvent({
  source: "manual", kind: "smoke_test", payload: { msg: "world" },
  occurredAt: "2026-04-23T10:01:00Z", stableFields: { n: 2 }, manifestId,
});
const e3 = appendEvent({
  source: "manual", kind: "smoke_test", payload: { msg: "!" },
  occurredAt: "2026-04-23T10:02:00Z", stableFields: { n: 3 }, manifestId,
});

console.log("\n=== stats ===");
console.log(getEventStats());

console.log("\n=== verify hash chain (should be valid) ===");
console.log(verifyHashChain());

console.log("\n=== list events ===");
const events = getEvents({ source: "manual", kind: "smoke_test" });
for (const e of events) {
  console.log(`  seq=${e.seq} kind=${e.kind} prev=${e.prevHash?.slice(0, 8) ?? "-"} this=${e.thisHash.slice(0, 8)}`);
}

console.log("\n=== tamper one payload, re-verify ===");
db.prepare(
  "UPDATE scanner_events SET payload_json = '{\"msg\":\"TAMPERED\"}' WHERE kind = 'smoke_test' AND json_extract(payload_json, '$.msg') = 'world'"
).run();
const tamperReport = verifyHashChain();
console.log("tamper detected?", tamperReport.firstBadSeq !== null ? "✅ YES at seq=" + tamperReport.firstBadSeq : "❌ NO — BUG", "reason:", tamperReport.firstBadReason);

console.log("\n=== cleanup ===");
db.prepare("DELETE FROM scanner_events WHERE kind = 'smoke_test'").run();
db.prepare("DELETE FROM derivation_manifest WHERE scanner = 'test_scanner'").run();
console.log("cleaned. final stats:", getEventStats());
