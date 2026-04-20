"""
Anchor OS — Complete Agent Collaboration Map
Shows ALL agents (system + user-created) and how they interact.
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

BG = '#0f1117'
PRIMARY = '#6366f1'
BLUE = '#3b82f6'
CYAN = '#22d3ee'
GREEN = '#10b981'
AMBER = '#f59e0b'
RED = '#ef4444'
PURPLE = '#a855f7'
ROSE = '#f43f5e'
ORANGE = '#f97316'
TEAL = '#14b8a6'
TEXT = '#e2e8f0'
TEXT_DIM = '#94a3b8'
WHITE = '#ffffff'

def box(ax, x, y, w, h, label, sub='', color=PRIMARY, fs=9, bold=True):
    b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.015",
                       facecolor=color+'1a', edgecolor=color, linewidth=1.8)
    ax.add_patch(b)
    if sub:
        ax.text(x+w/2, y+h*0.65, label, ha='center', va='center',
                fontsize=fs, fontweight='bold' if bold else 'normal', color=WHITE, family='monospace')
        ax.text(x+w/2, y+h*0.28, sub, ha='center', va='center',
                fontsize=5.5, color=TEXT_DIM, family='monospace', linespacing=1.4)
    else:
        ax.text(x+w/2, y+h/2, label, ha='center', va='center',
                fontsize=fs, fontweight='bold' if bold else 'normal', color=WHITE, family='monospace')

def arr(ax, x1, y1, x2, y2, color=TEXT_DIM, lw=1.0, style='->'):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw,
                               connectionstyle='arc3,rad=0.08'))

def larr(ax, x1, y1, x2, y2, label, color=TEXT_DIM, fs=5.5, off=0.012):
    arr(ax, x1, y1, x2, y2, color=color)
    mx, my = (x1+x2)/2, (y1+y2)/2
    ax.text(mx, my+off, label, ha='center', va='bottom',
            fontsize=fs, color=color, family='monospace', style='italic')

def darr(ax, x1, y1, x2, y2, color=TEXT_DIM, lw=0.8):
    """Dashed arrow"""
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw,
                               linestyle='dashed', connectionstyle='arc3,rad=0.08'))


# ════════════════════════════════════════════════════════════════════════════
# DIAGRAM: All Agents + Collaboration
# ════════════════════════════════════════════════════════════════════════════

fig, ax = plt.subplots(1, 1, figsize=(22, 16))
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)
ax.set_xlim(0, 1); ax.set_ylim(0, 1)
ax.axis('off')

ax.text(0.5, 0.98, 'ANCHOR OS — Agent Collaboration Map', ha='center',
        fontsize=20, fontweight='bold', color=WHITE, family='monospace')
ax.text(0.5, 0.96, '11 System Agents + N User Custom Agents · Event-driven orchestration',
        ha='center', fontsize=9, color=TEXT_DIM, family='monospace')

# ═══════════════════════════════════════════════════════════════════════
# TOP ROW: User + Orchestrator
# ═══════════════════════════════════════════════════════════════════════

# User
box(ax, 0.40, 0.88, 0.20, 0.06, 'USER', 'chat · voice · telegram · imessage', CYAN, 11)

# Orchestrator (center hub)
box(ax, 0.35, 0.74, 0.30, 0.08, 'ORCHESTRATOR', 'Event Bus · Handlers · Mode Selection\nHandoff Validation · Error Retry (2x)', AMBER, 12)

arr(ax, 0.50, 0.88, 0.50, 0.82, CYAN, 1.5)
ax.text(0.52, 0.85, 'message', fontsize=6, color=CYAN, family='monospace')

# ═══════════════════════════════════════════════════════════════════════
# MIDDLE: 11 System Agents in a ring around Orchestrator
# ═══════════════════════════════════════════════════════════════════════

# ── LEFT COLUMN: Cognition Agents ──
# 1. Decision Agent (the brain)
box(ax, 0.01, 0.60, 0.22, 0.10, 'Decision Agent', '5-stage pipeline\nintent classify · skill match\ncache (LRU 50, 5min)\ncognitive failure detect (8)', PRIMARY, 9)

# 2. Twin Agent
box(ax, 0.01, 0.46, 0.22, 0.10, 'Twin Agent', 'learns from:\n• edit diffs → contraindications\n• exec results → quality\n• accept/reject → preference\n• weekly drift detection', PURPLE, 9)

# 3. Evolution Engine
box(ax, 0.01, 0.32, 0.22, 0.10, 'Evolution Engine', 'auto-tunes daily:\n• decision_style\n• plan_complexity\n• communication_tone\n• domain_weights\n• time_preference', ROSE, 9)

# 4. Skills Engine
box(ax, 0.01, 0.18, 0.22, 0.10, 'Skills Engine', '3+ confirms → crystallize\nskill match → fast path\nedit → evolve template\n3x reject → retire', TEAL, 9)

# ── CENTER COLUMN: Support Agents ──
# 5. Extractor
box(ax, 0.26, 0.60, 0.17, 0.08, 'Extractor', 'message → nodes\n+ edges\nNLP extraction', GREEN, 8)

# 6. Observation Agent
box(ax, 0.26, 0.48, 0.17, 0.08, 'Observation\nAgent', 'graph changes\n→ episodic memory\n→ cascade unlocks', BLUE, 8)

# 7. Memory Agent
box(ax, 0.26, 0.36, 0.17, 0.08, 'Memory Agent', 'twin insights\n→ semantic memory\npersist + index', PURPLE, 8)

# ── RIGHT COLUMN: Execution + Analysis Agents ──
# 8. Execution Agent
box(ax, 0.57, 0.60, 0.22, 0.10, 'Execution Agent', 'ReAct loop (12 turns)\n10 tools available\ncheckpoint each step\nL6 gate per action', GREEN, 9)

# 9. Swarm (3-agent debate)
box(ax, 0.57, 0.46, 0.22, 0.10, 'Cognitive Swarm', '3-role DEBATE:\n• Advocate (argues FOR)\n• Critic (attacks plan)\n• Judge (final ruling)\nactivates on low confidence', ORANGE, 9)

# 10. Self-Portrait Engine
box(ax, 0.57, 0.32, 0.22, 0.10, 'Self-Portrait\nEngine', '5 layers (pure math):\n1. Life Balance (entropy)\n2. Say vs Do\n3. Identity Tensions\n4. Relationship Depth\n5. Time Audit', ROSE, 8)

# 11. GEPA Optimizer
box(ax, 0.57, 0.18, 0.22, 0.10, 'GEPA Optimizer', 'execution trace analysis\ndetect waste patterns:\n• redundant calls\n• excessive tokens\n• failed retries\n• unnecessary swarm', RED, 8)

# ── FAR RIGHT: Proactive + Dream ──
# 12. Proactive Agent
box(ax, 0.82, 0.60, 0.17, 0.10, 'Proactive\nAgent', 'push notifications:\n• relationship decay\n• overdue tasks\n• outcome follow-up\n• attention drift', AMBER, 8)

# 13. Dream Engine
box(ax, 0.82, 0.46, 0.17, 0.10, 'Dream Engine', '3am consolidation:\n• prune stale\n• merge conflicts\n• promote patterns\n• create skills\n• capacity enforce', ROSE, 8)

# ═══════════════════════════════════════════════════════════════════════
# BOTTOM: User Custom Agents
# ═══════════════════════════════════════════════════════════════════════

# Dashed border area for custom agents
custom_bg = FancyBboxPatch((0.10, 0.01), 0.80, 0.12, boxstyle="round,pad=0.01",
                           facecolor='#ffffff05', edgecolor=CYAN, linewidth=1.2, linestyle='--')
ax.add_patch(custom_bg)
ax.text(0.50, 0.125, 'USER-CREATED CUSTOM AGENTS (persona overlays on Decision Agent)',
        ha='center', fontsize=8, fontweight='bold', color=CYAN, family='monospace')

box(ax, 0.12, 0.03, 0.15, 0.07, 'Competitor\nAnalyst', 'web_search · read_url', CYAN, 7, False)
box(ax, 0.29, 0.03, 0.13, 0.07, 'Email\nDrafter', 'send_email', CYAN, 7, False)
box(ax, 0.44, 0.03, 0.13, 0.07, 'Code\nReviewer', 'run_code · read_url', CYAN, 7, False)
box(ax, 0.59, 0.03, 0.13, 0.07, 'Meeting\nPrep', 'web_search', CYAN, 7, False)
box(ax, 0.74, 0.03, 0.14, 0.07, 'Your Agent\n(custom)', 'your instructions', CYAN, 7, False)

# ═══════════════════════════════════════════════════════════════════════
# ARROWS: How agents interact
# ═══════════════════════════════════════════════════════════════════════

# User → Orchestrator (already drawn)

# Orchestrator → Decision Agent
larr(ax, 0.35, 0.77, 0.23, 0.67, 'route message', PRIMARY, 6)

# Decision Agent → Orchestrator (returns plan)
larr(ax, 0.23, 0.63, 0.35, 0.75, 'plan/advice', PRIMARY, 6)

# Decision reads from: Extractor, Twin, Evolution, Skills
darr(ax, 0.12, 0.60, 0.12, 0.56, PURPLE)  # Decision ← Twin
ax.text(0.05, 0.575, 'twin\npriors', fontsize=5, color=PURPLE, family='monospace', ha='center')

darr(ax, 0.12, 0.46, 0.12, 0.42, ROSE)  # Twin ← Evolution
ax.text(0.05, 0.44, 'signals', fontsize=5, color=ROSE, family='monospace', ha='center')

darr(ax, 0.12, 0.32, 0.12, 0.28, TEAL)  # Evolution ← Skills
ax.text(0.05, 0.30, 'usage\ndata', fontsize=5, color=TEAL, family='monospace', ha='center')

# Decision → Extractor (side effect: extract nodes from message)
larr(ax, 0.23, 0.65, 0.26, 0.65, 'extract', GREEN, 5)

# Orchestrator → Execution (USER_CONFIRMED)
larr(ax, 0.65, 0.77, 0.72, 0.70, 'USER_CONFIRMED', GREEN, 6)

# Execution → Orchestrator (EXECUTION_DONE)
larr(ax, 0.72, 0.67, 0.65, 0.75, 'EXECUTION_DONE', AMBER, 6)

# Orchestrator → Twin (after execution)
larr(ax, 0.35, 0.75, 0.23, 0.53, 'learn from results', PURPLE, 5)

# Twin → Orchestrator (TWIN_UPDATED)
larr(ax, 0.23, 0.50, 0.35, 0.76, 'TWIN_UPDATED', AMBER, 5)

# Orchestrator → Observation Agent
darr(ax, 0.43, 0.74, 0.38, 0.56, BLUE)
ax.text(0.42, 0.66, 'GRAPH_UPDATED', fontsize=5, color=BLUE, family='monospace')

# Orchestrator → Memory Agent
darr(ax, 0.40, 0.74, 0.35, 0.44, PURPLE)

# Decision → Swarm (escalation)
larr(ax, 0.23, 0.62, 0.57, 0.53, 'low confidence → debate', ORANGE, 5)

# Swarm → Decision (result back)
darr(ax, 0.57, 0.50, 0.23, 0.64, ORANGE)

# Decision → Self-Portrait (reads analysis)
darr(ax, 0.20, 0.60, 0.57, 0.38, ROSE)
ax.text(0.38, 0.47, 'portrait data', fontsize=5, color=ROSE, family='monospace', ha='center')

# Proactive → Orchestrator (NOTIFICATION)
larr(ax, 0.82, 0.67, 0.65, 0.78, 'NOTIFICATION', AMBER, 5)

# Dream → Skills (creates skills)
larr(ax, 0.82, 0.46, 0.23, 0.25, 'create skills\nfrom patterns', TEAL, 5)

# Dream → Memory (prune/merge)
darr(ax, 0.82, 0.48, 0.43, 0.42, PURPLE)
ax.text(0.63, 0.46, 'prune/merge', fontsize=5, color=PURPLE, family='monospace')

# Custom Agents → Decision Agent (delegation)
arr(ax, 0.50, 0.13, 0.15, 0.60, CYAN, 0.8)
ax.text(0.28, 0.37, 'custom instructions\n+ graph context\n→ Decision Agent\npipeline (text())', fontsize=6, color=CYAN,
        family='monospace', ha='center', linespacing=1.4,
        bbox=dict(boxstyle='round,pad=0.3', facecolor=BG, edgecolor=CYAN+'44', linewidth=0.5))

# GEPA → Decision (optimization suggestions)
darr(ax, 0.68, 0.28, 0.20, 0.60, RED)
ax.text(0.48, 0.40, 'waste analysis\n(not auto-applied)', fontsize=5, color=RED, family='monospace', ha='center')

# ═══════════════════════════════════════════════════════════════════════
# LEGEND / KEY INSIGHT BOXES
# ═══════════════════════════════════════════════════════════════════════

# Event flow legend
legend_y = 0.935
ax.text(0.02, legend_y, 'EVENTS:', fontsize=7, fontweight='bold', color=AMBER, family='monospace')
events = [
    ('USER_CONFIRMED', 'user approves plan → execute'),
    ('EXECUTION_DONE', 'agent finished → twin learns'),
    ('TWIN_UPDATED', 'insight found → save to memory'),
    ('GRAPH_UPDATED', 'node changed → observe'),
    ('NOTIFICATION', 'proactive push → user'),
]
for i, (ev, desc) in enumerate(events):
    ax.text(0.02 + i*0.20, legend_y - 0.015, f'{ev}', fontsize=5.5, color=AMBER, family='monospace', fontweight='bold')
    ax.text(0.02 + i*0.20, legend_y - 0.030, desc, fontsize=5, color=TEXT_DIM, family='monospace')

# Problem callout
prob_bg = FancyBboxPatch((0.01, 0.14), 0.24, 0.035, boxstyle="round,pad=0.008",
                         facecolor=RED+'22', edgecolor=RED, linewidth=1.2, linestyle='--')
ax.add_patch(prob_bg)
ax.text(0.13, 0.157, 'PROBLEM: Custom Agents do NOT share\nskills or learn from each other', ha='center',
        fontsize=6, color=RED, family='monospace', fontweight='bold')

# How custom agents work callout
how_bg = FancyBboxPatch((0.82, 0.30), 0.17, 0.10, boxstyle="round,pad=0.008",
                        facecolor=CYAN+'15', edgecolor=CYAN+'66', linewidth=0.8)
ax.add_patch(how_bg)
ax.text(0.905, 0.39, 'HOW CUSTOM\nAGENTS WORK:', ha='center',
        fontsize=6.5, color=CYAN, family='monospace', fontweight='bold')
ax.text(0.905, 0.33, '1. User defines instructions\n2. System injects graph context\n3. Calls text() (same LLM)\n4. Returns result\n\nNO separate process\nNO separate memory\nNO skill sharing', ha='center',
        fontsize=5, color=TEXT_DIM, family='monospace', linespacing=1.4)

fig.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-4-agents.png', dpi=200,
           bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig)
print("Generated: docs/arch-4-agents.png")
