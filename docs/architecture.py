"""
Anchor OS — Complete Architecture Diagrams
Generates 3 diagrams:
  1. System Overview (8 layers)
  2. Decision Pipeline (step-by-step data flow)
  3. Learning Loop (how system gets smarter)
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

# ─── Color Palette ──────────────────────────────────────────────────────────
BG = '#0f1117'
CARD = '#1a1d27'
CARD_LIGHT = '#252836'
PRIMARY = '#6366f1'    # indigo
BLUE = '#3b82f6'
CYAN = '#22d3ee'
GREEN = '#10b981'
AMBER = '#f59e0b'
RED = '#ef4444'
PURPLE = '#a855f7'
ROSE = '#f43f5e'
TEXT = '#e2e8f0'
TEXT_DIM = '#94a3b8'
TEXT_MUTED = '#64748b'
WHITE = '#ffffff'

def styled_box(ax, x, y, w, h, label, sublabel='', color=PRIMARY, fontsize=9):
    box = FancyBboxPatch((x, y), w, h,
                         boxstyle="round,pad=0.02",
                         facecolor=color + '22',
                         edgecolor=color,
                         linewidth=1.5)
    ax.add_patch(box)
    if sublabel:
        ax.text(x + w/2, y + h*0.62, label, ha='center', va='center',
                fontsize=fontsize, fontweight='bold', color=WHITE, family='monospace')
        ax.text(x + w/2, y + h*0.3, sublabel, ha='center', va='center',
                fontsize=6.5, color=TEXT_DIM, family='monospace')
    else:
        ax.text(x + w/2, y + h/2, label, ha='center', va='center',
                fontsize=fontsize, fontweight='bold', color=WHITE, family='monospace')

def arrow(ax, x1, y1, x2, y2, color=TEXT_DIM, style='->', lw=1.2):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw,
                               connectionstyle='arc3,rad=0.05'))

def curved_arrow(ax, x1, y1, x2, y2, color=TEXT_DIM, rad=0.2):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=1.0,
                               connectionstyle=f'arc3,rad={rad}'))

def label_arrow(ax, x1, y1, x2, y2, label, color=TEXT_DIM):
    arrow(ax, x1, y1, x2, y2, color=color)
    mx, my = (x1+x2)/2, (y1+y2)/2
    ax.text(mx, my + 0.015, label, ha='center', va='bottom',
            fontsize=5.5, color=color, family='monospace', style='italic')


# ════════════════════════════════════════════════════════════════════════════
# DIAGRAM 1: System Overview — 8-Layer Architecture
# ════════════════════════════════════════════════════════════════════════════

fig1, ax1 = plt.subplots(1, 1, figsize=(16, 12))
fig1.patch.set_facecolor(BG)
ax1.set_facecolor(BG)
ax1.set_xlim(0, 1); ax1.set_ylim(0, 1)
ax1.axis('off')

# Title
ax1.text(0.5, 0.97, 'ANCHOR OS — System Architecture', ha='center',
         fontsize=18, fontweight='bold', color=WHITE, family='monospace')
ax1.text(0.5, 0.945, 'Personal Decision Operating System · 8 Layers · 30 files · 14K lines',
         ha='center', fontsize=8, color=TEXT_DIM, family='monospace')

# ── USER layer (top) ─────────────────────────────────────────────────────
styled_box(ax1, 0.30, 0.87, 0.40, 0.05, 'USER', 'Browser · Voice · Telegram · iMessage', CYAN)

# ── L7 TRANSPORT ─────────────────────────────────────────────────────────
y7 = 0.78
styled_box(ax1, 0.05, y7, 0.18, 0.06, 'HTTP/REST', '14 route files', BLUE)
styled_box(ax1, 0.25, y7, 0.15, 0.06, 'SSE Stream', 'advisor/stream', BLUE)
styled_box(ax1, 0.42, y7, 0.15, 0.06, 'WebSocket', '/ws real-time', BLUE)
styled_box(ax1, 0.59, y7, 0.18, 0.06, 'Telegram Bot', '/today /status', BLUE)
styled_box(ax1, 0.79, y7, 0.18, 0.06, 'iMessage', 'AppleScript R/W', BLUE)
ax1.text(0.01, y7+0.03, 'L7\nSURFACE', fontsize=7, color=BLUE, fontweight='bold', family='monospace', va='center')
arrow(ax1, 0.50, 0.87, 0.50, 0.84, CYAN)

# ── L6 PERMISSION ────────────────────────────────────────────────────────
y6 = 0.70
styled_box(ax1, 0.15, y6, 0.22, 0.055, 'Permission Gate', 'L0→L3 trust levels', RED)
styled_box(ax1, 0.40, y6, 0.20, 0.055, 'Rate Limiter', 'per-action-class/hr', RED)
styled_box(ax1, 0.63, y6, 0.22, 0.055, 'Audit Trail', 'append-only log', RED)
ax1.text(0.01, y6+0.03, 'L6\nGATE', fontsize=7, color=RED, fontweight='bold', family='monospace', va='center')

# ── L5 EXECUTION ─────────────────────────────────────────────────────────
y5 = 0.61
styled_box(ax1, 0.08, y5, 0.22, 0.06, 'ReAct Agent', '12-turn tool loop', GREEN)
styled_box(ax1, 0.33, y5, 0.17, 0.06, 'Swarm', 'multi-agent debate', GREEN)
styled_box(ax1, 0.53, y5, 0.20, 0.06, '10 Tools', 'shell·DB·net·code', GREEN)
styled_box(ax1, 0.76, y5, 0.20, 0.06, 'Checkpoints', 'crash recovery', GREEN)
ax1.text(0.01, y5+0.03, 'L5\nEXEC', fontsize=7, color=GREEN, fontweight='bold', family='monospace', va='center')

# ── L4 ORCHESTRATION ──────────────────────────────────────────────────────
y4 = 0.51
styled_box(ax1, 0.08, y4, 0.20, 0.06, 'Event Bus', '7 event types', AMBER)
styled_box(ax1, 0.31, y4, 0.20, 0.06, 'Handlers', 'dispatch + retry', AMBER)
styled_box(ax1, 0.54, y4, 0.20, 0.06, '10 Cron Jobs', '5min→weekly', AMBER)
styled_box(ax1, 0.77, y4, 0.19, 0.06, 'Proactive', 'push notifications', AMBER)
ax1.text(0.01, y4+0.03, 'L4\nORCH', fontsize=7, color=AMBER, fontweight='bold', family='monospace', va='center')

# ── L3 COGNITION ──────────────────────────────────────────────────────────
y3 = 0.39
styled_box(ax1, 0.05, y3, 0.22, 0.08, 'Decision Agent', '5-stage pipeline\n+intent classify\n+skill match', PRIMARY)
styled_box(ax1, 0.29, y3, 0.17, 0.08, 'Twin Agent', 'behavioral\nlearning\n4 sources', PURPLE)
styled_box(ax1, 0.48, y3, 0.17, 0.08, 'Evolution', 'auto-tune\n5 dimensions\ndaily 4am', ROSE)
styled_box(ax1, 0.67, y3, 0.14, 0.08, 'Skills', 'crystallize\nfrom patterns', CYAN)
styled_box(ax1, 0.83, y3, 0.14, 0.08, 'Extractor', 'NLP→nodes\n+edges', GREEN)
ax1.text(0.01, y3+0.04, 'L3\nCOGN', fontsize=7, color=PRIMARY, fontweight='bold', family='monospace', va='center')

# ── L2 MEMORY ─────────────────────────────────────────────────────────────
y2 = 0.28
styled_box(ax1, 0.10, y2, 0.25, 0.07, 'Memory Retrieval', 'working · episodic · semantic\nscored: confidence×recency×kw', PURPLE)
styled_box(ax1, 0.38, y2, 0.25, 0.07, 'Dream Engine', '3am: prune · merge · promote\nskill create · capacity enforce', PURPLE)
styled_box(ax1, 0.66, y2, 0.25, 0.07, 'FTS5 Search', 'full-text index\nhybrid keyword+relevance', PURPLE)
ax1.text(0.01, y2+0.035, 'L2\nMEM', fontsize=7, color=PURPLE, fontweight='bold', family='monospace', va='center')

# ── L1 HUMAN GRAPH ────────────────────────────────────────────────────────
y1 = 0.17
styled_box(ax1, 0.08, y1, 0.22, 0.07, 'Graph Nodes', '21 types · 5 domains\nPageRank · Entropy', CYAN)
styled_box(ax1, 0.33, y1, 0.17, 0.07, 'Graph Edges', '10 types · weight\ncreated_at', CYAN)
styled_box(ax1, 0.53, y1, 0.20, 0.07, 'Math Models', 'PageRank · Decay\nBayesian · Shannon', CYAN)
styled_box(ax1, 0.76, y1, 0.20, 0.07, 'Serializer', 'graph→LLM prompt\nPR-weighted', CYAN)
ax1.text(0.01, y1+0.035, 'L1\nGRAPH', fontsize=7, color=CYAN, fontweight='bold', family='monospace', va='center')

# ── L8 INFRASTRUCTURE ─────────────────────────────────────────────────────
y8 = 0.05
styled_box(ax1, 0.05, y8, 0.18, 0.08, 'Cortex LLM', 'text · stream\nvision · embed\nfallback chains', BLUE)
styled_box(ax1, 0.25, y8, 0.15, 0.08, 'SQLite', 'WAL · 40 tables\nFTS5 · backup', BLUE)
styled_box(ax1, 0.42, y8, 0.18, 0.08, 'Local Scan', 'browser · contacts\ncalendar · apps\nactivity monitor', BLUE)
styled_box(ax1, 0.62, y8, 0.15, 0.08, 'MCP', 'bidirectional\ntool protocol', BLUE)
styled_box(ax1, 0.79, y8, 0.17, 0.08, 'Hand', 'AppleScript\nMail·Calendar\nReminders', BLUE)
ax1.text(0.01, y8+0.04, 'L8\nINFRA', fontsize=7, color=BLUE, fontweight='bold', family='monospace', va='center')

# Key arrows showing data flow
arrow(ax1, 0.50, y7, 0.50, y7-0.02, TEXT_DIM)
arrow(ax1, 0.50, y6, 0.50, y5+0.06, TEXT_DIM)
arrow(ax1, 0.50, y5, 0.50, y4+0.06, TEXT_DIM)
arrow(ax1, 0.50, y4, 0.50, y3+0.08, TEXT_DIM)
arrow(ax1, 0.50, y3, 0.50, y2+0.07, TEXT_DIM)
arrow(ax1, 0.50, y2, 0.50, y1+0.07, TEXT_DIM)
arrow(ax1, 0.50, y1, 0.50, y8+0.08, TEXT_DIM)

fig1.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-1-overview.png', dpi=200,
            bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig1)


# ════════════════════════════════════════════════════════════════════════════
# DIAGRAM 2: Decision Pipeline — Step-by-Step Data Flow
# ════════════════════════════════════════════════════════════════════════════

fig2, ax2 = plt.subplots(1, 1, figsize=(18, 13))
fig2.patch.set_facecolor(BG)
ax2.set_facecolor(BG)
ax2.set_xlim(0, 1); ax2.set_ylim(0, 1)
ax2.axis('off')

ax2.text(0.5, 0.97, 'ANCHOR OS — Decision Pipeline (Complete Data Flow)', ha='center',
         fontsize=16, fontweight='bold', color=WHITE, family='monospace')
ax2.text(0.5, 0.95, 'What happens when user sends a message', ha='center',
         fontsize=8, color=TEXT_DIM, family='monospace')

# Step numbers
steps = [
    (0.08, 0.88, '1', 'User Message', '"Should I pitch\ninvestors Tuesday?"', CYAN, 0.13),
    (0.27, 0.88, '2', 'Load Context', 'history (10 msgs)\nmemory (top 12)\ngraph (all nodes)\ntwin priors\nevolution adapt', BLUE, 0.16),
    (0.50, 0.88, '3', 'Intent Classify', 'greeting → instant\ninfo → light\ndecision → full\nexec → direct', AMBER, 0.14),
    (0.72, 0.88, '4', 'Cache Check', 'LRU 50 entries\n5min TTL\nkey=msg+graph_ver\n+mem_ver+hist', GREEN, 0.14),
]

for x, y, num, title, desc, color, w in steps:
    styled_box(ax2, x, y, w, 0.09, title, desc, color, 8)
    ax2.text(x + 0.005, y + 0.085, num, fontsize=7, color=color,
             fontweight='bold', family='monospace')

# Arrows between steps
arrow(ax2, 0.21, 0.925, 0.27, 0.925, TEXT_DIM)
arrow(ax2, 0.43, 0.925, 0.50, 0.925, TEXT_DIM)
arrow(ax2, 0.64, 0.925, 0.72, 0.925, TEXT_DIM)

# Row 2: Pipeline stages
y2r = 0.72
ax2.text(0.5, y2r + 0.09, '5-STAGE LLM PIPELINE', ha='center',
         fontsize=10, fontweight='bold', color=PRIMARY, family='monospace')

stages = [
    (0.04, y2r, 'Stage 1', 'CONSTRAINT\nEXTRACTION', 'deadlines\nblockers\nconflicts', RED),
    (0.22, y2r, 'Stage 2', 'OPTION\nGENERATION', '2-3 candidates\nconsidering\nconstraints', BLUE),
    (0.40, y2r, 'Stage 3', 'TWIN\nALIGNMENT', 'check against\nbehavioral\npriors', PURPLE),
    (0.58, y2r, 'Stage 4', 'BOUNDARY\nCLASSIFY', 'risk: low|high\napproval level\nexternal?money?', AMBER),
    (0.76, y2r, 'Stage 5', 'DELTA\nSELECTION', 'best option\nwhy NOW\nnot tomorrow', GREEN),
]

for x, y, label, title, desc, color in stages:
    styled_box(ax2, x, y, 0.16, 0.08, title, desc, color, 7)
    ax2.text(x + 0.005, y + 0.075, label, fontsize=5.5, color=color,
             fontweight='bold', family='monospace')

for i in range(4):
    x1 = stages[i][0] + 0.16
    x2 = stages[i+1][0]
    arrow(ax2, x1, y2r + 0.04, x2, y2r + 0.04, PRIMARY)

# Row 3: Post-pipeline
y3r = 0.57
styled_box(ax2, 0.05, y3r, 0.18, 0.07, '6  JSON Parse', 'extract structured\nauto-repair truncated\nfallback to plain text', BLUE, 8)
styled_box(ax2, 0.26, y3r, 0.18, 0.07, '7  Failure Detect', '8 cognitive modes\ncontext starvation\nover-planning\nconflict suppress', RED, 8)
styled_box(ax2, 0.47, y3r, 0.18, 0.07, '8  Confidence\n    Verify', 'independent LLM\nrecalibrate if\ngap > 0.3', AMBER, 8)
styled_box(ax2, 0.68, y3r, 0.18, 0.07, '9  Swarm?', 'low confidence OR\nmany steps OR\nmulti-domain\n→ debate', PURPLE, 8)

arrow(ax2, 0.50, y2r, 0.50, y3r + 0.07, PRIMARY)
arrow(ax2, 0.23, y3r + 0.035, 0.26, y3r + 0.035, TEXT_DIM)
arrow(ax2, 0.44, y3r + 0.035, 0.47, y3r + 0.035, TEXT_DIM)
arrow(ax2, 0.65, y3r + 0.035, 0.68, y3r + 0.035, TEXT_DIM)

# Row 4: Response + Confirm flow
y4r = 0.42
styled_box(ax2, 0.10, y4r, 0.25, 0.08, '10  Return to User', 'structured plan\neditable steps\nconfidence score\nwhy-this-now\nstages trace', CYAN, 9)

styled_box(ax2, 0.42, y4r, 0.22, 0.08, '11  User Confirms', 'edit steps → diff\nsatisfaction signal\nskill crystallize?\nbus: USER_CONFIRMED', GREEN, 9)

styled_box(ax2, 0.72, y4r, 0.22, 0.08, '12  Execute Plan', 'ReAct loop (12 turns)\n10 tools available\nL6 gate per tool\ncheckpoint each step', PRIMARY, 9)

arrow(ax2, 0.35, y4r + 0.04, 0.42, y4r + 0.04, TEXT_DIM)
arrow(ax2, 0.64, y4r + 0.04, 0.72, y4r + 0.04, TEXT_DIM)
arrow(ax2, 0.50, y3r, 0.30, y4r + 0.08, TEXT_DIM)

# Row 5: After execution
y5r = 0.27
styled_box(ax2, 0.05, y5r, 0.20, 0.07, '13  Twin Learns', 'edit diffs → insight\ncontraindications\ndialect tensions\ndrift detection', PURPLE, 8)
styled_box(ax2, 0.28, y5r, 0.20, 0.07, '14  Memory Write', 'episodic: what happened\nsemantic: stable fact\nworking: temp context', PURPLE, 8)
styled_box(ax2, 0.51, y5r, 0.20, 0.07, '15  Graph Update', 'decision node created\nstatus changes\nedge weights adjust', CYAN, 8)
styled_box(ax2, 0.74, y5r, 0.20, 0.07, '16  Skill Check', '3+ similar plans?\n→ crystallize skill\nnext time: fast path', GREEN, 8)

arrow(ax2, 0.83, y4r, 0.83, y5r + 0.07, AMBER)
ax2.text(0.85, (y4r + y5r + 0.07)/2, 'EXECUTION_DONE\nevent', fontsize=6, color=AMBER,
         family='monospace', ha='left')

# Row 6: Night cycle
y6r = 0.12
ax2.text(0.5, y6r + 0.09, 'OVERNIGHT LEARNING CYCLE', ha='center',
         fontsize=10, fontweight='bold', color=ROSE, family='monospace')

styled_box(ax2, 0.03, y6r, 0.18, 0.07, '3am Dream', 'prune stale memory\nmerge contradictions\npromote patterns\ncreate skills', ROSE, 8)
styled_box(ax2, 0.23, y6r, 0.18, 0.07, '4am Evolution', 'capture signals\ndeviation analysis\npattern detection\ntune 5 dimensions', ROSE, 8)
styled_box(ax2, 0.43, y6r, 0.18, 0.07, '8am Digest', 'overdue items\nurgent flags\n3-bullet briefing', AMBER, 8)
styled_box(ax2, 0.63, y6r, 0.18, 0.07, '9am Twin', 'weekly reflection\nbehavior drift\nnew insights', PURPLE, 8)
styled_box(ax2, 0.83, y6r, 0.13, 0.07, 'Every 5m\nActivity', 'app + window\ntitle capture', BLUE, 7)

for i in range(3):
    x1 = [0.03, 0.23, 0.43, 0.63][i] + 0.18
    x2 = [0.23, 0.43, 0.63][i]
    arrow(ax2, x1, y6r + 0.035, x2, y6r + 0.035, TEXT_DIM)

fig2.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-2-pipeline.png', dpi=200,
            bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig2)


# ════════════════════════════════════════════════════════════════════════════
# DIAGRAM 3: Learning Loop — How the System Gets Smarter
# ════════════════════════════════════════════════════════════════════════════

fig3, ax3 = plt.subplots(1, 1, figsize=(16, 12))
fig3.patch.set_facecolor(BG)
ax3.set_facecolor(BG)
ax3.set_xlim(0, 1); ax3.set_ylim(0, 1)
ax3.axis('off')

ax3.text(0.5, 0.97, 'ANCHOR OS — Self-Improving Learning Loop', ha='center',
         fontsize=16, fontweight='bold', color=WHITE, family='monospace')
ax3.text(0.5, 0.945, 'The system learns from every interaction — no user configuration needed',
         ha='center', fontsize=8, color=TEXT_DIM, family='monospace')

# Center: Decision Agent
cx, cy = 0.5, 0.52
styled_box(ax3, cx-0.12, cy-0.05, 0.24, 0.10, 'Decision Agent', '5-stage pipeline\ncontext-aware\nadaptive prompts', PRIMARY, 10)

# 4 learning inputs (corners)
# Top-left: User feedback
styled_box(ax3, 0.05, 0.80, 0.25, 0.10, 'User Feedback', 'confirm plan → positive signal\nreject plan → negative signal\nedit steps → modification signal\nmessage length → tone signal', GREEN, 8)

# Top-right: Local data
styled_box(ax3, 0.70, 0.80, 0.25, 0.10, 'Local Data Ingestion', 'browser history (Chrome/Safari)\ncontacts (AppleScript)\ncalendar events\nactive window (every 5min)', BLUE, 8)

# Bottom-left: Twin Agent
styled_box(ax3, 0.02, 0.15, 0.28, 0.12, 'Twin Agent', 'LEARNS FROM:\n• edit diffs → contraindications\n• execution results → quality\n• accept/reject → preference\n• drift detection (weekly)', PURPLE, 8)

# Bottom-right: Evolution Engine
styled_box(ax3, 0.70, 0.15, 0.28, 0.12, 'Evolution Engine', 'AUTO-TUNES:\n• decision_style (cautious↔aggressive)\n• plan_complexity (simple↔detailed)\n• communication_tone (direct↔analytical)\n• domain_weights (work:0.5, health:0.3)\n• time_preference (peak: 10am)', ROSE, 8)

# Left side: Memory + Dream
styled_box(ax3, 0.02, 0.42, 0.22, 0.12, 'Memory System', 'working (7 days)\nepisodic (30 days)\nsemantic (permanent)\n\nscored retrieval:\nconfidence × recency × kw', PURPLE, 8)

# Right side: Skills
styled_box(ax3, 0.76, 0.42, 0.22, 0.12, 'Skills Engine', '3+ confirmed plans\n→ crystallize template\n\nnext match → skip LLM\ncheap model adapts\n\nreject 3x → retire', CYAN, 8)

# Top center: Graph
styled_box(ax3, 0.35, 0.82, 0.30, 0.08, 'Human Graph', '21 node types · 10 edge types · 5 domains\nPageRank importance · Decay health · Bayesian confidence', CYAN, 8)

# Bottom center: Dream Engine
styled_box(ax3, 0.33, 0.05, 0.34, 0.08, 'Dream Engine (3am)', 'prune low-signal · merge contradictions · promote patterns\ncreate skills from execution logs · enforce 200-memory cap', ROSE, 8)

# ── Arrows showing the learning loop ─────────────────────────────────────

# User → Decision (sends message)
label_arrow(ax3, 0.18, 0.80, 0.42, 0.62, 'message + history', GREEN)

# Decision → User (returns plan)
label_arrow(ax3, 0.42, 0.57, 0.18, 0.87, 'plan with steps', PRIMARY)

# User feedback → Twin (confirm/reject/edit)
label_arrow(ax3, 0.10, 0.80, 0.10, 0.27, 'confirm/reject/edit signals', GREEN)

# Twin → Decision (behavioral priors)
label_arrow(ax3, 0.30, 0.21, 0.42, 0.47, 'twin priors + contraindications', PURPLE)

# Evolution → Decision (prompt adaptations)
label_arrow(ax3, 0.70, 0.21, 0.58, 0.47, 'prompt adaptations', ROSE)

# Memory ↔ Decision
label_arrow(ax3, 0.24, 0.50, 0.38, 0.52, 'scored memories', PURPLE)
label_arrow(ax3, 0.38, 0.48, 0.24, 0.46, 'write episodic', TEXT_DIM)

# Skills ↔ Decision
label_arrow(ax3, 0.76, 0.50, 0.62, 0.52, 'skill match?', CYAN)
label_arrow(ax3, 0.62, 0.48, 0.76, 0.46, 'crystallize', TEXT_DIM)

# Graph → Decision
label_arrow(ax3, 0.50, 0.82, 0.50, 0.62, 'serialized context', CYAN)

# Local data → Graph
label_arrow(ax3, 0.82, 0.80, 0.62, 0.87, 'scan → nodes', BLUE)

# Dream → Memory
label_arrow(ax3, 0.33, 0.09, 0.15, 0.42, 'prune/merge/promote', ROSE)

# Dream → Skills
label_arrow(ax3, 0.67, 0.09, 0.85, 0.42, 'create skills from logs', ROSE)

# Twin → Evolution (signals)
curved_arrow(ax3, 0.30, 0.17, 0.70, 0.17, AMBER, -0.15)
ax3.text(0.50, 0.10, 'satisfaction signals', ha='center', fontsize=6,
         color=AMBER, family='monospace', style='italic')

# The key insight box
ax3.add_patch(FancyBboxPatch((0.25, 0.33), 0.50, 0.04,
              boxstyle="round,pad=0.01", facecolor=AMBER+'22',
              edgecolor=AMBER, linewidth=1.5, linestyle='--'))
ax3.text(0.50, 0.35, 'EVERY INTERACTION TEACHES THE SYSTEM — User does nothing special',
         ha='center', va='center', fontsize=8, fontweight='bold', color=AMBER, family='monospace')

fig3.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-3-learning.png', dpi=200,
            bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig3)

print("Generated 3 diagrams:")
print("  1. docs/arch-1-overview.png  — 8-layer system architecture")
print("  2. docs/arch-2-pipeline.png  — Decision pipeline step-by-step")
print("  3. docs/arch-3-learning.png  — Self-improving learning loop")
