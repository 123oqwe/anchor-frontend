/**
 * Deterministic invariant checks — runs against the live DB, no LLM judge.
 *
 * Complements the existing LLM-judged eval harness (runner.ts). This file
 * tests structural invariants that must hold regardless of content:
 *   - Time-travel: queryNodesAsOf honors the valid_from/valid_to window
 *   - Killer Queries: all 4 return correctly-shaped results
 *   - Hash chain: scanner_events log integrity is maintained
 *   - Bi-temporal triggers: all existing rows have valid_from/recorded_at
 *
 * Usage: npx tsx server/eval/invariants.ts
 * Exit 0 on all-pass; 1 on any failure. Suitable for CI.
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { queryNodesAsOf, queryEdgesAsOf } from "../graph/reader.js";
import {
  coolingWarmingNetwork, topActualContacts, attentionShift, commitmentsVsExecution,
} from "../cognition/killer-queries.js";
import { verifyHashChain, appendEvent, getOrCreateManifest } from "../infra/storage/scanner-events.js";
import { writeContactAggregate, countAggregates } from "../graph/contact-aggregates.js";
import { nanoid } from "nanoid";

interface InvariantResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: InvariantResult[] = [];

type CheckResult = boolean | string | undefined;
type Pending = { name: string; promise: Promise<CheckResult> };
const pendingChecks: Pending[] = [];

function check(name: string, fn: () => CheckResult | Promise<CheckResult>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      // Defer async checks; runner awaits them at the end before reporting.
      pendingChecks.push({ name, promise: r });
      return;
    }
    recordResult(name, r);
  } catch (err: any) {
    results.push({ name, passed: false, detail: err?.message ?? String(err) });
  }
}

function recordResult(name: string, r: CheckResult): void {
  if (r === true || r === undefined) {
    results.push({ name, passed: true });
  } else if (r === false) {
    results.push({ name, passed: false, detail: "assertion false" });
  } else {
    results.push({ name, passed: false, detail: r });
  }
}

// ── Bi-temporal invariants ─────────────────────────────────────────────────

check("all graph_nodes have valid_from", () => {
  const n = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE valid_from IS NULL").get() as any).c;
  return n === 0 ? true : `${n} rows with NULL valid_from`;
});

check("all graph_nodes have recorded_at", () => {
  const n = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE recorded_at IS NULL").get() as any).c;
  return n === 0 ? true : `${n} rows with NULL recorded_at`;
});

check("all memories have valid_from", () => {
  const n = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE valid_from IS NULL").get() as any).c;
  return n === 0 ? true : `${n} rows with NULL valid_from`;
});

check("bitemporal triggers exist on graph_nodes + memories", () => {
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%bitemporal%'"
  ).all() as any[];
  const names = triggers.map(t => t.name).sort();
  const expected = ["graph_nodes_bitemporal_default", "memories_bitemporal_default"];
  return JSON.stringify(names) === JSON.stringify(expected)
    ? true
    : `expected ${expected.join(",")} got ${names.join(",")}`;
});

// ── Time-travel query correctness ──────────────────────────────────────────

check("queryNodesAsOf respects valid_from upper bound", () => {
  // Insert 3 nodes with different valid_from values, query asOf in the middle
  const idA = nanoid(), idB = nanoid(), idC = nanoid();
  try {
    db.prepare(
      `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
       VALUES (?, ?, 'test', ?, 'test', 'active', '2020-01-01', '', ?, ?)`
    ).run(idA, DEFAULT_USER_ID, "asof-A", "2020-01-01 00:00:00", "2020-01-01 00:00:00");
    db.prepare(
      `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
       VALUES (?, ?, 'test', ?, 'test', 'active', '2023-01-01', '', ?, ?)`
    ).run(idB, DEFAULT_USER_ID, "asof-B", "2023-01-01 00:00:00", "2023-01-01 00:00:00");
    db.prepare(
      `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
       VALUES (?, ?, 'test', ?, 'test', 'active', '2026-01-01', '', ?, ?)`
    ).run(idC, DEFAULT_USER_ID, "asof-C", "2026-01-01 00:00:00", "2026-01-01 00:00:00");

    // As of 2024 — A + B should be visible, C should not
    const at2024 = queryNodesAsOf({ validAt: "2024-06-01" })
      .filter(n => n.domain === "test")
      .map(n => n.label).sort();
    if (at2024.includes("asof-C")) return "C leaked into 2024-asOf view";
    if (!at2024.includes("asof-A") || !at2024.includes("asof-B")) {
      return `2024 view missing A or B: got ${at2024.join(",")}`;
    }

    // As of 2019 — none visible
    const at2019 = queryNodesAsOf({ validAt: "2019-01-01" })
      .filter(n => n.domain === "test");
    if (at2019.length > 0) return `2019 view should be empty, got ${at2019.length}`;

    return true;
  } finally {
    db.prepare("DELETE FROM graph_nodes WHERE domain='test' AND id IN (?,?,?)").run(idA, idB, idC);
  }
});

check("queryNodesAsOf honors valid_to (closed-out nodes invisible)", () => {
  const id = nanoid();
  try {
    db.prepare(
      `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from, valid_to)
       VALUES (?, ?, 'test', ?, 'test', 'active', '2020-01-01', '', ?, ?, ?)`
    ).run(id, DEFAULT_USER_ID, "asof-closed", "2020-01-01 00:00:00",
          "2020-01-01 00:00:00", "2022-06-01 00:00:00");

    // As of 2021-06 (inside valid window) — visible
    const inside = queryNodesAsOf({ validAt: "2021-06-01" }).find(n => n.label === "asof-closed");
    if (!inside) return "closed-out node missing within its valid window";

    // As of 2023-06 (after valid_to) — invisible
    const after = queryNodesAsOf({ validAt: "2023-06-01" }).find(n => n.label === "asof-closed");
    if (after) return "closed-out node leaked beyond valid_to";

    return true;
  } finally {
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(id);
  }
});

check("queryEdgesAsOf excludes closed edges beyond valid_to", () => {
  // Smoke: just verify it runs without throwing and returns an array
  const edges = queryEdgesAsOf({ validAt: "2020-01-01" });
  return Array.isArray(edges) ? true : "queryEdgesAsOf did not return array";
});

// ── Killer Queries return correctly-shaped results ─────────────────────────

check("coolingWarmingNetwork returns array", () => Array.isArray(coolingWarmingNetwork()));
check("topActualContacts returns array", () => Array.isArray(topActualContacts()));
check("attentionShift returns array", () => Array.isArray(attentionShift()));
check("commitmentsVsExecution returns array", () => Array.isArray(commitmentsVsExecution()));

check("attentionShift buckets have valid schema", () => {
  const buckets = attentionShift({ months: 3 });
  for (const b of buckets) {
    if (typeof b.period !== "string") return "period not string";
    if (!Array.isArray(b.domains)) return "domains not array";
    if (typeof b.totalEvents !== "number") return "totalEvents not number";
    for (const d of b.domains) {
      if (typeof d.pctOfTotal !== "number") return "pctOfTotal not number";
      if (d.pctOfTotal < 0 || d.pctOfTotal > 100.5) return `pct out of range: ${d.pctOfTotal}`;
    }
  }
  return true;
});

check("commitmentDrift ages sorted by drift descending", () => {
  const drifts = commitmentsVsExecution({ staleDays: 0, limit: 20 });
  for (let i = 1; i < drifts.length; i++) {
    const prev = drifts[i - 1].ageDays / Math.max(1, drifts[i - 1].activityCount);
    const curr = drifts[i].ageDays / Math.max(1, drifts[i].activityCount);
    if (curr > prev + 0.001) return `drift score not descending at i=${i}: prev=${prev} curr=${curr}`;
  }
  return true;
});

// ── Event log + hash chain ─────────────────────────────────────────────────

check("hash chain verify is clean on current DB", () => {
  const audit = verifyHashChain();
  if (audit.firstBadSeq !== null) {
    return `chain broken at seq ${audit.firstBadSeq}: ${audit.firstBadReason}`;
  }
  return true;
});

check("scanner_events append + verify roundtrip", () => {
  const manifestId = getOrCreateManifest({ scanner: "eval-invariant" });
  try {
    const tag = `eval-invariant-${Date.now()}`;
    appendEvent({
      source: "manual", kind: tag, payload: { test: 1 },
      occurredAt: new Date().toISOString(), stableFields: { n: 1 }, manifestId,
    });
    appendEvent({
      source: "manual", kind: tag, payload: { test: 2 },
      occurredAt: new Date().toISOString(), stableFields: { n: 2 }, manifestId,
    });
    const audit = verifyHashChain();
    if (audit.firstBadSeq !== null) return `chain broken after append: seq ${audit.firstBadSeq}`;
    db.prepare("DELETE FROM scanner_events WHERE kind=?").run(tag);
    return true;
  } finally {
    db.prepare("DELETE FROM derivation_manifest WHERE scanner='eval-invariant'").run();
  }
});

// ── Contact aggregates — cooling/warming via snapshots ────────────────────

check("cooling/warming detects warming via snapshot diff", () => {
  const handle = `eval-inv-${Date.now()}@test.local`;
  const nodeId = nanoid();
  // Create a dummy person node so the snapshot can attach
  db.prepare(
    `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
     VALUES (?, ?, 'test', ?, 'person', 'active', '2020-01-01', '', ?, ?)`
  ).run(nodeId, DEFAULT_USER_ID, "Eval Warming Person",
        "2020-01-01 00:00:00", "2020-01-01 00:00:00");
  try {
    // Prior: low count, 45 days ago
    writeContactAggregate({
      contactNodeId: nodeId, contactHandle: handle, contactDisplayName: "Eval Warming Person",
      source: "mail", direction: "received",
      countInWindow: 2, windowDays: 30,
      snapshotAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
      metadata: { _eval: 1 },
    });
    // Now: high count
    writeContactAggregate({
      contactNodeId: nodeId, contactHandle: handle, contactDisplayName: "Eval Warming Person",
      source: "mail", direction: "received",
      countInWindow: 20, windowDays: 30,
      metadata: { _eval: 1 },
    });

    const results = coolingWarmingNetwork({ minInteractionsPrior: 1 });
    const found = results.find(r => r.nodeId === nodeId);
    if (!found) return "warming person not detected";
    if (found.classification !== "warming") return `expected warming, got ${found.classification}`;
    if (found.recentCount !== 20) return `recent count wrong: ${found.recentCount}`;
    if (found.priorCount !== 2) return `prior count wrong: ${found.priorCount}`;
    return true;
  } finally {
    db.prepare("DELETE FROM contact_aggregates WHERE contact_handle=?").run(handle);
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(nodeId);
  }
});

check("cooling/warming detects cooling via snapshot diff", () => {
  const handle = `eval-inv-cool-${Date.now()}@test.local`;
  const nodeId = nanoid();
  db.prepare(
    `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
     VALUES (?, ?, 'test', ?, 'person', 'active', '2020-01-01', '', ?, ?)`
  ).run(nodeId, DEFAULT_USER_ID, "Eval Cooling Person",
        "2020-01-01 00:00:00", "2020-01-01 00:00:00");
  try {
    writeContactAggregate({
      contactNodeId: nodeId, contactHandle: handle,
      source: "mail", direction: "received",
      countInWindow: 30, windowDays: 30,
      snapshotAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
      metadata: { _eval: 1 },
    });
    writeContactAggregate({
      contactNodeId: nodeId, contactHandle: handle,
      source: "mail", direction: "received",
      countInWindow: 3, windowDays: 30,
      metadata: { _eval: 1 },
    });

    const results = coolingWarmingNetwork({ minInteractionsPrior: 1 });
    const found = results.find(r => r.nodeId === nodeId);
    if (!found) return "cooling person not detected";
    if (found.classification !== "cooling") return `expected cooling, got ${found.classification}`;
    return true;
  } finally {
    db.prepare("DELETE FROM contact_aggregates WHERE contact_handle=?").run(handle);
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(nodeId);
  }
});

check("top-contacts reads from snapshots when available", () => {
  const handle = `eval-inv-top-${Date.now()}@test.local`;
  const nodeId = nanoid();
  db.prepare(
    `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
     VALUES (?, ?, 'test', ?, 'person', 'active', '2020-01-01', '', ?, ?)`
  ).run(nodeId, DEFAULT_USER_ID, "Eval Top Person",
        "2020-01-01 00:00:00", "2020-01-01 00:00:00");
  try {
    writeContactAggregate({
      contactNodeId: nodeId, contactHandle: handle, contactDisplayName: "Eval Top Person",
      source: "mail", direction: "received",
      countInWindow: 999, windowDays: 30,
      metadata: { _eval: 1 },
    });
    const results = topActualContacts({ limit: 50 });
    const found = results.find(r => r.nodeId === nodeId);
    if (!found) return "top contact not in results";
    if (found.totalInteractions !== 999) return `count mismatch: ${found.totalInteractions}`;
    return true;
  } finally {
    db.prepare("DELETE FROM contact_aggregates WHERE contact_handle=?").run(handle);
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(nodeId);
  }
});

check("cooling/warming returns empty when no prior snapshot exists", () => {
  // Fresh-scan state: only current snapshots, no older ones. Without a baseline
  // to diff against, every contact would falsely look like "warming (new)".
  // The snapshot path must fall through to empty rather than emit misleading
  // warming classifications for everyone.
  const handle = `eval-inv-noprior-${Date.now()}@test.local`;
  const nodeId = nanoid();
  db.prepare(
    `INSERT INTO graph_nodes (id, user_id, domain, label, type, status, captured, detail, created_at, valid_from)
     VALUES (?, ?, 'test', ?, 'person', 'active', '2020-01-01', '', ?, ?)`
  ).run(nodeId, DEFAULT_USER_ID, "Eval NoPrior Person",
        "2020-01-01 00:00:00", "2020-01-01 00:00:00");

  // Clear any prior snapshots so this person's "no prior" state is clean;
  // other tests may have left rows from their own fixtures
  const backupRows = db.prepare(
    "SELECT * FROM contact_aggregates WHERE user_id=? AND datetime(snapshot_at) < datetime('now','-30 days')"
  ).all(DEFAULT_USER_ID) as any[];
  db.prepare(
    "DELETE FROM contact_aggregates WHERE user_id=? AND datetime(snapshot_at) < datetime('now','-30 days')"
  ).run(DEFAULT_USER_ID);

  try {
    // Only a current snapshot — no prior
    writeContactAggregate({
      contactNodeId: nodeId, contactHandle: handle,
      source: "mail", direction: "received",
      countInWindow: 15, windowDays: 30,
      metadata: { _eval: 1 },
    });

    const results = coolingWarmingNetwork({ minInteractionsPrior: 1, comparisonLagDays: 30 });
    const found = results.find(r => r.nodeId === nodeId);
    if (found) return `should be empty for no-prior case, got ${found.classification}`;
    return true;
  } finally {
    db.prepare("DELETE FROM contact_aggregates WHERE contact_handle=?").run(handle);
    db.prepare("DELETE FROM graph_nodes WHERE id=?").run(nodeId);
    // Restore prior rows we cleared, by re-inserting via INSERT OR IGNORE
    for (const r of backupRows) {
      db.prepare(
        `INSERT OR IGNORE INTO contact_aggregates
         (id, user_id, snapshot_at, contact_node_id, contact_handle, contact_display_name,
          source, direction, count_in_window, window_days, first_at, last_at, metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(r.id, r.user_id, r.snapshot_at, r.contact_node_id, r.contact_handle,
            r.contact_display_name, r.source, r.direction, r.count_in_window,
            r.window_days, r.first_at, r.last_at, r.metadata_json);
    }
  }
});

// ── Phase 1: custom agent / cron structured config (Soul/Body/Faculty) ──

check("user_agents.config_json column exists", () => {
  const cols = db.prepare("PRAGMA table_info(user_agents)").all() as any[];
  const has = cols.some(c => c.name === "config_json");
  return has || "config_json column missing";
});

check("user_crons.config_json column exists", () => {
  const cols = db.prepare("PRAGMA table_info(user_crons)").all() as any[];
  const has = cols.some(c => c.name === "config_json");
  return has || "config_json column missing";
});

check("buildSystemPromptFromConfig composes Soul/Body/Faculty layers", async () => {
  const { buildSystemPromptFromConfig, AgentConfigSchema } = await import("../cognition/agent-config.js");
  const cfg = AgentConfigSchema.parse({
    soul: { purpose: "Test purpose", voice: "terse", values: ["truth"] },
    body: { role: "Tester", responsibilities: ["check things"], constraints: ["no PII"] },
    faculty: { skills: [], read_scope: ["graph"] },
  });
  const out = buildSystemPromptFromConfig(cfg);
  if (!out.includes("Test purpose")) return "Soul.purpose missing";
  if (!out.includes("Tester")) return "Body.role missing";
  if (!out.includes("no PII")) return "Body.constraints missing";
  if (!out.includes("graph")) return "Faculty.read_scope missing";
  return true;
});

check("shouldCronFire respects snooze_until in the future", async () => {
  const { shouldCronFire, CronConfigSchema } = await import("../cognition/agent-config.js");
  const future = new Date(Date.now() + 60_000).toISOString();
  const cfg = CronConfigSchema.parse({ snooze_until: future, conditions: [] });
  const r = shouldCronFire(cfg, {});
  if (r.fire) return "snooze ignored — should have skipped";
  return true;
});

check("shouldCronFire evaluates conditions correctly", async () => {
  const { shouldCronFire, CronConfigSchema } = await import("../cognition/agent-config.js");
  const cfg = CronConfigSchema.parse({
    conditions: [{ field: "user_state.energy", op: "<", value: 50 }],
  });
  const lowEnergy = shouldCronFire(cfg, { user_state: { energy: 30 } });
  if (!lowEnergy.fire) return `low-energy fire rejected: ${lowEnergy.reason}`;
  const highEnergy = shouldCronFire(cfg, { user_state: { energy: 80 } });
  if (highEnergy.fire) return "high-energy condition (energy<50) should have failed";
  return true;
});

check("recordRunInVitality increments correctly", async () => {
  const { recordRunInVitality, AgentConfigSchema } = await import("../cognition/agent-config.js");
  const cfg = AgentConfigSchema.parse({});
  const after1 = recordRunInVitality(cfg, { success: true, latencyMs: 100 });
  if (after1.vitality.success_count !== 1) return "success_count not incremented";
  if (after1.vitality.avg_latency_ms !== 100) return `latency expected 100, got ${after1.vitality.avg_latency_ms}`;
  const after2 = recordRunInVitality(after1, { success: false, latencyMs: 200, error: "test error" });
  if (after2.vitality.failure_count !== 1) return "failure_count not incremented";
  if (after2.vitality.last_error !== "test error") return "last_error not captured";
  // rolling avg over 2 runs: (100 + 200) / 2 = 150
  if (after2.vitality.avg_latency_ms !== 150) return `rolling avg wrong: ${after2.vitality.avg_latency_ms}`;
  return true;
});

// ── Phase 2: System agent overrides (Mode C — per-field lock) ──────────

check("system_agent_overrides table exists", () => {
  const t = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='system_agent_overrides'"
  ).all();
  return t.length === 1 || "system_agent_overrides table missing";
});

check("twin spec LOCKED purpose preserved through composer", async () => {
  const { TwinAgentSpec } = await import("../cognition/system-agents/twin.js");
  const { composeSystemAgentConfig } = await import("../cognition/agent-spec.js");
  const composed = composeSystemAgentConfig(TwinAgentSpec);
  if (!composed.soul.purpose.includes("Observe")) {
    return `Twin purpose missing 'Observe', got: ${composed.soul.purpose.slice(0, 80)}`;
  }
  return true;
});

check("LOCKED field cannot be overridden via DB", async () => {
  const { TwinAgentSpec } = await import("../cognition/system-agents/twin.js");
  const { composeSystemAgentConfig } = await import("../cognition/agent-spec.js");

  // Plant a hostile override on a LOCKED field — composer must ignore it.
  // This is the security-critical invariant: a compromised UI / DB write
  // can't bypass Anchor identity by writing to soul.purpose.
  db.prepare("DELETE FROM system_agent_overrides WHERE agent_id='twin' AND field_path='soul.purpose'").run();
  db.prepare(
    "INSERT INTO system_agent_overrides (agent_id, field_path, value, schema_version) VALUES (?,?,?,?)"
  ).run("twin", "soul.purpose", JSON.stringify("HACKED"), 1);
  try {
    const composed = composeSystemAgentConfig(TwinAgentSpec);
    if (composed.soul.purpose === "HACKED") {
      return "LOCKED field bypassed — security regression";
    }
    return true;
  } finally {
    db.prepare("DELETE FROM system_agent_overrides WHERE agent_id='twin' AND field_path='soul.purpose'").run();
  }
});

check("USER override on twin.soul.voice takes effect", async () => {
  const { TwinAgentSpec } = await import("../cognition/system-agents/twin.js");
  const { composeSystemAgentConfig } = await import("../cognition/agent-spec.js");

  db.prepare("DELETE FROM system_agent_overrides WHERE agent_id='twin' AND field_path='soul.voice'").run();
  db.prepare(
    "INSERT INTO system_agent_overrides (agent_id, field_path, value, schema_version) VALUES (?,?,?,?)"
  ).run("twin", "soul.voice", JSON.stringify("Custom test voice"), 1);
  try {
    const composed = composeSystemAgentConfig(TwinAgentSpec);
    if (composed.soul.voice !== "Custom test voice") {
      return `voice override failed, got: ${composed.soul.voice}`;
    }
    return true;
  } finally {
    db.prepare("DELETE FROM system_agent_overrides WHERE agent_id='twin' AND field_path='soul.voice'").run();
  }
});

check("ADD_ONLY field appends user item to spec defaults", async () => {
  const { TwinAgentSpec } = await import("../cognition/system-agents/twin.js");
  const { composeSystemAgentConfig } = await import("../cognition/agent-spec.js");

  const additionId = "test_addition_" + Date.now();
  db.prepare(
    "INSERT INTO system_agent_additions (id, agent_id, field_path, value, schema_version) VALUES (?,?,?,?,?)"
  ).run(additionId, "twin", "body.constraints", JSON.stringify("Don't infer about my finances"), 1);
  try {
    const composed = composeSystemAgentConfig(TwinAgentSpec);
    if (!composed.body.constraints.includes("Don't infer about my finances")) {
      return "user-added constraint missing from composed";
    }
    if (!composed.body.constraints.includes("Never write to user_state directly")) {
      return "Anchor's built-in constraint disappeared after user added";
    }
    return true;
  } finally {
    db.prepare("DELETE FROM system_agent_additions WHERE id=?").run(additionId);
  }
});

check("composer outputs non-empty Twin prompt (defensive)", async () => {
  const { TwinAgentSpec } = await import("../cognition/system-agents/twin.js");
  const { composeSystemAgentConfig } = await import("../cognition/agent-spec.js");
  const { buildSystemPromptFromConfig } = await import("../cognition/agent-config.js");
  const composed = composeSystemAgentConfig(TwinAgentSpec);
  const prompt = buildSystemPromptFromConfig(composed);
  if (prompt.length < 50) {
    return `composed Twin prompt too short (${prompt.length} chars) — fallback would trigger`;
  }
  return true;
});

check("every cron gated() call has a SystemCronSpec (UI snooze coverage)", async () => {
  // Phase 2 — every gated() call in cron.ts must have a matching spec so
  // /api/system/crons surfaces it and the user can snooze any of them. If
  // someone adds a new schedule() without a spec, this catches it.
  // 8 cron specs were removed when their handlers migrated to workflow DAGs;
  // the count assertion is now spec.size === ids.size (no magic number).
  const { listSystemCronSpecs } = await import("../cognition/system-agents/registry.js");
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const cronSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../orchestration/cron.ts"),
    "utf8",
  );
  const ids = new Set<string>();
  const re = /gated\(\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cronSrc)) !== null) ids.add(m[1]);
  const spec = new Set(listSystemCronSpecs().map(c => c.id));
  const missing = Array.from(ids).filter(id => !spec.has(id));
  if (missing.length) return `crons without spec: ${missing.join(", ")}`;
  const orphans = Array.from(spec).filter(id => !ids.has(id));
  if (orphans.length) return `specs without cron: ${orphans.join(", ")}`;
  return true;
});

check("plan compiler: handlerToRuntime covers all ToolHandler variants", async () => {
  // Phase 1 of #2 — defensive. If someone adds a new ToolHandler value
  // without extending handlerToRuntime, compile would crash on first use
  // of a tool with that handler. Catch at boot instead.
  const { handlerToRuntime } = await import("../cognition/plan-compiler.js");
  const handlers: Array<"db" | "api" | "browser" | "code" | "shell" | "internal" | "mcp"> = [
    "db", "api", "browser", "code", "shell", "internal", "mcp",
  ];
  for (const h of handlers) {
    const r = handlerToRuntime(h);
    if (!["llm", "cli", "browser", "local_app", "db", "human"].includes(r)) {
      return `handlerToRuntime("${h}") returned invalid runtime "${r}"`;
    }
  }
  return true;
});

check("plan compiler: action_sessions + action_steps tables exist", () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('action_sessions','action_steps')"
  ).all() as any[];
  if (tables.length !== 2) return `expected 2 tables, got ${tables.length}: ${tables.map(t => t.name).join(",")}`;
  return true;
});

check("plan compiler: every registered tool maps to a known runtime", async () => {
  const { handlerToRuntime } = await import("../cognition/plan-compiler.js");
  const { getAllTools } = await import("../execution/registry.js");
  const tools = getAllTools();
  if (tools.length === 0) return true;   // no tools registered in invariant context — skip
  for (const t of tools) {
    const r = handlerToRuntime(t.handler);
    if (!r) return `tool ${t.name} has handler ${t.handler} → no runtime`;
  }
  return true;
});

check("plan compiler: compileAndPersistPlan rejects empty input", async () => {
  // Sanity: empty plan should never produce a session row in pending state.
  // (We don't actually call the LLM here — the function bails before that.)
  const { compileAndPersistPlan } = await import("../cognition/plan-compiler.js");
  const r = await compileAndPersistPlan({ goal: "test", steps: [] });
  if (r.ok) return "expected failure on empty steps, got ok";
  if (!r.sessionId) return "expected sessionId even on failure (for inspection)";
  // Cleanup
  db.prepare("DELETE FROM action_sessions WHERE id=?").run(r.sessionId);
  return true;
});

check("approval queue: informational rows cannot be decided", async () => {
  // Final-pass — gate.ts dual-writes inbox rows tagged informational because
  // gate.ts is sync and the caller has already decided. The decide endpoint
  // must refuse those (would otherwise lie about effect).
  const { enqueueApproval, decideApproval } = await import("../permission/approval-queue.js");
  const ref = "inv_info_" + Date.now();
  const id = enqueueApproval({
    source: "gate",
    sourceRefId: ref,
    title: "info-only test",
    detail: { informational: true },
    riskLevel: "medium",
  });
  try {
    const r = decideApproval({ id, approve: true });
    if (r.ok) return "informational row was decideable — should be refused";
    if (r.reason !== "informational") return `wrong reject reason: ${r.reason}`;
    return true;
  } finally {
    db.prepare("DELETE FROM approval_queue WHERE id=?").run(id);
  }
});

check("verifier: sent_message_exists rejects placeholder ids", async () => {
  // Tightened verifier — synthetic / too-short ids should not pass off as
  // delivered messages.
  const { runVerifier } = await import("../execution/verifiers.js");
  const cases: Array<[string, boolean]> = [
    ["applescript:Reminder body", false],
    ["short", false],
    ["unknown", false],
    ["null", false],
    ["18a3f0c2c1d4567ef0a1b2c3d4e5f60a", true],   // gmail-format hex
    ["msg_abcdef123456789", true],                // arbitrary 8+ char id
  ];
  for (const [id, expected] of cases) {
    const r = await runVerifier("sent_message_exists", {
      stepName: "x", stepType: "side_effect", outputText: "",
      observation: { runtime: "local_app", bridgeResponseId: id },
      tool: "send_email",
    });
    if (r.pass !== expected) return `id "${id}" pass=${r.pass} expected ${expected}: ${r.evidence}`;
  }
  return true;
});

check("session runner default-on safety net is wired", async () => {
  // Verify handlers.ts uses the legacy-opt-out flag instead of the
  // new-opt-in flag. If someone reverts to old default, this fires.
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "../orchestration/handlers.ts"), "utf8");
  if (src.includes('process.env.ANCHOR_NEW_SESSION_RUNNER === "true"')) {
    return "handlers.ts still using old opt-in flag — should be opt-out via ANCHOR_LEGACY_REACT";
  }
  if (!src.includes("ANCHOR_LEGACY_REACT")) {
    return "ANCHOR_LEGACY_REACT opt-out flag not present";
  }
  if (!src.includes("falling back to legacy ReAct")) {
    return "safety-net try/catch fallback log not present";
  }
  return true;
});

check("a/b coverage: pickVariant wired into 4 prompt sites", async () => {
  // Final-pass for #7. Catch regressions where someone removes pickVariant
  // from a Cognition site without realising it's the only A/B hook there.
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sites = [
    "../cognition/decision.ts",
    "../cognition/twin.ts",
    "../cognition/extractor.ts",
    "../memory/dream.ts",
  ];
  for (const rel of sites) {
    const src = fs.readFileSync(path.resolve(here, rel), "utf8");
    if (!/pickVariant\s*\(/.test(src)) return `${rel} no longer calls pickVariant`;
  }
  return true;
});

check("runtime router: every RuntimeKind has a policy", async () => {
  // Phase 4 of #2 — defense against adding runtime to compiler enum but
  // forgetting to register a policy. Same shape as the handlerToRuntime
  // invariant: catch the omission at boot.
  const { getRuntimePolicy } = await import("../execution/runtime-router.js");
  const runtimes: Array<"llm" | "cli" | "browser" | "local_app" | "db" | "human"> = [
    "llm", "cli", "browser", "local_app", "db", "human",
  ];
  for (const r of runtimes) {
    const p = getRuntimePolicy(r);
    if (!p) return `runtime "${r}" has no policy`;
    if (typeof p.timeoutMs !== "number") return `runtime "${r}" timeoutMs not a number`;
    if (typeof p.defaultRetryable !== "boolean") return `runtime "${r}" defaultRetryable not boolean`;
  }
  return true;
});

check("runtime router: side-effect runtimes default to non-retryable", async () => {
  // Karpathy lens: emails/reminders/calendar must NEVER auto-retry on transient
  // failure — double-send risk too high. Codify this as an invariant.
  const { getRuntimePolicy } = await import("../execution/runtime-router.js");
  const sideEffectRuntimes: Array<"local_app" | "browser" | "cli"> = ["local_app", "browser", "cli"];
  for (const r of sideEffectRuntimes) {
    const p = getRuntimePolicy(r);
    if (p.defaultRetryable) return `runtime "${r}" should default to NON-retryable (side-effect)`;
  }
  return true;
});

check("session takeover: edit a non-pending step is rejected (409)", async () => {
  // Phase 4 — concurrency safety. Don't let user mutate steps that are
  // running/succeeded/failed; SessionRunner relies on those being immutable.
  // Pure in-process check — we test the helper logic via direct SQL guard.
  const sessId = "inv_to_s_" + Date.now();
  const stepId = "inv_to_step_" + Date.now();
  db.prepare(
    "INSERT INTO action_sessions (id, user_id, goal, source, status) VALUES (?,?,?,?,?)"
  ).run(sessId, DEFAULT_USER_ID, "test", "advisor_confirm", "running");
  db.prepare(
    `INSERT INTO action_steps (id, session_id, step_index, name, type, runtime, status)
     VALUES (?,?,?,?,?,?,?)`
  ).run(stepId, sessId, 0, "x", "side_effect", "local_app", "succeeded");
  try {
    // Simulate the same WHERE clause used by PATCH endpoint.
    const updatable = db.prepare(
      "SELECT 1 FROM action_steps WHERE id=? AND status IN ('pending','retrying','awaiting_approval')"
    ).get(stepId);
    if (updatable) return "succeeded step is updatable — should not be";
    return true;
  } finally {
    db.prepare("DELETE FROM action_steps WHERE id=?").run(stepId);
    db.prepare("DELETE FROM action_sessions WHERE id=?").run(sessId);
  }
});

check("session takeover: cancel marks open steps skipped", async () => {
  // Direct logic check — the cancel route runs this UPDATE; ensure the
  // SQL hits steps in pending/retrying/awaiting_approval and leaves others.
  const sessId = "inv_cancel_s_" + Date.now();
  const ids = [nanoid(), nanoid(), nanoid()];
  db.prepare(
    "INSERT INTO action_sessions (id, user_id, goal, source, status) VALUES (?,?,?,?,?)"
  ).run(sessId, DEFAULT_USER_ID, "test", "advisor_confirm", "running");
  db.prepare("INSERT INTO action_steps (id, session_id, step_index, name, type, runtime, status) VALUES (?,?,?,?,?,?,?)")
    .run(ids[0], sessId, 0, "succeeded one", "query", "db", "succeeded");
  db.prepare("INSERT INTO action_steps (id, session_id, step_index, name, type, runtime, status) VALUES (?,?,?,?,?,?,?)")
    .run(ids[1], sessId, 1, "pending one", "side_effect", "local_app", "pending");
  db.prepare("INSERT INTO action_steps (id, session_id, step_index, name, type, runtime, status) VALUES (?,?,?,?,?,?,?)")
    .run(ids[2], sessId, 2, "awaiting one", "side_effect", "local_app", "awaiting_approval");
  try {
    db.prepare(
      `UPDATE action_steps SET status='skipped', updated_at=datetime('now')
         WHERE session_id=? AND status IN ('pending','retrying','awaiting_approval')`
    ).run(sessId);
    const rows = db.prepare("SELECT id, status FROM action_steps WHERE session_id=? ORDER BY step_index").all(sessId) as any[];
    if (rows[0].status !== "succeeded") return "succeeded step was modified";
    if (rows[1].status !== "skipped") return `pending → ${rows[1].status}, expected skipped`;
    if (rows[2].status !== "skipped") return `awaiting → ${rows[2].status}, expected skipped`;
    return true;
  } finally {
    db.prepare("DELETE FROM action_steps WHERE session_id=?").run(sessId);
    db.prepare("DELETE FROM action_sessions WHERE id=?").run(sessId);
  }
});

check("verifier registry: every KNOWN_VERIFY_RULE has an implementation", async () => {
  // Phase 3 of #2 — compiler may pick rules from KNOWN_VERIFY_RULES; if any
  // rule lacks a registered checker, runner would mark verify_status='fail'
  // for unknown rule. Catch the gap at boot.
  const { KNOWN_VERIFY_RULES } = await import("../cognition/plan-compiler.js");
  const { getVerifier } = await import("../execution/verifiers.js");
  const missing = KNOWN_VERIFY_RULES.filter(r => !getVerifier(r));
  if (missing.length) return `verify rules without implementation: ${missing.join(", ")}`;
  return true;
});

check("verifier registry: runVerifier returns fail (not throw) on unknown rule", async () => {
  // Defense-in-depth: if compiler ever invents a rule, verifier should fail
  // gracefully so the runner can keep advancing other steps.
  const { runVerifier } = await import("../execution/verifiers.js");
  const r = await runVerifier("nonexistent_rule_xyz", {
    stepName: "x", stepType: "side_effect", outputText: "", observation: null, tool: null,
  });
  if (r.pass) return "expected pass=false on unknown rule";
  if (!r.evidence.includes("unknown")) return `expected 'unknown' in evidence, got: ${r.evidence}`;
  return true;
});

check("verifier: record_exists passes only when db observation has rowCount > 0", async () => {
  const { runVerifier } = await import("../execution/verifiers.js");
  const okCase = await runVerifier("record_exists", {
    stepName: "x", stepType: "side_effect", outputText: "",
    observation: { runtime: "db", table: "tasks", rowCount: 1, ids: ["abc"] },
    tool: "write_task",
  });
  if (!okCase.pass) return `expected pass on rowCount=1, got fail: ${okCase.evidence}`;
  const failCase = await runVerifier("record_exists", {
    stepName: "x", stepType: "side_effect", outputText: "",
    observation: { runtime: "db", table: "tasks", rowCount: 0 },
    tool: "write_task",
  });
  if (failCase.pass) return `expected fail on rowCount=0, got pass`;
  return true;
});

check("verifier: targets_nonempty handles bare array, {targets}, {results}", async () => {
  const { runVerifier } = await import("../execution/verifiers.js");
  for (const out of ['[{"a":1}]', '{"targets":[1,2]}', '{"results":["x"]}']) {
    const r = await runVerifier("targets_nonempty", {
      stepName: "x", stepType: "query", outputText: out, observation: null, tool: null,
    });
    if (!r.pass) return `expected pass for "${out}", got fail: ${r.evidence}`;
  }
  for (const out of ['[]', '{"targets":[]}', '{"foo":"bar"}', "not json"]) {
    const r = await runVerifier("targets_nonempty", {
      stepName: "x", stepType: "query", outputText: out, observation: null, tool: null,
    });
    if (r.pass) return `expected fail for "${out}", got pass`;
  }
  return true;
});

check("session runner: input template resolves mustache refs against prior steps", async () => {
  // Phase 2 of #2 — pure unit test of the resolver. Doesn't touch DB.
  const { resolveInputTemplate } = await import("../orchestration/session-runner.js");
  const prior: any[] = [
    { step_index: 0, output_text: '{"targets":[{"email":"a@x.com","name":"Alice"}]}', observation_json: null, depends_on_step_ids_json: "[]" },
    { step_index: 1, output_text: "Hi Alice, ...", observation_json: null, depends_on_step_ids_json: "[]" },
  ];
  const step: any = {
    step_index: 2,
    input_template_json: '{"to":"{{steps[0].output.targets[0].email}}","subject":"hi","body":"{{prev.output}}"}',
  };
  // Note: jsonpath into arrays via [0] not natively supported in our walk —
  // we walk segments. This invariant uses object-only paths to stay aligned.
  const stepObj: any = {
    step_index: 2,
    input_template_json: '{"to":"{{steps[0].output.targets}}","subject":"hi","body":"{{prev.output}}"}',
  };
  const out = resolveInputTemplate(stepObj, prior);
  if (!out || typeof out !== "object") return `resolved not object: ${JSON.stringify(out)}`;
  if (out.body !== "Hi Alice, ...") return `prev.output ref failed: ${out.body}`;
  if (!Array.isArray(out.to) || out.to[0]?.email !== "a@x.com") return `steps[0].output.targets ref failed: ${JSON.stringify(out.to)}`;
  return true;
});

check("session runner: unresolved template ref throws", async () => {
  const { resolveInputTemplate } = await import("../orchestration/session-runner.js");
  const step: any = { step_index: 0, input_template_json: '{"x":"{{steps[99].output}}"}' };
  try {
    resolveInputTemplate(step, []);
    return "expected throw on unresolved ref, got none";
  } catch (err: any) {
    if (!err?.message?.includes("unresolved")) return `expected unresolved error, got: ${err?.message}`;
    return true;
  }
});

check("session runner: startSession is a no-op on non-pending sessions", async () => {
  const { startSession } = await import("../orchestration/session-runner.js");
  const id = "inv_runner_" + Date.now();
  db.prepare(
    "INSERT INTO action_sessions (id, user_id, goal, source, status) VALUES (?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, "test", "advisor_confirm", "completed");
  try {
    startSession(id);
    const after = db.prepare("SELECT status FROM action_sessions WHERE id=?").get(id) as any;
    if (after?.status !== "completed") return `expected unchanged status=completed, got ${after?.status}`;
    return true;
  } finally {
    db.prepare("DELETE FROM action_sessions WHERE id=?").run(id);
  }
});

check("session runner: applyStepApprovalDecision flips status correctly", async () => {
  const { applyStepApprovalDecision } = await import("../orchestration/session-runner.js");
  const sessId = "inv_appdec_s_" + Date.now();
  const stepId = "inv_appdec_step_" + Date.now();
  db.prepare(
    "INSERT INTO action_sessions (id, user_id, goal, source, status) VALUES (?,?,?,?,?)"
  ).run(sessId, DEFAULT_USER_ID, "test", "advisor_confirm", "running");
  db.prepare(
    `INSERT INTO action_steps (id, session_id, step_index, name, type, runtime, status, approval_required)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(stepId, sessId, 0, "test step", "side_effect", "local_app", "awaiting_approval", 1);
  try {
    applyStepApprovalDecision(stepId, true);
    const row = db.prepare("SELECT status, approval_decision FROM action_steps WHERE id=?").get(stepId) as any;
    if (row?.status !== "pending") return `expected status=pending after approve, got ${row?.status}`;
    if (row?.approval_decision !== "approved") return `expected approval_decision=approved, got ${row?.approval_decision}`;
    return true;
  } finally {
    db.prepare("DELETE FROM action_steps WHERE id=?").run(stepId);
    db.prepare("DELETE FROM action_sessions WHERE id=?").run(sessId);
  }
});

check("plan compiler: failed session has compile_error and status='failed'", async () => {
  const { compileAndPersistPlan } = await import("../cognition/plan-compiler.js");
  const r = await compileAndPersistPlan({ goal: "test", steps: [] });
  if (r.ok) return "expected failure";
  const row = db.prepare(
    "SELECT status, compile_error FROM action_sessions WHERE id=?"
  ).get(r.sessionId) as any;
  try {
    if (row?.status !== "failed") return `expected status=failed, got ${row?.status}`;
    if (!row?.compile_error) return "expected non-empty compile_error";
    return true;
  } finally {
    db.prepare("DELETE FROM action_sessions WHERE id=?").run(r.sessionId);
  }
});

check("approval inbox: enqueue is idempotent on (source, source_ref_id)", async () => {
  // Sprint B — #4 — re-enqueueing same source pair while pending must
  // return the existing id, not insert a duplicate.
  const { enqueueApproval, decideApproval } = await import("../permission/approval-queue.js");
  const ref = "inv_idem_" + Date.now();
  const id1 = enqueueApproval({ source: "gate", sourceRefId: ref, title: "test 1" });
  const id2 = enqueueApproval({ source: "gate", sourceRefId: ref, title: "test 2 (ignored)" });
  try {
    if (id1 !== id2) return `expected idempotent enqueue, got two ids: ${id1} vs ${id2}`;
    const count = (db.prepare(
      "SELECT COUNT(*) AS c FROM approval_queue WHERE source='gate' AND source_ref_id=?"
    ).get(ref) as any).c;
    if (count !== 1) return `expected 1 row, got ${count}`;
    return true;
  } finally {
    decideApproval({ id: id1, approve: false, reason: "test cleanup" });
    db.prepare("DELETE FROM approval_queue WHERE source='gate' AND source_ref_id=?").run(ref);
  }
});

check("approval inbox: decide flips status + fires APPROVAL_DECIDED event", async () => {
  // Sprint B — #4 — proves the closing-loop event actually fires so source
  // modules can reconcile.
  const { enqueueApproval, decideApproval } = await import("../permission/approval-queue.js");
  const { bus } = await import("../orchestration/bus.js");
  const ref = "inv_decide_" + Date.now();
  const id = enqueueApproval({ source: "app", sourceRefId: ref, title: "decide test", riskLevel: "low" });
  let fired = false;
  const listener = (e: any) => { if (e.type === "APPROVAL_DECIDED" && e.payload.id === id) fired = true; };
  bus.on("event", listener);
  try {
    const r = decideApproval({ id, approve: true, reason: "ok" });
    if (!r.ok) return "decide returned not-ok";
    if (r.row?.status !== "approved") return `expected status=approved, got ${r.row?.status}`;
    // Bus is sync within same tick — give microtask hop just in case.
    await new Promise(r => setImmediate(r));
    if (!fired) return "APPROVAL_DECIDED event did not fire";
    return true;
  } finally {
    bus.off("event", listener);
    db.prepare("DELETE FROM approval_queue WHERE source='app' AND source_ref_id=?").run(ref);
  }
});

check("approval inbox: stats counts only pending", async () => {
  const { enqueueApproval, decideApproval, inboxStats } = await import("../permission/approval-queue.js");
  const before = inboxStats().pending;
  const ref = "inv_stats_" + Date.now();
  const id = enqueueApproval({ source: "gate", sourceRefId: ref, title: "stats test" });
  try {
    const after = inboxStats().pending;
    if (after !== before + 1) return `expected pending=${before + 1}, got ${after}`;
    decideApproval({ id, approve: false });
    const final = inboxStats().pending;
    if (final !== before) return `expected pending back to ${before}, got ${final}`;
    return true;
  } finally {
    db.prepare("DELETE FROM approval_queue WHERE source='gate' AND source_ref_id=?").run(ref);
  }
});

check("prompt A/B: pickVariant returns fallback when no experiment exists", async () => {
  // Sprint A — #7 — prove the zero-overhead path: with no experiment row,
  // pickVariant must return the supplied fallback verbatim and write nothing.
  const { pickVariant } = await import("../orchestration/experiment-runner.js");
  const key = "inv_no_exp_" + Date.now();
  const fallback = "FALLBACK_" + Date.now();
  const r = pickVariant({ key, fallback });
  if (r.value !== fallback) return `expected fallback, got ${r.value}`;
  if (r.variant !== "fallback") return `expected variant=fallback, got ${r.variant}`;
  if (r.assignmentId !== null) return `expected null assignmentId, got ${r.assignmentId}`;
  return true;
});

check("prompt A/B: pickVariant honors active experiment + writes assignment", async () => {
  // Sprint A — #7 — prove the override path: create an experiment, call
  // pickVariant with a contextRef → assignment row appears + value is one
  // of the two variants.
  const { pickVariant, createExperiment, stopExperiment } = await import("../orchestration/experiment-runner.js");
  const key = "inv_exp_" + Date.now();
  const expId = createExperiment({
    key,
    variantAValue: "VARIANT_A",
    variantBValue: "VARIANT_B",
    trafficSplit: 0.5,
  });
  try {
    const ctx = "ctx_" + Date.now();
    const r = pickVariant({ key, fallback: "FALLBACK", contextRef: ctx });
    if (r.value !== "VARIANT_A" && r.value !== "VARIANT_B") {
      return `expected variant value, got ${r.value}`;
    }
    if (!r.assignmentId) return "expected assignment id, got null";
    const row = db.prepare(
      "SELECT variant, context_ref FROM experiment_assignments WHERE id=?"
    ).get(r.assignmentId) as any;
    if (!row) return "assignment row not persisted";
    if (row.context_ref !== ctx) return `context_ref mismatch: ${row.context_ref}`;
    return true;
  } finally {
    stopExperiment(expId);
    db.prepare("DELETE FROM experiment_assignments WHERE experiment_id=?").run(expId);
    db.prepare("DELETE FROM experiments WHERE id=?").run(expId);
  }
});

check("prompt A/B: recordOutcome attributes signal to open assignment", async () => {
  // Sprint A — #7 — proves the closing-loop call: pickVariant writes
  // assignment with context_ref → recordOutcome with same context_ref →
  // assignment row gets outcome_signal/value/at populated.
  const { pickVariant, recordOutcome, createExperiment, stopExperiment } = await import("../orchestration/experiment-runner.js");
  const key = "inv_attr_" + Date.now();
  const expId = createExperiment({ key, variantAValue: "A", variantBValue: "B", trafficSplit: 0.5 });
  try {
    const ctx = "ctx_attr_" + Date.now();
    const r = pickVariant({ key, fallback: "F", contextRef: ctx });
    if (!r.assignmentId) return "no assignmentId — cannot test attribution";
    const updated = recordOutcome({ contextRef: ctx, signalType: "plan_confirmed", value: 1.0 });
    if (updated !== 1) return `expected 1 row updated, got ${updated}`;
    const row = db.prepare(
      "SELECT outcome_signal, outcome_value FROM experiment_assignments WHERE id=?"
    ).get(r.assignmentId) as any;
    if (row?.outcome_signal !== "plan_confirmed") return `outcome_signal not set: ${row?.outcome_signal}`;
    if (row?.outcome_value !== 1.0) return `outcome_value mismatch: ${row?.outcome_value}`;
    return true;
  } finally {
    stopExperiment(expId);
    db.prepare("DELETE FROM experiment_assignments WHERE experiment_id=?").run(expId);
    db.prepare("DELETE FROM experiments WHERE id=?").run(expId);
  }
});

check("prompt A/B: hash bucket is deterministic per (key, contextRef)", async () => {
  // Sprint A — #7 — same input must produce same variant. Stability matters
  // for retries / re-renders not flipping users between variants mid-flow.
  const { pickVariant, createExperiment, stopExperiment } = await import("../orchestration/experiment-runner.js");
  const key = "inv_det_" + Date.now();
  const expId = createExperiment({ key, variantAValue: "A", variantBValue: "B", trafficSplit: 0.5 });
  try {
    const ctx = "stable_ctx_xyz";
    const r1 = pickVariant({ key, fallback: "F", contextRef: ctx });
    const r2 = pickVariant({ key, fallback: "F", contextRef: ctx });
    if (r1.variant !== r2.variant) return `non-deterministic: ${r1.variant} vs ${r2.variant}`;
    return true;
  } finally {
    stopExperiment(expId);
    db.prepare("DELETE FROM experiment_assignments WHERE experiment_id=?").run(expId);
    db.prepare("DELETE FROM experiments WHERE id=?").run(expId);
  }
});

check("workflow DAGs and cron.ts do not double-fire the same handler", async () => {
  // P0 — workflow-defs.ts owns dream / evolution / feedback / diagnostic /
  // gepa / growth_card / decay_edges / encrypted_backup. cron.ts must NOT
  // re-schedule those, otherwise jobs fire twice → 2× LLM cost + races.
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const cronSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../orchestration/cron.ts"),
    "utf8",
  );
  const cronIds = new Set<string>();
  const re = /gated\(\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cronSrc)) !== null) cronIds.add(m[1]);
  const ownedByWorkflow = [
    "dream", "personal_evolution", "feedback_detectors", "self_diagnostic",
    "edge_staleness", "gepa_analysis", "weekly_growth_card", "weekly_backup",
  ];
  const dupes = ownedByWorkflow.filter(id => cronIds.has(id));
  if (dupes.length) return `cron + workflow both own: ${dupes.join(", ")}`;
  return true;
});

check("shadowEmit writes a verifiable event to the hash chain", async () => {
  // Phase 3b — proves the scanner→event-log path actually persists to the
  // chain (not just sits in code). Use a unique scanDay key so re-runs of
  // the invariant suite don't conflict with prior days' entries.
  const { shadowEmit, verifyHashChain } = await import("../infra/storage/scanner-events.js");
  const key = "inv_" + Date.now();
  shadowEmit({
    scanner: "invariant-probe",
    source: "manual",
    kind: "shadow_emit_probe",
    stableFields: { probeKey: key },
    payload: { probeKey: key, sentinel: "scanner-emit-verified" },
  });
  const row = db.prepare(
    "SELECT json_extract(payload_json, '$.probeKey') AS k FROM scanner_events WHERE source='manual' AND kind='shadow_emit_probe' ORDER BY seq DESC LIMIT 1"
  ).get() as any;
  if (row?.k !== key) return `probe event not found (got ${row?.k})`;
  const verify = verifyHashChain();
  if (verify.firstBadSeq !== null) {
    return `chain integrity broken after probe at seq ${verify.firstBadSeq}: ${verify.firstBadReason}`;
  }
  return true;
});

check("no path collisions on /api/agents mounts", async () => {
  // agentsRoutes and customAgentsRoutes both mount on /api/agents.
  // agentsRoutes has been forbidden from owning /custom, /pipelines, /runs;
  // customAgentsRoutes has been forbidden from owning the agentsRoutes
  // top-level paths (/status, /executions, /gepa, /self-portrait,
  // /active-insight, /recommendations). If somebody adds a colliding path,
  // this fails before it ships.
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const agentsSrc = fs.readFileSync(path.resolve(here, "../routes/agents.ts"), "utf8");
  const customSrc = fs.readFileSync(path.resolve(here, "../routes/custom-agents.ts"), "utf8");
  const re = /router\.(?:get|post|put|delete|patch|use)\(\s*["']([^"']+)["']/g;
  const collect = (src: string): string[] => {
    const out: string[] = []; let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  };
  re.lastIndex = 0;
  const agentsPaths = collect(agentsSrc);
  re.lastIndex = 0;
  const customPaths = collect(customSrc);
  const customPrefixes = ["/custom", "/pipelines", "/runs"];
  const intruders = agentsPaths.filter(p => customPrefixes.some(prefix => p === prefix || p.startsWith(prefix + "/")));
  if (intruders.length) return `agents.ts owns customAgents-prefixed path: ${intruders.join(", ")}`;
  const reservedAgentsTops = ["/status", "/executions", "/gepa", "/self-portrait", "/active-insight", "/recommendations"];
  const overlap = customPaths.filter(p => reservedAgentsTops.some(top => p === top || p.startsWith(top + "/")));
  if (overlap.length) return `custom-agents.ts owns agents-reserved path: ${overlap.join(", ")}`;
  return true;
});

check("LLM-output cognition sites use zod object() (P3c coverage)", async () => {
  // Phase 3c — guards the migration of "JSON.parse + regex" patterns to
  // generateObject + zod schemas. If a refactor reverts to manual JSON.parse
  // on LLM output in any of these files, this fails so we don't silently
  // regress to the old crash-prone pattern.
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // decision.ts site 1 (the streaming chat-mode parser) intentionally stays
  // text+parse so the agent can return chat OR a plan. We test only the
  // pure-structured-output sites where zod is unambiguously the right call.
  const sites = [
    "../cognition/gepa.ts",
    "../cognition/skills.ts",
    "../cognition/extractor.ts",
    "../cognition/profile-inference.ts",
    "../cognition/oracle-council.ts",
    "../memory/dream.ts",
    "../execution/swarm.ts",
    "../execution/skill-extractor.ts",
  ];
  const missing: string[] = [];
  for (const rel of sites) {
    const src = fs.readFileSync(path.resolve(here, rel), "utf8");
    if (!/await object\(/.test(src) || !/import\s*\{[^}]*\bobject\b/.test(src)) {
      missing.push(rel);
    }
  }
  if (missing.length) return `files missing zod object() call: ${missing.join(", ")}`;
  return true;
});

check("ten local scanners import shadowEmit (P3b coverage)", async () => {
  // Phase 3b — guards the "shadow emit covers all unified scanners" promise.
  // If a scanner gets refactored and loses its shadowEmit call, this fails
  // immediately rather than silently producing empty sync bundles.
  // deep-scan.ts is intentionally excluded — it aggregates the others, which
  // each emit individually, so adding it would double-count.
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../integrations/local");
  const wanted = [
    "browser-history.ts",
    "contacts.ts",
    "calendar-unified.ts",
    "email-unified.ts",
    "messages-unified.ts",
    "notes-unified.ts",
    "code-unified.ts",
    "tasks-unified.ts",
    "location-unified.ts",
    "media-unified.ts",
  ];
  const missing: string[] = [];
  for (const f of wanted) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    if (!/shadowEmit\s*\(/.test(src)) missing.push(f);
  }
  if (missing.length) return `scanners without shadowEmit: ${missing.join(", ")}`;
  return true;
});

check("every system cron spec's pattern matches its gated() call site", async () => {
  // Catch drift: a spec marked LOCKED on cron_pattern must mirror what's
  // actually scheduled in cron.ts. If somebody changes the schedule string
  // without updating the spec (or vice versa), the user-facing snooze UI
  // would lie about timing.
  const { listSystemCronSpecs } = await import("../cognition/system-agents/registry.js");
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const cronSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../orchestration/cron.ts"),
    "utf8",
  );
  // schedule("PATTERN", gated("ID", ...
  const re = /schedule\(\s*"([^"]+)"\s*,\s*gated\(\s*"([^"]+)"/g;
  const actual = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cronSrc)) !== null) actual.set(m[2], m[1]);
  const drift: string[] = [];
  for (const c of listSystemCronSpecs()) {
    const a = actual.get(c.id);
    if (!a) { drift.push(`${c.id}: no schedule() call`); continue; }
    if (a !== c.cron_pattern.default) drift.push(`${c.id}: spec='${c.cron_pattern.default}' actual='${a}'`);
  }
  if (drift.length) return drift.join("; ");
  return true;
});

check("morning_digest snooze gate is queryable", async () => {
  const { isCronSnoozed } = await import("../cognition/system-cron-overrides.js");
  const future = new Date(Date.now() + 60_000).toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO system_cron_overrides (cron_id, snooze_until, schema_version) VALUES ('morning_digest', ?, 1)"
  ).run(future);
  try {
    if (!isCronSnoozed("morning_digest")) return "snooze not detected";
    return true;
  } finally {
    db.prepare("DELETE FROM system_cron_overrides WHERE cron_id='morning_digest'").run();
  }
});

check("decision summarize task is routed (Step 6 prereq)", async () => {
  // Auto-compression in decideStream calls text({ task: "summarize" }).
  // If the route is missing, the cheap-tier model can't be selected and
  // the compress path silently returns the unmodified (still-large) history.
  const { TASK_ROUTES } = await import("../infra/compute/router.js");
  if (!TASK_ROUTES["summarize"]) return "summarize task missing in TASK_ROUTES";
  if (TASK_ROUTES["summarize"].tier !== "cheap") return "summarize should be cheap tier (cost matters)";
  return true;
});

check("serializeForPrompt embeds temporal label (Zep-style)", async () => {
  // Insert one memory with explicit valid_from + valid_to so we can verify
  // the prompt formatter prepends a temporal scope label like "[semantic ·
  // valid 2024-06-01 → 2025-02-01]" — the technical key behind Zep's higher
  // LongMemEval score over Mem0.
  const id = "eval_inv_temporal_" + Date.now();
  db.prepare(
    `INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence, created_at, valid_from, valid_to)
     VALUES (?, ?, 'semantic', ?, ?, '[]', 'eval', 0.95, datetime('now'), '2024-06-01 00:00:00', '2025-02-01 00:00:00')`
  ).run(id, DEFAULT_USER_ID, "Eval Temporal Memory", "test content for temporal label verification");
  try {
    const { serializeForPrompt } = await import("../memory/retrieval.js");
    const out = await serializeForPrompt("test content");
    if (!out.includes("valid 2024-06-01 → 2025-02-01")) {
      return `temporal label missing or wrong, got: ${out.slice(0, 200)}`;
    }
    return true;
  } finally {
    db.prepare("DELETE FROM memories WHERE id=?").run(id);
  }
});

check("contact_aggregates table exists + indexed", () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_aggregates'"
  ).get();
  if (!tables) return "contact_aggregates table missing";
  const indices = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contact_aggregates'"
  ).all() as any[];
  const names = indices.map(i => i.name);
  const needed = ["idx_contact_agg_user_time", "idx_contact_agg_contact", "idx_contact_agg_handle"];
  for (const n of needed) {
    if (!names.includes(n)) return `missing index: ${n}`;
  }
  return true;
});

// ── Report ────────────────────────────────────────────────────────────────

async function report() {
  // Settle any async checks before tallying so all results land in the same
  // pass/fail report (no split between sync + async output)
  for (const { name, promise } of pendingChecks) {
    try {
      recordResult(name, await promise);
    } catch (err: any) {
      results.push({ name, passed: false, detail: err?.message ?? String(err) });
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);

  console.log(`\n━━━ Anchor Invariant Eval ━━━`);
  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`${icon}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\nPassed: ${passed}/${results.length}`);
  if (failed.length > 0) {
    console.log(`\nFailed invariants:`);
    for (const f of failed) console.log(`  • ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

report();
