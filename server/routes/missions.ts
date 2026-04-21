/**
 * /api/missions — reconstruct multi-agent missions from mission_kv + runs.
 *
 * A mission is a group of Custom Agent runs that share a mission_id. Top-level
 * runId usually IS the missionId; handoffs / delegates append suffixes but
 * inherit the mission scope. This route joins mission_kv (shared blackboard)
 * with agent_executions / llm_calls to reconstruct the swarm trace.
 */
import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";

const router = Router();

/** List missions: anything with at least one blackboard key or a handoff/sub chain. */
router.get("/", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);

  // Mission IDs we know about — from mission_kv (user-written blackboard) +
  // runs that have a handoff/sub suffix (mission inferred from the root).
  const kvMissions = db.prepare(
    `SELECT mission_id, COUNT(*) as keyCount, MAX(updated_at) as ts
       FROM mission_kv GROUP BY mission_id ORDER BY ts DESC LIMIT ?`
  ).all(limit) as any[];

  const missions = kvMissions.map((m) => {
    // Find runs that belong to this mission. Root = missionId; children match prefix.
    const runs = db.prepare(
      `SELECT run_id, agent, action, status, created_at
         FROM agent_executions
       WHERE user_id=? AND run_id IS NOT NULL
         AND (run_id = ? OR run_id LIKE ? OR run_id LIKE ?)
       ORDER BY created_at ASC`
    ).all(DEFAULT_USER_ID, m.mission_id, `${m.mission_id}-handoff-%`, `${m.mission_id}-sub-%`) as any[];

    const uniqueAgents = new Set(runs.map((r: any) => r.agent).filter(Boolean));
    return {
      missionId: m.mission_id,
      blackboardKeys: m.keyCount,
      agentCount: uniqueAgents.size,
      runCount: runs.length,
      lastActivity: m.ts,
      startedAt: runs[0]?.created_at ?? m.ts,
      agents: Array.from(uniqueAgents),
    };
  });

  res.json(missions);
});

/** Detail: all blackboard state + all runs + reconstructed handoff chain. */
router.get("/:id", (req, res) => {
  const missionId = req.params.id;

  // Blackboard (ordered by most-recently written first for recency feel)
  const blackboard = db.prepare(
    "SELECT key, value, updated_at FROM mission_kv WHERE mission_id=? ORDER BY updated_at DESC"
  ).all(missionId) as any[];

  // All runs in this mission (root + handoff suffixed + sub suffixed)
  const runs = db.prepare(
    `SELECT run_id, agent, action, status, created_at
       FROM agent_executions
     WHERE user_id=? AND run_id IS NOT NULL
       AND (run_id = ? OR run_id LIKE ? OR run_id LIKE ?)
     ORDER BY created_at ASC`
  ).all(DEFAULT_USER_ID, missionId, `${missionId}-handoff-%`, `${missionId}-sub-%`) as any[];

  // Group runs by run_id — each becomes a "participant"
  const byRunId = new Map<string, any>();
  for (const r of runs) {
    if (!byRunId.has(r.run_id)) {
      byRunId.set(r.run_id, {
        runId: r.run_id,
        agent: r.agent,
        startedAt: r.created_at,
        execs: [],
        kind: r.run_id === missionId ? "root" : (r.run_id.includes("-handoff-") ? "handoff" : "sub"),
        parent: inferParent(r.run_id, missionId),
      });
    }
    byRunId.get(r.run_id)!.execs.push({
      agent: r.agent, action: r.action, status: r.status, ts: r.created_at,
    });
  }

  // Fetch LLM call counts per run
  byRunId.forEach((p) => {
    const llm = db.prepare(
      "SELECT COUNT(*) as n, SUM(latency_ms) as total_ms, SUM(input_tokens) as inTok, SUM(output_tokens) as outTok FROM llm_calls WHERE run_id=?"
    ).get(p.runId) as any;
    p.llmCalls = llm?.n ?? 0;
    p.totalLatencyMs = llm?.total_ms ?? 0;
    p.inTok = llm?.inTok ?? 0;
    p.outTok = llm?.outTok ?? 0;
  });

  const participants = Array.from(byRunId.values()).sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? "")
  );

  res.json({
    missionId,
    blackboard,
    participants,
    stats: {
      agentCount: new Set(participants.map(p => p.agent)).size,
      handoffCount: participants.filter(p => p.kind === "handoff").length,
      subagentCount: participants.filter(p => p.kind === "sub").length,
      totalLlmCalls: participants.reduce((s, p) => s + (p.llmCalls ?? 0), 0),
      totalLatencyMs: participants.reduce((s, p) => s + (p.totalLatencyMs ?? 0), 0),
    },
  });
});

/** Given a child runId, guess its parent runId by stripping the last suffix. */
function inferParent(runId: string, missionId: string): string | null {
  if (runId === missionId) return null;
  // Child runIds look like: <parent>-handoff-xxx or <parent>-sub-xxx
  const m = runId.match(/^(.+)-(handoff|sub)-[a-zA-Z0-9_-]+$/);
  return m?.[1] ?? missionId;
}

export default router;
