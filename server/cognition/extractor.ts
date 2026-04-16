/**
 * L3 Cognition — Graph Extractor (Observation Agent core capability).
 *
 * After every user message, analyzes the text and decides:
 * 1. Should any new graph nodes be created?
 * 2. Should any existing nodes be updated?
 * 3. Should any edges be created between nodes?
 *
 * This is what makes the Human Graph GROW from real behavior.
 * Runs async (non-blocking) after Decision Agent responds.
 */
import { text } from "../infra/compute/index.js";
import { createNode, createEdge, updateNodeStatus, type CreateNodeInput } from "../graph/writer.js";
import { db, DEFAULT_USER_ID } from "../infra/storage/db.js";
import { nanoid } from "nanoid";

function log(agent: string, action: string, status = "success") {
  db.prepare("INSERT INTO agent_executions (id, user_id, agent, action, status) VALUES (?,?,?,?,?)")
    .run(nanoid(), DEFAULT_USER_ID, agent, action, status);
}

const EXTRACTION_PROMPT = `You are Anchor's Observation Agent. Analyze the user's message and extract any new information about their life that should be added to their Human Graph.

Current graph nodes (for reference, to avoid duplicates):
{EXISTING_NODES}

User's message:
"{MESSAGE}"

RULES:
1. Only extract REAL information the user explicitly stated or strongly implied.
2. Do NOT invent or assume.
3. Check existing nodes — do NOT create duplicates. If info updates an existing node, use "updates" instead.
4. Types: identity, goal, project, commitment, task, person, relationship, value, constraint, preference, routine, state, risk, opportunity, decision, resource, artifact, observation, outcome, behavioral_pattern, external_context
5. Edge types: depends_on, blocks, aligns_with, conflicts_with, owned_by, temporal, causal, contextual, supports, threatens
6. If nothing new to extract, return empty arrays.

Respond ONLY with valid JSON:
{
  "new_nodes": [
    { "domain": "work|relationships|finance|health|growth", "label": "short name", "type": "node_type", "status": "active", "detail": "one sentence" }
  ],
  "updates": [
    { "label": "existing node label (exact match)", "new_status": "new status" }
  ],
  "new_edges": [
    { "from_label": "node A label", "to_label": "node B label", "type": "edge_type" }
  ]
}`;

/** Extract graph updates from a user message. Runs async after each conversation turn. */
export async function extractFromMessage(userMessage: string): Promise<void> {
  try {
    // Get existing nodes for dedup
    const existing = db.prepare(
      "SELECT label, type, status, domain FROM graph_nodes WHERE user_id=? ORDER BY domain"
    ).all(DEFAULT_USER_ID) as any[];

    const existingText = existing.length > 0
      ? existing.map(n => `[${n.domain}/${n.type}] ${n.label} (${n.status})`).join("\n")
      : "(empty graph)";

    const prompt = EXTRACTION_PROMPT
      .replace("{EXISTING_NODES}", existingText)
      .replace("{MESSAGE}", userMessage.slice(0, 2000));

    const result = await text({
      task: "twin_edit_learning",  // reuse cheap tier
      system: prompt,
      messages: [{ role: "user", content: "Extract graph information from the message above." }],
      maxTokens: 400,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);

    // Create new nodes
    let nodesCreated = 0;
    const newNodeIds: Record<string, string> = {};
    if (Array.isArray(parsed.new_nodes)) {
      for (const n of parsed.new_nodes) {
        if (!n.label || !n.type || !n.domain) continue;
        // Dedup check
        const exists = db.prepare("SELECT id FROM graph_nodes WHERE user_id=? AND label=?").get(DEFAULT_USER_ID, n.label);
        if (exists) continue;
        const id = createNode({
          domain: n.domain,
          label: n.label,
          type: n.type,
          status: n.status ?? "active",
          captured: "Extracted from conversation",
          detail: n.detail ?? "",
        });
        newNodeIds[n.label] = id;
        nodesCreated++;
      }
    }

    // Update existing nodes
    let nodesUpdated = 0;
    if (Array.isArray(parsed.updates)) {
      for (const u of parsed.updates) {
        if (!u.label || !u.new_status) continue;
        const node = db.prepare("SELECT id FROM graph_nodes WHERE user_id=? AND label=?").get(DEFAULT_USER_ID, u.label) as any;
        if (node) {
          updateNodeStatus(node.id, u.new_status);
          nodesUpdated++;
        }
      }
    }

    // Create edges
    let edgesCreated = 0;
    if (Array.isArray(parsed.new_edges)) {
      for (const e of parsed.new_edges) {
        if (!e.from_label || !e.to_label || !e.type) continue;
        const fromNode = newNodeIds[e.from_label]
          ?? (db.prepare("SELECT id FROM graph_nodes WHERE user_id=? AND label=?").get(DEFAULT_USER_ID, e.from_label) as any)?.id;
        const toNode = newNodeIds[e.to_label]
          ?? (db.prepare("SELECT id FROM graph_nodes WHERE user_id=? AND label=?").get(DEFAULT_USER_ID, e.to_label) as any)?.id;
        if (fromNode && toNode) {
          // Dedup edge
          const existingEdge = db.prepare("SELECT id FROM graph_edges WHERE user_id=? AND from_node_id=? AND to_node_id=? AND type=?").get(DEFAULT_USER_ID, fromNode, toNode, e.type);
          if (!existingEdge) {
            createEdge(fromNode, toNode, e.type);
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
