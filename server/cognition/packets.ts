/**
 * L3 Cognition — Typed Cognitive Packets.
 *
 * Structured handoff types between cognitive components.
 * Replaces free-form JSON passing between agents.
 * From spec: cognitive-packets.ts
 */

// ── Context Packet — assembled by Orchestration, consumed by Decision Agent ──

export interface ContextPacket {
  graphSlice: string;            // serialized graph nodes + edges
  memorySlice: string;           // serialized relevant memories
  twinPriors: TwinPriorPacket | null;
  userState: string;             // energy/focus/stress
  conversationHistory: { role: "user" | "assistant"; content: string }[];
  userMessage: string;
}

// ── Twin Prior Packet — produced by Twin Agent ──────────────────────────────

export interface TwinPriorDimension {
  category: string;
  insight: string;
  confidence: number;
  decayStatus: "fresh" | "stable" | "decaying";
  evidenceCount?: number;
}

export interface TwinPriorPacket {
  stablePreferences: TwinPriorDimension[];
  inferredTendencies: TwinPriorDimension[];
  driftMarkers: TwinPriorDimension[];
  contraindications: string[];   // things the system should NOT suggest
}

// ── Decision Packet — produced by Decision Agent ────────────────────────────

export interface DecisionCandidate {
  id: number;
  content: string;
  timeEstimate?: string;
  riskSignals: string[];
  referencedNodes: string[];
}

export interface DecisionPacket {
  type: "plan" | "advice";
  suggestionSummary: string;
  reasoning: string;
  whyThisNow: string;           // explanation of urgency/timing
  candidates: DecisionCandidate[];
  riskLevel: "low" | "medium" | "high";
  boundaryClassification: "advisory_only" | "draft_candidate" | "approval_required";
  conflictFlags: string[];       // unresolved tensions
  confidenceScore: number;       // 0-1 how sure the agent is
  stagesTrace: StageTrace[];     // record of each reasoning stage
}

// ── Stage Trace — records what happened at each stage of the pipeline ────────

export interface StageTrace {
  stage: "constraint_extraction" | "option_generation" | "twin_alignment" | "boundary_classification" | "delta_selection";
  input: string;
  output: string;
  durationMs?: number;
}

// ── Planning Packet — produced by Small Swarm ───────────────────────────────

export interface PlanCandidate {
  planId: string;
  stages: string[];
  dependencies: string[];
  assumptions: string[];
  risks: string[];
  conflicts: string[];
  recommended: boolean;
  rejectionReasons?: string[];
}

export interface PlanningPacket {
  candidatePlans: PlanCandidate[];
  riskConflictMap: { riskId: string; severity: "low" | "medium" | "high" | "critical"; mitigation?: string }[];
  unresolvedQuestions: string[];
  plannerDisagreements: { topic: string; positions: { role: string; position: string }[]; resolved: boolean }[];
  boundaryClassification: "advisory_only" | "draft_candidate" | "approval_required";
}
