/**
 * L1 Human Graph — Ontology.
 *
 * Defines what Anchor understands "a person" to be.
 * This is NOT a database schema. It is the canonical truth structure
 * that every other layer references when it needs to understand the user.
 */

// ── Node Types — every entity in a user's life ─────────────────────────────

export type NodeType =
  | "identity"           // Who the user is (name, role, bio)
  | "goal"               // What they're pursuing (long-term)
  | "project"            // What they're working on (bounded)
  | "commitment"         // What they've promised to do
  | "task"               // Concrete action item
  | "person"             // Someone in their life
  | "relationship"       // Nature of a connection to a person
  | "value"              // What they care about deeply
  | "constraint"         // What limits them (time, money, rules)
  | "preference"         // How they like things done
  | "routine"            // Recurring patterns / habits
  | "state"              // Current condition (energy, stress, focus)
  | "risk"               // Something that could go wrong
  | "opportunity"        // Something that could go right
  | "decision"           // A choice made or pending
  | "resource"           // Time, money, energy, attention
  | "artifact"           // Documents, spaces, tools
  | "observation"        // A system-recorded behavioral event
  | "outcome"            // Result of a past action
  | "behavioral_pattern" // Detected recurring behavior
  | "external_context";  // External events affecting the user

// ── Edge Types — relationships between nodes ────────────────────────────────

export type EdgeType =
  | "depends_on"         // A requires B to be done first
  | "blocks"             // A prevents B from progressing
  | "aligns_with"        // A is consistent with B's values/goals
  | "conflicts_with"     // A contradicts B
  | "owned_by"           // A belongs to person/project B
  | "temporal"           // A happens before/after B
  | "causal"             // A caused B
  | "contextual"         // A is relevant in the context of B
  | "supports"           // A helps accomplish B
  | "threatens";         // A puts B at risk

// ── Node structure ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: NodeType;
  domain: string;          // work | relationships | finance | health | growth | ...
  label: string;           // human-readable name
  status: string;          // active | done | delayed | blocked | decaying | ...
  detail: string;          // freeform description
  captured: string;        // how/when this was captured
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: EdgeType;
  weight?: number;         // 0-1 strength of relationship
  metadata?: string;       // optional JSON context
}

// ── Domain — thematic grouping of nodes ─────────────────────────────────────

export type Domain = "work" | "relationships" | "finance" | "health" | "growth";

export const DOMAIN_META: Record<Domain, { name: string; icon: string }> = {
  work:          { name: "Work & Career",   icon: "Briefcase" },
  relationships: { name: "Relationships",   icon: "Users" },
  finance:       { name: "Finance",         icon: "DollarSign" },
  health:        { name: "Health & Energy", icon: "Heart" },
  growth:        { name: "Personal Growth", icon: "TrendingUp" },
};

// ── Stability classification ────────────────────────────────────────────────

export type Stability = "stable" | "volatile" | "decaying";

// ── Temporal semantics ──────────────────────────────────────────────────────

/** Time horizon of a node — is this about now, the past, or the future? */
export type TemporalHorizon = "current" | "historical" | "future" | "recurring";

/** Truth boundary — how certain is this information? */
export type TruthBoundary = "confirmed" | "inferred" | "reported" | "speculative";

export const NODE_TEMPORAL_DEFAULTS: Record<NodeType, TemporalHorizon> = {
  identity: "current",
  value: "current",
  preference: "current",
  routine: "recurring",
  relationship: "current",
  behavioral_pattern: "current",
  goal: "future",
  constraint: "current",
  person: "current",
  resource: "current",
  state: "current",
  task: "future",
  commitment: "future",
  project: "current",
  decision: "historical",
  risk: "future",
  opportunity: "future",
  observation: "historical",
  outcome: "historical",
  artifact: "current",
  external_context: "current",
};

/** Which node types are long-lived vs short-lived. */
export const NODE_STABILITY: Record<NodeType, Stability> = {
  identity:           "stable",
  value:              "stable",
  preference:         "stable",
  routine:            "stable",
  relationship:       "stable",
  behavioral_pattern: "stable",
  goal:               "stable",
  constraint:         "stable",
  person:             "stable",
  resource:           "volatile",
  state:              "volatile",
  task:               "volatile",
  commitment:         "volatile",
  project:            "volatile",
  decision:           "volatile",
  risk:               "volatile",
  opportunity:        "volatile",
  observation:        "volatile",
  outcome:            "volatile",
  artifact:           "stable",
  external_context:   "volatile",
};
