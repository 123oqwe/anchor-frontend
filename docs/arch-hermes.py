"""
Anchor OS × Hermes Agent — How Hermes patterns are integrated
Shows: what Hermes does, what Anchor adopted, what's different, what's missing
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import numpy as np

BG = '#0a0c10'
PRIMARY = '#6366f1'
BLUE = '#3b82f6'
CYAN = '#22d3ee'
GREEN = '#10b981'
AMBER = '#f59e0b'
RED = '#ef4444'
PURPLE = '#a855f7'
ROSE = '#f43f5e'
ORANGE = '#f97316'
WHITE = '#f1f5f9'
DIM = '#64748b'
MUTED = '#475569'

def box(ax, x, y, w, h, title, items, color, fs=8):
    b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012",
                       facecolor=color+'15', edgecolor=color, linewidth=1.6)
    ax.add_patch(b)
    ax.text(x+w/2, y+h-0.012, title, ha='center', va='top',
            fontsize=fs, fontweight='bold', color=WHITE, family='monospace')
    for i, item in enumerate(items):
        ax.text(x+w/2, y+h-0.028-(i+1)*0.014, item, ha='center', va='top',
                fontsize=5.5, color=DIM, family='monospace')

def statusbox(ax, x, y, w, h, title, items, color, status, status_color):
    box(ax, x, y, w, h, title, items, color)
    ax.text(x+w-0.01, y+h-0.01, status, ha='right', va='top',
            fontsize=5, fontweight='bold', color=status_color, family='monospace',
            bbox=dict(boxstyle='round,pad=0.15', facecolor=status_color+'22', edgecolor=status_color+'44', linewidth=0.5))

def arr(ax, x1, y1, x2, y2, color=MUTED, lw=0.8):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, connectionstyle='arc3,rad=0.05'))

def darr(ax, x1, y1, x2, y2, color=MUTED, lw=0.6):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, linestyle='dashed', connectionstyle='arc3,rad=0.05'))


fig, ax = plt.subplots(1, 1, figsize=(24, 16))
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)
ax.set_xlim(0, 1); ax.set_ylim(0, 1)
ax.axis('off')

ax.text(0.5, 0.985, 'ANCHOR OS x HERMES AGENT — Integration Map', ha='center',
        fontsize=20, fontweight='bold', color=WHITE, family='monospace')
ax.text(0.5, 0.965, 'Left: Hermes original | Right: Anchor implementation | Lines: where patterns connect',
        ha='center', fontsize=8, color=DIM, family='monospace')

# ═══════════════════════════════════════════════════════════════
# LEFT SIDE: Hermes Agent Architecture
# ═══════════════════════════════════════════════════════════════

ax.text(0.22, 0.935, 'HERMES AGENT (Nous Research)', ha='center',
        fontsize=14, fontweight='bold', color=ORANGE, family='monospace')
ax.text(0.22, 0.92, 'The Self-Improving AI Agent · v0.8.0 · 95.6K stars',
        ha='center', fontsize=7, color=DIM, family='monospace')

# Hermes Core
statusbox(ax, 0.02, 0.82, 0.40, 0.075, 'GEPA — Genetic-Pareto Prompt Evolution',
    ['ICLR 2026 Oral paper',
     '1. Read existing SKILL files + sample historical sessions',
     '2. Reflect on execution traces in natural language',
     '3. Generate candidate prompt variants',
     '4. Pareto-based selection (keep if best on ANY sample)',
     '5. Human review gate before merge'],
    ORANGE, 'CORE', ORANGE)

statusbox(ax, 0.02, 0.72, 0.40, 0.075, 'Periodic Nudge',
    ['Every ~15 conversation turns:',
     'System injects reflection instruction',
     '"Review conversation — anything worth persisting?"',
     'Agent decides which memory layer to store in',
     'Configurable nudge_interval'],
    BLUE, 'CORE', BLUE)

statusbox(ax, 0.02, 0.62, 0.40, 0.075, 'Frozen Prompt Snapshot',
    ['Freeze system prompt at session init',
     'Cached for LLM prefix caching efficiency',
     'Prevents token costs growing with learning',
     'Refresh only on session change or timeout'],
    CYAN, 'CORE', CYAN)

statusbox(ax, 0.02, 0.52, 0.40, 0.075, 'Dialectic User Modeling (via Honcho)',
    ['Not just "what user said" — model HOW user thinks',
     'Extract entities + underlying preferences',
     'Dialectically align contradictory statements',
     'Background LLM calls to analyze chat history',
     'Structured "Insights" from casual conversation'],
    PURPLE, 'CORE', PURPLE)

statusbox(ax, 0.02, 0.42, 0.40, 0.075, 'Skill Auto-Creation',
    ['5+ tool calls in complex task → auto-create skill',
     'Skill = markdown doc: procedure + pitfalls + verification',
     'Skills get 40% faster at repeated tasks',
     'Skill evolution via GEPA (propose → evaluate → PR → merge)'],
    GREEN, 'CORE', GREEN)

statusbox(ax, 0.02, 0.32, 0.40, 0.065, 'Dream Engine (Memory Consolidation)',
    ['Offline memory processing during idle',
     'Promote episodic → semantic',
     'Prune low-value memories',
     'Skill creation from execution logs'],
    ROSE, 'CORE', ROSE)

statusbox(ax, 0.02, 0.24, 0.40, 0.055, 'Multi-Channel Gateway',
    ['Telegram · Discord · Slack · WhatsApp · Web',
     'Gateway mode with idle timeout + session flush',
     'Channel-specific adapters'],
    BLUE, 'FEATURE', BLUE)

# ═══════════════════════════════════════════════════════════════
# RIGHT SIDE: Anchor Implementation
# ═══════════════════════════════════════════════════════════════

ax.text(0.75, 0.935, 'ANCHOR OS (Your Implementation)', ha='center',
        fontsize=14, fontweight='bold', color=PRIMARY, family='monospace')
ax.text(0.75, 0.92, 'Personal Decision OS · 78 files · 14K lines',
        ha='center', fontsize=7, color=DIM, family='monospace')

# GEPA → Anchor version
statusbox(ax, 0.55, 0.82, 0.42, 0.075, 'GEPA Optimizer (gepa.ts)',
    ['Reads llm_calls + agent_executions traces',
     'Detects: redundant calls, excessive tokens, failed retries',
     'LLM generates optimization suggestions',
     'Auto-applies route_overrides (model downgrade)',
     'MISSING: no Pareto selection, no prompt mutation,',
     'no candidate generation, no human review PR gate'],
    ORANGE, '30%', AMBER)

# Periodic Nudge → Anchor version
statusbox(ax, 0.55, 0.72, 0.42, 0.075, 'Periodic Nudge (retrieval.ts:343)',
    ['Every 5 conversation turns (not 15)',
     'Checks episodic memories for repeating tags',
     'Injects "[System note: topic X came up N times]"',
     'Decision Agent sees it in augmented message',
     'MATCH: same concept, simpler implementation'],
    BLUE, '80%', GREEN)

# Frozen Snapshot → Anchor version
statusbox(ax, 0.55, 0.62, 0.42, 0.075, 'Frozen Snapshot (retrieval.ts:370)',
    ['Caches serialized memory string',
     '5-minute TTL (SNAPSHOT_TTL_MS)',
     'Invalidated after Dream Engine runs',
     'Enables LLM prefix caching',
     'MATCH: identical pattern'],
    CYAN, '100%', GREEN)

# Dialectic → Anchor version
statusbox(ax, 0.55, 0.52, 0.42, 0.075, 'Dialectic Modeling (retrieval.ts:397)',
    ['writeDialecticInsight({ stated, observed, tension })',
     'Called by Twin Agent when behavior contradicts goals',
     'Stores as semantic memory with "dialectic" tag',
     'SIMPLER: no background Honcho LLM analysis',
     'SIMPLER: no entity extraction framework'],
    PURPLE, '50%', AMBER)

# Skill Auto-Creation → Anchor version
statusbox(ax, 0.55, 0.42, 0.42, 0.075, 'Skills Engine (skills.ts)',
    ['3+ confirmed plans → crystallize skill',
     'Keyword match (60%) → skip 5-stage pipeline',
     'Edit → evolve template, Reject 3x → retire',
     'Dream Engine creates from exec logs',
     'MISSING: no GEPA evolution of skills,',
     'no PR-based human review, no Pareto selection'],
    GREEN, '40%', AMBER)

# Dream → Anchor version
statusbox(ax, 0.55, 0.32, 0.42, 0.065, 'Dream Engine (dream.ts)',
    ['3am cron: prune + merge + promote + skill create',
     'Time normalize + capacity enforce (200 max)',
     'Expire temporal edges',
     'MATCH: same concept, similar implementation'],
    ROSE, '70%', GREEN)

# Channels → Anchor version
statusbox(ax, 0.55, 0.24, 0.42, 0.055, 'Multi-Channel (5 channels)',
    ['Web · WebSocket · Telegram · iMessage · MCP',
     'EXTRA: iMessage via AppleScript (Mac-native)',
     'EXTRA: MCP bidirectional protocol'],
    BLUE, '100%', GREEN)

# ═══════════════════════════════════════════════════════════════
# CONNECTION ARROWS
# ═══════════════════════════════════════════════════════════════

# GEPA → GEPA
arr(ax, 0.42, 0.855, 0.55, 0.855, ORANGE, 1.2)
# Nudge → Nudge
arr(ax, 0.42, 0.755, 0.55, 0.755, BLUE, 1.2)
# Frozen → Frozen
arr(ax, 0.42, 0.655, 0.55, 0.655, CYAN, 1.2)
# Dialectic → Dialectic
arr(ax, 0.42, 0.555, 0.55, 0.555, PURPLE, 1.2)
# Skill → Skill
arr(ax, 0.42, 0.455, 0.55, 0.455, GREEN, 1.2)
# Dream → Dream
arr(ax, 0.42, 0.35, 0.55, 0.35, ROSE, 1.2)
# Channel → Channel
arr(ax, 0.42, 0.265, 0.55, 0.265, BLUE, 1.2)

# ═══════════════════════════════════════════════════════════════
# ANCHOR-ONLY FEATURES (no Hermes equivalent)
# ═══════════════════════════════════════════════════════════════

ax.text(0.75, 0.215, 'ANCHOR-ONLY (no Hermes equivalent)', ha='center',
        fontsize=9, fontweight='bold', color=PRIMARY, family='monospace')

box(ax, 0.55, 0.13, 0.19, 0.065, 'Human Graph',
    ['21 node types x 5 domains', 'PageRank + Entropy + Decay', 'Bayesian confidence', 'graph_edges with temporal fields'],
    CYAN, 7)

box(ax, 0.76, 0.13, 0.19, 0.065, 'Evolution Engine',
    ['Auto-tune 5 dimensions daily', 'decision_style, complexity', 'tone, domain_weights, time', 'No Hermes equivalent'],
    ROSE, 7)

box(ax, 0.55, 0.05, 0.19, 0.065, 'Self-Portrait',
    ['5-layer pure math analysis', 'Life Balance (entropy)', 'Say vs Do, Identity Tensions', 'Relationship Depth, Time Audit'],
    PURPLE, 7)

box(ax, 0.76, 0.05, 0.19, 0.065, 'Recommendation Engine',
    ['Pattern detection → suggestions', 'User confirms, system creates', 'Agents + Crons + Skills', 'Natural language creation'],
    AMBER, 7)

# ═══════════════════════════════════════════════════════════════
# HERMES-ONLY FEATURES (not in Anchor)
# ═══════════════════════════════════════════════════════════════

ax.text(0.22, 0.215, 'HERMES-ONLY (not in Anchor)', ha='center',
        fontsize=9, fontweight='bold', color=RED, family='monospace')

box(ax, 0.02, 0.13, 0.19, 0.065, 'DSPy Framework',
    ['Structured prompt optimization', 'Programmatic prompt engineering', 'Evaluation harness', 'Not integrated in Anchor'],
    RED, 7)

box(ax, 0.23, 0.13, 0.19, 0.065, 'Pareto Selection',
    ['Keep variant if best on ANY sample', 'Diversity preservation', 'Multi-objective optimization', 'Anchor: single-objective only'],
    RED, 7)

box(ax, 0.02, 0.05, 0.19, 0.065, 'Skill PR Gate',
    ['GEPA generates improved skill', 'Creates PR for human review', 'Merge to activate', 'Anchor: auto-applies directly'],
    RED, 7)

box(ax, 0.23, 0.05, 0.19, 0.065, 'Honcho (external)',
    ['Background dialectic analysis', 'Entity extraction pipeline', 'Structured Insights system', 'Anchor: inline writeDialecticInsight'],
    RED, 7)

# ═══════════════════════════════════════════════════════════════
# SUMMARY TABLE
# ═══════════════════════════════════════════════════════════════

# Legend at center
ax.add_patch(FancyBboxPatch((0.44, 0.73), 0.10, 0.17, boxstyle="round,pad=0.008",
             facecolor=BG, edgecolor=MUTED, linewidth=0.8))

legend = [
    ('100%', GREEN, 'identical'),
    ('80%', GREEN, 'close match'),
    ('70%', GREEN, 'good match'),
    ('50%', AMBER, 'partial'),
    ('40%', AMBER, 'weak'),
    ('30%', AMBER, 'minimal'),
]
ax.text(0.49, 0.895, 'MATCH', ha='center', fontsize=6, fontweight='bold', color=WHITE, family='monospace')
for i, (pct, col, desc) in enumerate(legend):
    y = 0.875 - i * 0.018
    ax.text(0.46, y, pct, fontsize=5, color=col, family='monospace', fontweight='bold', ha='center')
    ax.text(0.49, y, desc, fontsize=4.5, color=DIM, family='monospace')


fig.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-hermes.png', dpi=200,
           bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig)
print("Generated: docs/arch-hermes.png")
