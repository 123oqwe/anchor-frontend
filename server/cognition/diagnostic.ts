/**
 * L3 Cognition — Self-Diagnostic Agent.
 *
 * The meta-agent that watches all other agents.
 * Pure SQL + math. Zero LLM calls. Cannot fail due to LLM outage.
 *
 * Week 1-2: OBSERVE — collect baseline, no fixes
 * Week 3+:  DIAGNOSE — compare vs baseline, auto-fix if critical
 * Phase transitions by DATA VOLUME, not calendar date.
 */
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

// ── Config reader (system_config > hardcoded defaults) ─────────────────────

export function getConfig(key: string, defaultValue: string): string {
  const row = db.prepare(
    "SELECT value, expires_at FROM system_config WHERE key=?"
  ).get(key) as any;
  if (!row) return defaultValue;
  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM system_config WHERE key=?").run(key);
    return defaultValue;
  }
  return row.value;
}

export function setConfig(key: string, value: string, source: string, expiresInDays?: number): void {
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;
  db.prepare(
    "INSERT INTO system_config (key, value, source, expires_at, updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, expires_at=excluded.expires_at, updated_at=excluded.updated_at"
  ).run(key, value, source, expiresAt);
}

// ── Alert types ────────────────────────────────────────────────────────────

interface DiagnosticAlert {
  severity: "critical" | "warning" | "info";
  check: string;
  message: string;
  autoFix?: string;
}

interface DiagnosticReport {
  phase: number;
  phaseReason: string;
  totalConversations: number;
  confirmRate: number;
  confirmRateTrend: number; // vs last week: positive = improving
  autoSkills: number;
  evolutionDims: number;
  twinInsights: number;
  memoryUsage: number;
  memoryCapacity: number;
  costPerDay: number;
  activityCaptures24h: number;
  orphanNodeRatio: number;
  alerts: DiagnosticAlert[];
  fixesApplied: string[];
}

// ── Determine phase (by data volume, not date) ─────────────────────────────

function determinePhase(): { phase: number; reason: string } {
  const convos = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE user_id=? AND role='user'").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const signals = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const skills = (db.prepare("SELECT COUNT(*) as c FROM skills WHERE user_id=? AND source IN ('behavior_crystallization','dream_engine')").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const dims = (db.prepare("SELECT COUNT(*) as c FROM evolution_state WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  if (convos >= 150 && skills >= 1 && dims >= 3) {
    return { phase: 3, reason: `${convos} conversations, ${skills} skills, ${dims} dims — ready for advanced optimization` };
  }
  if (convos >= 50 && signals >= 20) {
    return { phase: 2, reason: `${convos} conversations, ${signals} signals — quality assessment phase` };
  }
  return { phase: 1, reason: `${convos} conversations, ${signals} signals — still accumulating data` };
}

// ── Is system in baseline period? (first 2 weeks) ──────────────────────────

function isBaselinePeriod(): boolean {
  const firstMessage = db.prepare(
    "SELECT MIN(created_at) as first FROM messages WHERE user_id=?"
  ).get(DEFAULT_USER_ID) as any;
  if (!firstMessage?.first) return true;
  const daysSinceFirst = (Date.now() - new Date(firstMessage.first).getTime()) / 86400000;
  return daysSinceFirst < 14;
}

// ── Get last week's report for trend comparison ────────────────────────────

function getLastReport(): DiagnosticReport | null {
  const row = db.prepare(
    "SELECT data_json FROM diagnostic_reports ORDER BY created_at DESC LIMIT 1"
  ).get() as any;
  if (!row) return null;
  try { return JSON.parse(row.data_json); } catch { return null; }
}

// ── Core diagnostic checks ─────────────────────────────────────────────────

export function runDiagnostic(): DiagnosticReport {
  const alerts: DiagnosticAlert[] = [];
  const fixesApplied: string[] = [];
  const { phase, reason } = determinePhase();
  const baseline = isBaselinePeriod();
  const lastReport = getLastReport();

  // Q1: Decision quality
  const confirms = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=? AND signal_type='plan_confirmed' AND created_at >= datetime('now','-7 days')").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const rejects = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=? AND signal_type='plan_rejected' AND created_at >= datetime('now','-7 days')").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const totalDecisions = confirms + rejects;
  const confirmRate = totalDecisions > 0 ? Math.round((confirms / totalDecisions) * 100) : -1; // -1 = no data
  const confirmRateTrend = lastReport && lastReport.confirmRate >= 0 && confirmRate >= 0
    ? confirmRate - lastReport.confirmRate : 0;

  if (!baseline && confirmRate >= 0 && confirmRate < 20 && totalDecisions >= 5) {
    alerts.push({ severity: "critical", check: "Q1_DECISION_QUALITY", message: `Confirm rate ${confirmRate}% — system suggestions may not be useful` });
  } else if (!baseline && confirmRate >= 20 && confirmRate < 50 && totalDecisions >= 5) {
    alerts.push({ severity: "warning", check: "Q1_DECISION_QUALITY", message: `Confirm rate ${confirmRate}% — system is learning but not great yet` });
  }

  // Q2: Skills crystallization
  const autoSkills = (db.prepare("SELECT COUNT(*) as c FROM skills WHERE user_id=? AND source IN ('behavior_crystallization','dream_engine')").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const recentConfirms = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=? AND signal_type='plan_confirmed' AND created_at >= datetime('now','-14 days')").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  if (!baseline && recentConfirms > 10 && autoSkills === 0) {
    alerts.push({ severity: "warning", check: "Q2_SKILLS", message: `${recentConfirms} plans confirmed but 0 skills crystallized — threshold may be too high` });
    if (phase >= 2) {
      const currentMin = parseInt(getConfig("skill_crystallize_min", "3"));
      if (currentMin > 2) {
        setConfig("skill_crystallize_min", "2", "diagnostic", 7);
        fixesApplied.push("Lowered skill_crystallize_min: 3 → 2 (expires in 7 days)");
      }
    }
  }

  // Q3: Evolution Engine
  const evolutionDims = (db.prepare("SELECT COUNT(*) as c FROM evolution_state WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const signals7d = (db.prepare("SELECT COUNT(*) as c FROM satisfaction_signals WHERE user_id=? AND created_at >= datetime('now','-7 days')").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  if (!baseline && evolutionDims === 0 && signals7d > 5) {
    alerts.push({ severity: "warning", check: "Q3_EVOLUTION", message: `Evolution Engine has 0 dimensions despite ${signals7d} signals — may be stalled` });
    if (phase >= 2) {
      setConfig("evolution_min_signals", "1", "diagnostic", 7);
      fixesApplied.push("Lowered evolution_min_signals: 2 → 1 (expires in 7 days)");
    }
  }

  // Q4: Twin learning
  const twinInsights = (db.prepare("SELECT COUNT(*) as c FROM twin_insights WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const recentInsight = db.prepare("SELECT MAX(created_at) as last FROM twin_insights WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  const insightDaysAgo = recentInsight?.last ? (Date.now() - new Date(recentInsight.last).getTime()) / 86400000 : 999;

  if (!baseline && twinInsights === 0 && phase >= 2) {
    alerts.push({ severity: "warning", check: "Q4_TWIN", message: "Twin has 0 insights — behavioral learning not happening" });
  } else if (!baseline && insightDaysAgo > 14 && twinInsights > 0) {
    alerts.push({ severity: "info", check: "Q4_TWIN", message: `Twin's last insight was ${Math.round(insightDaysAgo)} days ago` });
  }

  // Q5: Graph quality (with root cause)
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const orphanNodes = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes n WHERE n.user_id=? AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.from_node_id=n.id OR e.to_node_id=n.id)").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const orphanRatio = totalNodes > 0 ? Math.round((orphanNodes / totalNodes) * 100) : 0;

  if (!baseline && orphanRatio > 60 && totalNodes > 20) {
    // Root cause: who created the orphans?
    const topSource = db.prepare("SELECT captured, COUNT(*) as cnt FROM graph_nodes n WHERE n.user_id=? AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.from_node_id=n.id OR e.to_node_id=n.id) GROUP BY captured ORDER BY cnt DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
    const source = topSource?.captured ?? "unknown";
    alerts.push({ severity: "critical", check: "Q5_GRAPH", message: `${orphanRatio}% orphan nodes (${orphanNodes}/${totalNodes}). Main source: "${source}"` });
  }

  // Q6: Memory capacity
  const memoryTotal = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const memoryCapacity = 200;

  if (memoryTotal > 190) {
    alerts.push({ severity: "critical", check: "Q6_MEMORY", message: `Memory at ${memoryTotal}/${memoryCapacity} (${Math.round(memoryTotal/memoryCapacity*100)}%) — approaching limit` });
  } else if (memoryTotal > 150) {
    alerts.push({ severity: "warning", check: "Q6_MEMORY", message: `Memory at ${memoryTotal}/${memoryCapacity}` });
  }

  // Q7: Cost per active day
  const costData = db.prepare("SELECT SUM(cost_usd) as total, COUNT(DISTINCT date(created_at)) as days FROM llm_calls WHERE created_at >= datetime('now','-7 days')").get() as any;
  const costPerDay = costData?.days > 0 ? (costData.total ?? 0) / costData.days : 0;

  if (!baseline && costPerDay > 2.0) {
    alerts.push({ severity: "critical", check: "Q7_COST", message: `$${costPerDay.toFixed(2)}/active day — consider model downgrades` });
  } else if (!baseline && costPerDay > 0.5) {
    alerts.push({ severity: "warning", check: "Q7_COST", message: `$${costPerDay.toFixed(2)}/active day` });
  }

  // Q8: Activity Monitor
  const captures24h = (db.prepare("SELECT COUNT(*) as c FROM activity_captures WHERE user_id=? AND captured_at >= datetime('now','-24 hours')").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  if (captures24h === 0) {
    alerts.push({ severity: "info", check: "Q8_ACTIVITY", message: "Activity Monitor: 0 captures in 24h — may need macOS Accessibility permission" });
  }

  // Q9: Check if user is inactive (for auto-suspend)
  const lastUserMsg = db.prepare("SELECT MAX(created_at) as last FROM messages WHERE user_id=? AND role='user'").get(DEFAULT_USER_ID) as any;
  const inactiveDays = lastUserMsg?.last ? (Date.now() - new Date(lastUserMsg.last).getTime()) / 86400000 : 0;

  // Sort alerts by severity
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // GEPA readiness (Phase 3)
  const totalConvos = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE user_id=? AND role='user'").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (phase >= 3) {
    const gepaReady = totalConvos >= 100 && autoSkills >= 1 && evolutionDims >= 3;
    if (gepaReady) {
      alerts.push({ severity: "info", check: "GEPA_READY", message: `System ready for GEPA prompt evolution (${totalConvos} sessions, ${autoSkills} skills, ${evolutionDims} dims)` });
    }
  }

  const report: DiagnosticReport = {
    phase,
    phaseReason: reason,
    totalConversations: totalConvos,
    confirmRate,
    confirmRateTrend,
    autoSkills,
    evolutionDims,
    twinInsights,
    memoryUsage: memoryTotal,
    memoryCapacity,
    costPerDay: Math.round(costPerDay * 100) / 100,
    activityCaptures24h: captures24h,
    orphanNodeRatio: orphanRatio,
    alerts,
    fixesApplied,
  };

  // Save report
  db.prepare(
    "INSERT INTO diagnostic_reports (id, phase, data_json, alerts_json, fixes_applied_json) VALUES (?,?,?,?,?)"
  ).run(nanoid(), phase, JSON.stringify(report), JSON.stringify(alerts), JSON.stringify(fixesApplied));

  // Update heartbeat
  setConfig("diagnostic_last_run", new Date().toISOString(), "diagnostic");

  logExecution("Diagnostic Agent", `Phase ${phase}: ${alerts.filter(a=>a.severity==="critical").length} critical, ${alerts.filter(a=>a.severity==="warning").length} warning, ${fixesApplied.length} fixes`);

  // Push notification if critical alerts
  const criticals = alerts.filter(a => a.severity === "critical");
  if (criticals.length > 0) {
    try {
      const { bus } = require("../orchestration/bus.js");
      bus.publish({ type: "NOTIFICATION", payload: { title: "Diagnostic Alert", body: criticals.map(a => a.message).join("; "), priority: "high" } });
    } catch {}
  }

  return report;
}
