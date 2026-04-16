/**
 * L3 Cognition — Graph Extractor (Observation Agent core capability).
 *
 * After user messages, analyzes text and extracts graph nodes + edges.
 * This is what makes the Human Graph GROW from real behavior.
 *
 * Fixes applied:
 * - Uses balanced tier (graph_extraction task) for better accuracy
 * - Prompt emphasizes SHORT labels (≤40 chars) + rich edges
 * - Fuzzy dedup via LIKE matching
 * - Debounce: batches messages within 3s window
 * - Update matching uses fuzzy LIKE, not exact match
 */
import { text } from "../infra/compute/index.js";
import { createNode, createEdge, updateNodeStatus } from "../graph/writer.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

// ── Debounce: batch messages within 3s window ───────────────────────────────

let pendingMessages: string[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function extractFromMessage(userMessage: string): void {
  pendingMessages.push(userMessage);

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const batch = pendingMessages.splice(0);
    debounceTimer = null;
    if (batch.length > 0) {
      await doExtraction(batch.join("\n\n---\n\n"));
    }
  }, 3000);
}

// ── Fuzzy node lookup ───────────────────────────────────────────────────────

function fuzzyFindNode(label: string): { id: string; label: string } | null {
  // Exact match first
  const exact = db.prepare("SELECT id, label FROM graph_nodes WHERE user_id=? AND label=?").get(DEFAULT_USER_ID, label) as any;
  if (exact) return exact;

  // Fuzzy: check if label is contained in existing or vice versa
  const fuzzy = db.prepare("SELECT id, label FROM graph_nodes WHERE user_id=? AND (label LIKE ? OR ? LIKE '%' || label || '%')").get(DEFAULT_USER_ID, `%${label}%`, label) as any;
  if (fuzzy) return fuzzy;

  // Keyword match: split label into words, find node containing key words
  const words = label.split(/\s+/).filter(w => w.length > 3);
  if (words.length > 0) {
    for (const word of words) {
      const keyMatch = db.prepare("SELECT id, label FROM graph_nodes WHERE user_id=? AND label LIKE ?").get(DEFAULT_USER_ID, `%${word}%`) as any;
      if (keyMatch) return keyMatch;
    }
  }

  return null;
}

// ── Core extraction ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are Anchor's Observation Agent. Extract graph information from the user's message.

EXISTING GRAPH NODES (avoid duplicates — if info is about an existing node, UPDATE it):
{EXISTING_NODES}

EXISTING EDGES:
{EXISTING_EDGES}

USER MESSAGE:
"{MESSAGE}"

CRITICAL RULES:
1. Only extract REAL information explicitly stated or strongly implied. Never invent.
2. Labels must be SHORT (≤40 characters). Use the person's name, not a description.
   GOOD: "David (YC)" BAD: "David from Y Combinator who reviewed our application"
3. If an existing node matches, use "updates" — do NOT create a duplicate.
   Match loosely: "David" matches "David (YC)".
4. NEW PEOPLE → always create a "person" node. If someone is mentioned by name for the first time, they MUST appear in new_nodes.
5. NEW CONSTRAINTS (deadlines, limits, blockers) → always create a "constraint" node.
6. NEW PREFERENCES ("I prefer X over Y") → always create a "preference" node.
7. EDGES ARE IMPORTANT. For every relationship, create an edge. Never create self-referencing edges (from == to).
   "Runway blocks Series A" → edge. "Sarah supports fundraising" → edge.
8. For updates, use the EXISTING label exactly as shown above.
9. Keep total output SHORT. Max 5 new_nodes, 5 updates, 8 edges per extraction.

Node types: identity, goal, project, commitment, task, person, relationship, value, constraint, preference, routine, state, risk, opportunity, decision, resource, artifact, observation, outcome, behavioral_pattern, external_context
Edge types: depends_on, blocks, aligns_with, conflicts_with, owned_by, temporal, causal, contextual, supports, threatens
Domains: work, relationships, finance, health, growth

Respond ONLY with valid JSON (no markdown):
{
  "new_nodes": [
    { "domain": "work", "label": "Short Name", "type": "person", "status": "active", "detail": "One sentence context" }
  ],
  "updates": [
    { "label": "Exact Existing Label", "new_status": "in-progress", "new_detail": "optional updated detail" }
  ],
  "new_edges": [
    { "from_label": "Node A", "to_label": "Node B", "type": "depends_on" }
  ]
}

If nothing to extract, return: { "new_nodes": [], "updates": [], "new_edges": [] }`;

async function doExtraction(combinedMessage: string): Promise<void> {
  try {
    const existing = db.prepare(
      "SELECT label, type, status, domain FROM graph_nodes WHERE user_id=? ORDER BY domain"
    ).all(DEFAULT_USER_ID) as any[];

    const existingEdges = db.prepare(`
      SELECT f.label as f, t.label as t, e.type FROM graph_edges e
      JOIN graph_nodes f ON e.from_node_id=f.id JOIN graph_nodes t ON e.to_node_id=t.id
      WHERE e.user_id=?
    `).all(DEFAULT_USER_ID) as any[];

    const existingText = existing.length > 0
      ? existing.map(n => `[${n.domain}/${n.type}] ${n.label} (${n.status})`).join("\n")
      : "(empty graph)";

    const edgesText = existingEdges.length > 0
      ? existingEdges.map(e => `${e.f} —[${e.type}]→ ${e.t}`).join("\n")
      : "(no edges)";

    const prompt = EXTRACTION_PROMPT
      .replace("{EXISTING_NODES}", existingText)
      .replace("{EXISTING_EDGES}", edgesText)
      .replace("{MESSAGE}", combinedMessage.slice(0, 3000));

    const result = await text({
      task: "graph_extraction",
      system: prompt,
      messages: [{ role: "user", content: "Extract graph information." }],
      maxTokens: 800,
    });

    // Strip markdown fences if present, then extract JSON
    const stripped = result.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    let jsonStr = stripped.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) return;

    // Fix truncated JSON: if it doesn't end with }, try closing brackets
    if (!jsonStr.trim().endsWith("}")) {
      const openBrackets = (jsonStr.match(/\[/g) || []).length - (jsonStr.match(/\]/g) || []).length;
      const openBraces = (jsonStr.match(/\{/g) || []).length - (jsonStr.match(/\}/g) || []).length;
      jsonStr += "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try to extract partial results by cutting at last valid array element
      try {
        const trimmed = jsonStr.replace(/,\s*\]/, "]").replace(/,\s*\}/, "}");
        parsed = JSON.parse(trimmed);
      } catch {
        console.error("[Observation Agent] JSON parse failed even after repair");
        return;
      }
    }

    // ── Create new nodes (with fuzzy dedup) ─────────────────────────────
    let nodesCreated = 0;
    const newNodeIds: Record<string, string> = {};
    if (Array.isArray(parsed.new_nodes)) {
      for (const n of parsed.new_nodes) {
        if (!n.label || !n.type || !n.domain) continue;
        // Enforce ≤40 char label
        const label = n.label.slice(0, 40).trim();
        // Fuzzy dedup
        const existingNode = fuzzyFindNode(label);
        if (existingNode) {
          newNodeIds[label] = existingNode.id;
          newNodeIds[n.label] = existingNode.id;
          continue;
        }
        const id = createNode({
          domain: n.domain,
          label,
          type: n.type,
          status: n.status ?? "active",
          captured: "Extracted from conversation",
          detail: (n.detail ?? "").slice(0, 200),
        });
        newNodeIds[label] = id;
        newNodeIds[n.label] = id;
        nodesCreated++;
      }
    }

    // ── Update existing nodes (fuzzy match) ─────────────────────────────
    let nodesUpdated = 0;
    if (Array.isArray(parsed.updates)) {
      for (const u of parsed.updates) {
        if (!u.label) continue;
        const node = fuzzyFindNode(u.label);
        if (node) {
          if (u.new_status) updateNodeStatus(node.id, u.new_status);
          if (u.new_detail) {
            db.prepare("UPDATE graph_nodes SET detail=?, updated_at=datetime('now') WHERE id=?")
              .run(u.new_detail.slice(0, 200), node.id);
          }
          nodesUpdated++;
        }
      }
    }

    // ── Create edges (fuzzy match both ends) ────────────────────────────
    let edgesCreated = 0;
    if (Array.isArray(parsed.new_edges)) {
      for (const e of parsed.new_edges) {
        if (!e.from_label || !e.to_label || !e.type) continue;
        const fromNode = newNodeIds[e.from_label] ? { id: newNodeIds[e.from_label] } : fuzzyFindNode(e.from_label);
        const toNode = newNodeIds[e.to_label] ? { id: newNodeIds[e.to_label] } : fuzzyFindNode(e.to_label);
        if (fromNode && toNode && fromNode.id !== toNode.id) {
          const dup = db.prepare("SELECT id FROM graph_edges WHERE user_id=? AND from_node_id=? AND to_node_id=? AND type=?")
            .get(DEFAULT_USER_ID, fromNode.id, toNode.id, e.type);
          if (!dup) {
            createEdge(fromNode.id, toNode.id, e.type);
            edgesCreated++;
          }
        }
      }
    }

    if (nodesCreated + nodesUpdated + edgesCreated > 0) {
      log("Observation Agent", `Extracted: +${nodesCreated} nodes, ~${nodesUpdated} updates, +${edgesCreated} edges`);
      console.log(`[Observation Agent] Graph extraction: +${nodesCreated} nodes, ~${nodesUpdated} updates, +${edgesCreated} edges`);
    }
  } catch (err: any) {
    console.error("[Observation Agent] Extraction error:", err.message);
    log("Observation Agent", `Extraction failed: ${err.message}`, "failed");
  }
}
