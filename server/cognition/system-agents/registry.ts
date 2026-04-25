/**
 * Registry of all 11 system agent specs + system cron specs.
 *
 * 1 agent (Twin) is fully wired — its runtime uses composeSystemAgentConfig.
 * 10 agents are documentary_only — spec exposes Soul/Body/Faculty for UI +
 * vitality + future migration, but their runtime in cognition/<id>.ts still
 * uses inline prompts. The `documentary_only` flag in each spec makes
 * this explicit (no false framework — UI shows the truth).
 *
 * Migration path: as each documentary agent's prompt stabilizes, flip
 * documentary_only to false and wire the runtime to call composer.
 */

import type { SystemAgentSpec, SystemCronSpec } from "../agent-spec.js";

import { TwinAgentSpec } from "./twin.js";
import { DecisionAgentSpec } from "./decision.js";
import { OracleCouncilSpec } from "./oracle-council.js";
import { DreamSpec } from "./dream.js";
import { GepaSpec } from "./gepa.js";
import { EvolutionSpec } from "./evolution.js";
import { DiagnosticSpec } from "./diagnostic.js";
import { FeedbackSpec } from "./feedback.js";
import { ProfileInferenceSpec } from "./profile-inference.js";
import { ObservationSpec } from "./observation.js";
import { SwarmSpec } from "./swarm.js";
import { SkillsSpec } from "./skills.js";

import { MorningDigestCronSpec } from "./morning-digest.js";
import { DecayCheckerCronSpec } from "./decay-checker.js";
import { TwinWeeklyReflectionCronSpec } from "./twin-weekly-reflection.js";
import { StaleTaskDetectorCronSpec } from "./stale-task-detector.js";
import { IngestionPipelineCronSpec } from "./ingestion-pipeline.js";
import { ProactiveCheckCronSpec } from "./proactive-check.js";
import { ActivityCaptureCronSpec } from "./activity-capture.js";
import { GraphUpdateActivityCronSpec } from "./graph-update-activity.js";
import { SqliteBackupCronSpec } from "./sqlite-backup.js";
import { SystemEvolutionCronSpec } from "./system-evolution.js";
// Removed: dream / personal_evolution / feedback_detectors / self_diagnostic /
// edge_staleness / gepa_analysis / weekly_growth_card / weekly_backup —
// owned by workflow DAGs in workflow-defs.ts.

const AGENTS: SystemAgentSpec[] = [
  TwinAgentSpec,             // ⚙️ wired
  DecisionAgentSpec,         // 📄 documentary
  OracleCouncilSpec,         // 📄 documentary
  DreamSpec,                 // 📄 documentary
  GepaSpec,                  // 📄 documentary
  EvolutionSpec,             // 📄 documentary
  DiagnosticSpec,            // 📄 documentary
  FeedbackSpec,              // 📄 documentary
  ProfileInferenceSpec,      // 📄 documentary
  ObservationSpec,           // 📄 documentary
  SwarmSpec,                 // 📄 documentary
  SkillsSpec,                // 📄 documentary
];

const CRONS: SystemCronSpec[] = [
  MorningDigestCronSpec,
  DecayCheckerCronSpec,
  TwinWeeklyReflectionCronSpec,
  StaleTaskDetectorCronSpec,
  IngestionPipelineCronSpec,
  ProactiveCheckCronSpec,
  ActivityCaptureCronSpec,
  GraphUpdateActivityCronSpec,
  SqliteBackupCronSpec,
  SystemEvolutionCronSpec,
];

export function listSystemAgentSpecs(): SystemAgentSpec[] { return [...AGENTS]; }
export function listSystemCronSpecs(): SystemCronSpec[] { return [...CRONS]; }

export function getSystemAgentSpec(id: string): SystemAgentSpec | null {
  return AGENTS.find(a => a.id === id) ?? null;
}
export function getSystemCronSpec(id: string): SystemCronSpec | null {
  return CRONS.find(c => c.id === id) ?? null;
}
