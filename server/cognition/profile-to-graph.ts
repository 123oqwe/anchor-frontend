/**
 * Profile → Graph Bridge.
 *
 * Decomposes an InferredProfile (JSON blob) into concrete Human Graph
 * nodes + edges so the graph becomes the system of record for identity,
 * relationships, active interests, and tensions — not just a separate
 * character-sheet floating next to it.
 *
 * Called after inferProfile() runs. Idempotent — safe to re-run; existing
 * nodes get updated in place, existing profile-sourced edges are replaced.
 *
 *   profile.identity                → identity node (one per user)
 *   profile.key_relationships[]     → person nodes + contextual edges weighted by strength
 *   profile.active_interests[]      → project/goal nodes with phase→status mapping
 *   profile.tensions[]              → conflicts_with edges between referenced nodes
 */
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import {
  transact, createNode, createEdge, replaceEdgeVersion,
  updateNodeStatus, updateNodeDetail,
} from "../graph/writer.js";
import { getNodesByType } from "../graph/reader.js";
import type { NodeType } from "../graph/ontology.js";
import type { InferredProfile } from "./profile-inference.js";

const PROFILE_SOURCE = "profile-inference";

export interface ProfileGraphResult {
  identityNodeId: string;
  personNodes: Array<{ id: string; label: string; strength: number; created: boolean }>;
  interestNodes: Array<{ id: string; label: string; phase: string; created: boolean }>;
  valueNodes: Array<{ id: string; label: string; stated: boolean; created: boolean }>;
  tensionEdges: Array<{ id: string; description: string; fromLabel: string; toLabel: string }>;
  stats: {
    nodesCreated: number;
    nodesUpdated: number;
    edgesCreated: number;
    edgesReplaced: number;
  };
}

// ── identity ─────────────────────────────────────────────────────────────

function ensureIdentityNode(profile: InferredProfile): { id: string; created: boolean } {
  const existing = getNodesByType("identity");
  const detail = [
    profile.identity.primary_role,
    profile.identity.secondary_roles.length > 0
      ? `Also: ${profile.identity.secondary_roles.join(" · ")}`
      : "",
    profile.identity.cohort_tags.length > 0
      ? `Cohort: ${profile.identity.cohort_tags.join(" · ")}`
      : "",
    profile.cultural_context.nuance ? `Context: ${profile.cultural_context.nuance}` : "",
  ].filter(Boolean).join("\n");

  if (existing.length > 0) {
    updateNodeDetail(existing[0].id, detail);
    updateNodeStatus(existing[0].id, "active");
    return { id: existing[0].id, created: false };
  }
  const id = createNode({
    domain: "growth",
    label: "me",
    type: "identity",
    status: "active",
    captured: PROFILE_SOURCE,
    detail,
  });
  return { id, created: true };
}

// ── relationships → person nodes + contextual edges ───────────────────────

function normalizeLabel(label: string): string {
  return label.toLowerCase().trim().replace(/\s+/g, " ");
}

// 0-1 weight from LLM output. The schema claims 0-100 but the LLM often emits
// 0-1, so tolerate both: values ≤ 1.0 are treated as already-normalized.
function toWeight(raw: number): number {
  if (!Number.isFinite(raw)) return 0.5;
  const n = raw > 1.0 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, n));
}

// Keyword-overlap fuzzy match so reruns with slightly-different labels
// ("Anchor AI OS" vs "Building Anchor OS — AI agent OS product") collapse
// to one node instead of growing the graph on each inference.
const NOISE_WORDS = new Set([
  "the","and","for","with","from","this","that","have","are","was",
  "a","an","of","in","on","to","by","be","is","as","at","or","but",
  "building","active","current","user","system","project","product",
  "development","platform","research","study","practice","work","app","apps",
  // Shared connector words across common multi-word labels; without these
  // "async-first" fuzzy-matches "local-first" just via "first".
  "first","second","third","over","under","into","onto","more","less","most","least",
]);

function keywords(label: string): Set<string> {
  const out = new Set<string>();
  for (const w of label.toLowerCase().split(/[\s\-_\/,.:;()\[\]]+/)) {
    const clean = w.replace(/[^\w\u4e00-\u9fff]/g, "");
    if (clean.length >= 4 && !NOISE_WORDS.has(clean)) out.add(clean);
  }
  return out;
}

function fuzzyMatch(candidate: string, existing: string): boolean {
  const a = keywords(candidate), b = keywords(existing);
  if (a.size === 0 || b.size === 0) return false;
  let hits = 0;
  a.forEach(k => { if (b.has(k)) hits++; });
  // Require at least 2 absolute overlaps OR 60% of the smaller set — guards
  // against false-positive merges on a single shared token (e.g. "first",
  // "over") between otherwise-unrelated values.
  if (hits < 2) return false;
  const min = Math.min(a.size, b.size);
  return hits / min >= 0.6;
}

function syncRelationships(profile: InferredProfile, identityId: string) {
  const existing = getNodesByType("person");
  const byLabel = new Map(existing.map(n => [normalizeLabel(n.label), n]));
  const results: ProfileGraphResult["personNodes"] = [];

  for (const rel of profile.key_relationships) {
    const key = normalizeLabel(rel.identifier);
    if (!key) continue;
    let personId: string;
    let created = false;
    const detail = `${rel.role_hypothesis}\nEvidence: ${rel.evidence}`;

    if (byLabel.has(key)) {
      personId = byLabel.get(key)!.id;
      updateNodeDetail(personId, detail);
    } else {
      personId = createNode({
        domain: "relationships",
        label: rel.identifier,
        type: "person",
        status: "active",
        captured: PROFILE_SOURCE,
        detail,
      });
      byLabel.set(key, { ...existing[0], id: personId, label: rel.identifier } as any);
      created = true;
    }

    // Idempotent edge: delete existing profile-sourced edge, create fresh
    replaceProfileEdge(identityId, personId, "contextual", {
      weight: toWeight(rel.relationship_strength),
      role: rel.role_hypothesis,
    });

    results.push({ id: personId, label: rel.identifier, strength: rel.relationship_strength, created });
  }
  return results;
}

// ── interests → project/goal nodes + supports edges ───────────────────────

const PHASE_TO_STATUS: Record<string, string> = {
  "active-executing": "active",
  learning: "active",
  exploring: "active",
  fading: "decaying",
  dormant: "decaying",
};
const PHASE_TO_TYPE: Record<string, NodeType> = {
  "active-executing": "project",
  learning: "goal",
  exploring: "goal",
  fading: "project",
  dormant: "project",
};

function syncInterests(profile: InferredProfile, identityId: string) {
  // Merge existing project + goal nodes for de-dup
  const existing = [...getNodesByType("project"), ...getNodesByType("goal")];
  const byLabel = new Map(existing.map(n => [normalizeLabel(n.label), n]));
  const results: ProfileGraphResult["interestNodes"] = [];

  for (const interest of profile.active_interests) {
    const key = normalizeLabel(interest.area);
    if (!key) continue;
    const status = PHASE_TO_STATUS[interest.phase] ?? "active";
    const type = PHASE_TO_TYPE[interest.phase] ?? "project";
    const detail = `[${interest.phase}] ${interest.evidence}`;

    let nodeId: string;
    let created = false;
    let matchedNode = byLabel.get(key);
    // Fuzzy fallback: if exact-label miss, try keyword-overlap match.
    // The LLM rewords projects each inference ("Anchor AI OS" vs "Building
    // Anchor OS — AI agent platform") so exact-match alone grows the graph
    // on every rerun.
    if (!matchedNode) {
      for (const n of existing) {
        if (fuzzyMatch(interest.area, n.label)) { matchedNode = n; break; }
      }
    }

    if (matchedNode) {
      nodeId = matchedNode.id;
      updateNodeDetail(nodeId, detail);
      updateNodeStatus(nodeId, status);
    } else {
      nodeId = createNode({
        domain: "work",
        label: interest.area,
        type,
        status,
        captured: PROFILE_SOURCE,
        detail,
      });
      existing.push({ id: nodeId, label: interest.area } as any);
      byLabel.set(key, { id: nodeId, label: interest.area } as any);
      created = true;
    }

    replaceProfileEdge(identityId, nodeId, "supports", {
      weight: interest.phase === "active-executing" ? 1.0 : interest.phase === "learning" ? 0.8 : 0.5,
      phase: interest.phase,
    });

    results.push({ id: nodeId, label: interest.area, phase: interest.phase, created });
  }
  return results;
}

// ── values → value nodes + aligns_with edges ─────────────────────────────

function syncValues(profile: InferredProfile, identityId: string) {
  const incoming = profile.values ?? [];
  const existing = getNodesByType("value");
  const byLabel = new Map(existing.map(n => [normalizeLabel(n.label), n]));
  const results: Array<{ id: string; label: string; stated: boolean; created: boolean }> = [];

  for (const v of incoming) {
    const name = (v.name ?? "").trim();
    if (!name) continue;
    const key = normalizeLabel(name);
    const detail = [
      `source: ${v.stated_vs_inferred}`,
      `confidence: ${v.confidence?.toFixed?.(2) ?? "?"}`,
      `evidence: ${v.evidence ?? "(none)"}`,
    ].join("\n");

    let nodeId: string;
    let created = false;
    let matched = byLabel.get(key);
    if (!matched) {
      for (const n of existing) {
        if (fuzzyMatch(name, n.label)) { matched = n; break; }
      }
    }
    if (matched) {
      nodeId = matched.id;
      updateNodeDetail(nodeId, detail);
      updateNodeStatus(nodeId, "active");
    } else {
      nodeId = createNode({
        domain: "growth",
        label: name.slice(0, 80),
        type: "value",
        status: "active",
        captured: PROFILE_SOURCE,
        detail,
      });
      existing.push({ id: nodeId, label: name } as any);
      byLabel.set(key, { id: nodeId, label: name } as any);
      created = true;
    }

    replaceProfileEdge(identityId, nodeId, "aligns_with", {
      weight: Math.max(0.3, Math.min(1.0, v.confidence ?? 0.6)),
      stated_vs_inferred: v.stated_vs_inferred,
    });

    results.push({ id: nodeId, label: name, stated: v.stated_vs_inferred === "stated", created });
  }
  return results;
}

// ── tensions → conflicts_with edges ──────────────────────────────────────

function syncTensions(
  profile: InferredProfile,
  persons: ProfileGraphResult["personNodes"],
  interests: ProfileGraphResult["interestNodes"]
): ProfileGraphResult["tensionEdges"] {
  const allNodes = [
    ...persons.map(p => ({ id: p.id, label: p.label })),
    ...interests.map(i => ({ id: i.id, label: i.label })),
  ];
  const results: ProfileGraphResult["tensionEdges"] = [];

  for (const tension of profile.tensions) {
    const desc = (tension.description + " " + tension.evidence).toLowerCase();
    const matched = allNodes.filter(n => n.label.length >= 3 && desc.includes(n.label.toLowerCase()));
    if (matched.length < 2) continue;

    // Create conflict edge between the first two matched distinct nodes
    const [a, b] = [matched[0], matched[1]];
    if (a.id === b.id) continue;

    // Soft-close any prior profile-sourced conflict edge between these two
    // nodes (in either direction), then open a new version. Preserves history.
    db.prepare(
      `UPDATE graph_edges SET valid_to=datetime('now')
       WHERE user_id=? AND type='conflicts_with' AND valid_to IS NULL
         AND ((from_node_id=? AND to_node_id=?) OR (from_node_id=? AND to_node_id=?))
         AND metadata LIKE ?`
    ).run(DEFAULT_USER_ID, a.id, b.id, b.id, a.id, `%"source":"${PROFILE_SOURCE}"%`);

    const edgeId = createEdge(
      a.id, b.id, "conflicts_with", 0.7,
      JSON.stringify({ source: PROFILE_SOURCE, tension: tension.description.slice(0, 200) }),
    );
    results.push({ id: edgeId, description: tension.description, fromLabel: a.label, toLabel: b.label });
  }
  return results;
}

// ── Idempotent edge helper ───────────────────────────────────────────────

function replaceProfileEdge(
  fromId: string,
  toId: string,
  type: string,
  extra: { weight: number } & Record<string, any>,
): string {
  const { weight, ...rest } = extra;
  const metadata = JSON.stringify({ source: PROFILE_SOURCE, ...rest });
  // Soft-close: the prior active edge gets valid_to stamped so its evolution
  // is preserved in graph_edges history rather than hard-deleted.
  return replaceEdgeVersion(fromId, toId, type, weight, metadata);
}

// ── Main ─────────────────────────────────────────────────────────────────

export function profileToGraph(profile: InferredProfile): ProfileGraphResult {
  // Only count currently-active profile edges — historical (soft-closed)
  // rows accumulate and shouldn't inflate the "replaced" diagnostic.
  const before = db.prepare(
    `SELECT COUNT(*) as c FROM graph_edges
     WHERE user_id=? AND valid_to IS NULL AND metadata LIKE ?`
  ).get(DEFAULT_USER_ID, `%"source":"${PROFILE_SOURCE}"%`) as any;
  const edgesBefore = before?.c ?? 0;

  return transact(() => {
    const identity = ensureIdentityNode(profile);
    const personNodes = syncRelationships(profile, identity.id);
    const interestNodes = syncInterests(profile, identity.id);
    const valueNodes = syncValues(profile, identity.id);
    const tensionEdges = syncTensions(profile, personNodes, interestNodes);

    const nodesCreated =
      (identity.created ? 1 : 0) +
      personNodes.filter(p => p.created).length +
      interestNodes.filter(i => i.created).length +
      valueNodes.filter(v => v.created).length;
    const nodesUpdated =
      (identity.created ? 0 : 1) +
      personNodes.filter(p => !p.created).length +
      interestNodes.filter(i => !i.created).length +
      valueNodes.filter(v => !v.created).length;
    const edgesCreated = personNodes.length + interestNodes.length + valueNodes.length + tensionEdges.length;

    console.log(
      `[Profile→Graph] nodes +${nodesCreated}/~${nodesUpdated}, edges +${edgesCreated} ` +
      `(${personNodes.length} persons · ${interestNodes.length} interests · ${valueNodes.length} values · ${tensionEdges.length} tensions); ` +
      `replaced ${edgesBefore} previous profile edges`
    );

    return {
      identityNodeId: identity.id,
      personNodes,
      interestNodes,
      valueNodes,
      tensionEdges,
      stats: {
        nodesCreated,
        nodesUpdated,
        edgesCreated,
        edgesReplaced: edgesBefore,
      },
    };
  });
}
