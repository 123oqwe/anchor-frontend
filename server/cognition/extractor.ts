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
import { object } from "../infra/compute/index.js";
import { createNode, createEdge, updateNodeStatus } from "../graph/writer.js";
import { db, DEFAULT_USER_ID, logExecution } from "../infra/storage/db.js";
import { z } from "zod";
import { pickVariant } from "../orchestration/experiment-runner.js";

const ExtractionSchema = z.object({
  new_nodes: z.array(z.object({
    label: z.string(),
    type: z.string(),
    domain: z.string(),
    status: z.string().optional(),
    detail: z.string().optional(),
  })).default([]),
  updates: z.array(z.object({
    label: z.string(),
    new_status: z.string().optional(),
    new_detail: z.string().optional(),
  })).default([]),
  new_edges: z.array(z.object({
    from_label: z.string(),
    to_label: z.string(),
    type: z.string(),
  })).default([]),
});

// ── Debounce: batch messages within 3s window ───────────────────────────────

let pendingMessages: string[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function extractFromMessage(userMessage: string): void {
  // Skip extraction for trivially short messages (greetings, "ok", "yes")
  if (userMessage.trim().length < 20) return;

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

  // Containment match: "Kevin" matches "Kevin (a16z)" and vice versa
  const fuzzy = db.prepare("SELECT id, label FROM graph_nodes WHERE user_id=? AND (label LIKE ? OR ? LIKE '%' || label || '%')").get(DEFAULT_USER_ID, `%${label}%`, label) as any;
  if (fuzzy) return fuzzy;

  // First-word match ONLY (for person names): "Lisa (a16z Seed Program)" → try "Lisa"
  // Only use this for labels that look like "Name (context)" pattern
  const nameMatch = label.match(/^([A-Z][a-z]+)\s*\(/);
  if (nameMatch) {
    const firstName = nameMatch[1];
    const byName = db.prepare("SELECT id, label FROM graph_nodes WHERE user_id=? AND label LIKE ?").get(DEFAULT_USER_ID, `${firstName}%`) as any;
    if (byName) return byName;
  }

  return null;
}

// ── Core extraction ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are Anchor's Observation Agent. Extract ONLY high-value information. Quality over quantity.

EXISTING GRAPH NODES (avoid duplicates — if info is about an existing node, UPDATE it):
{EXISTING_NODES}

EXISTING EDGES:
{EXISTING_EDGES}

USER MESSAGE:
"{MESSAGE}"

WHAT TO EXTRACT (only these - nothing else):
1. PEOPLE - Every person name or email. Always extract. "john@co.com" = person "John (Co)".
2. GOALS - Things to ACHIEVE. Not tools you have. "Launch MVP" = yes. "VS Code" = no.
3. PROJECTS - Active work with outcomes. "Anchor OS" = yes. "Dev Infrastructure" = no.
4. COMMITMENTS - Promises, deadlines, obligations.
5. RISKS - Things that could go wrong or patterns threatening goals.
6. BEHAVIORAL PATTERNS - Observed habits, good or bad.

DO NOT EXTRACT (skip entirely):
- Tools, apps, software names (no "AI Dev Stack", "Mac Workstation", "Claude Code")
- Infrastructure, platforms (no "RunPod", "Backend Tech Stack", "GPU Infrastructure")
- Generic resources (no "Coding Environment", "Installed Software", "Dev Infrastructure")
- The test: does this node help answer "what should I do next?" If not, skip it.

RULES:
- Labels max 40 chars
- Max 6 new_nodes, 3 updates, 8 edges
- Detail under 60 chars
- Prefer PEOPLE over resources. Always extract people.
- When in doubt, SKIP (not create). Quality over quantity.

Node types: goal, project, commitment, task, person, value, constraint, preference, risk, opportunity, decision, behavioral_pattern
Edge types: depends_on, blocks, aligns_with, conflicts_with, supports, threatens, contextual
Domains: work, relationships, finance, health, growth

DOMAIN RULES:
- finance = ONLY personal money: balance, spending, income, runway, investments. NOT courses/study about finance.
- work = career, projects, courses, academic work, side projects, freelance
- "Finance course" or "Valuation study" → domain: work (it is academic work, not personal money)
- relationships = people only
- health = physical/mental health, sleep, exercise, energy
- growth = personal development, values, long-term patterns

Respond ONLY with valid JSON:
{
  "new_nodes": [
    { "domain": "relationships", "label": "Sarah Chen", "type": "person", "status": "active", "detail": "Investor from Sequoia" }
  ],
  "updates": [
    { "label": "Exact Existing Label", "new_status": "in-progress", "new_detail": "updated detail" }
  ],
  "new_edges": [
    { "from_label": "Node A", "to_label": "Node B", "type": "supports" }
  ]
}

If nothing high-value to extract: { "new_nodes": [], "updates": [], "new_edges": [] }`;

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

    // Sprint A — #7: prompt experiment override on the EXTRACTION_PROMPT
    // template before placeholder substitution.
    const promptTemplate = pickVariant({
      key: "extractor.graph_extraction_prompt",
      fallback: EXTRACTION_PROMPT,
    }).value;
    const prompt = promptTemplate
      .replace("{EXISTING_NODES}", existingText)
      .replace("{EXISTING_EDGES}", edgesText)
      .replace("{MESSAGE}", combinedMessage.slice(0, 3000));

    let parsed: z.infer<typeof ExtractionSchema>;
    try {
      parsed = await object({
        task: "graph_extraction",
        system: prompt,
        messages: [{ role: "user", content: "Extract graph information." }],
        schema: ExtractionSchema,
        maxTokens: 1200,
      });
    } catch (err: any) {
      console.error("[Observation Agent] structured extraction failed:", err?.message);
      return;
    }

    // ── Create new nodes (with fuzzy dedup) ─────────────────────────────
    let nodesCreated = 0;
    const newNodeIds: Record<string, string> = {};
    for (const n of parsed.new_nodes) {
      if (!n.label || !n.type || !n.domain) continue;
      const label = n.label.slice(0, 40).trim();
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

    // ── Update existing nodes (fuzzy match) ─────────────────────────────
    let nodesUpdated = 0;
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

    // ── Create edges (fuzzy match both ends) ────────────────────────────
    let edgesCreated = 0;
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

    if (nodesCreated + nodesUpdated + edgesCreated > 0) {
      logExecution("Observation Agent", `Extracted: +${nodesCreated} nodes, ~${nodesUpdated} updates, +${edgesCreated} edges`);
      console.log(`[Observation Agent] Graph extraction: +${nodesCreated} nodes, ~${nodesUpdated} updates, +${edgesCreated} edges`);
    }
  } catch (err: any) {
    console.error("[Observation Agent] Extraction error:", err.message);
    logExecution("Observation Agent", `Extraction failed: ${err.message}`, "failed");
  }
}

/** Direct extraction from text — used by ingestion pipeline (no debounce). */
export async function extractFromText(text: string): Promise<void> {
  await doExtraction(text);
}
