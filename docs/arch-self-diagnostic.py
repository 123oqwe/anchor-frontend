"""
Self-Diagnostic Agent — the agent that watches all other agents
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
    ax.text(x+w/2, y+h-0.013, title, ha='center', va='top',
            fontsize=fs, fontweight='bold', color=WHITE, family='monospace')
    for i, item in enumerate(items):
        ax.text(x+w/2, y+h-0.03-(i+1)*0.015, item, ha='center', va='top',
                fontsize=5.5, color=DIM, family='monospace')

def arr(ax, x1, y1, x2, y2, color=MUTED, lw=0.8):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, connectionstyle='arc3,rad=0.05'))

def darr(ax, x1, y1, x2, y2, color=MUTED, lw=0.6):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, linestyle='dashed', connectionstyle='arc3,rad=0.08'))


fig, ax = plt.subplots(1, 1, figsize=(22, 16))
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)
ax.set_xlim(0, 1); ax.set_ylim(0, 1)
ax.axis('off')

ax.text(0.5, 0.985, 'SELF-DIAGNOSTIC AGENT — The Agent That Watches All Agents', ha='center',
        fontsize=18, fontweight='bold', color=WHITE, family='monospace')
ax.text(0.5, 0.965, 'Runs weekly · Checks if self-improvement loop works · Auto-fixes thresholds · Recommends GEPA at Day 60',
        ha='center', fontsize=7, color=DIM, family='monospace')

# ═══════════════════════════════════════════════════════════════
# CENTER: The Diagnostic Agent
# ═══════════════════════════════════════════════════════════════

box(ax, 0.30, 0.76, 0.40, 0.12, 'SELF-DIAGNOSTIC AGENT', [
    'Cron: every Sunday 7am (after GEPA at 5am, before user wakes up)',
    'Reads ALL system tables · generates health report',
    'Compares metrics against expected baselines per phase',
    'Auto-fixes: adjust thresholds when engines stall',
    'Escalates: push notification if manual attention needed',
    'Phase-aware: knows Day 1-30 vs Day 30-60 vs Day 60+',
    'Stores reports in diagnostic_reports table',
], PRIMARY, 10)

# ═══════════════════════════════════════════════════════════════
# TOP: What it monitors (data sources)
# ═══════════════════════════════════════════════════════════════

ax.text(0.5, 0.74, 'MONITORS (reads from these tables)', ha='center',
        fontsize=9, fontweight='bold', color=CYAN, family='monospace')

monitors = [
    (0.02, 0.65, 'messages', ['total conversations', 'confirm/reject ratio', 'avg message length', 'topic diversity'], BLUE),
    (0.18, 0.65, 'skills', ['total crystallized', 'use_count per skill', 'confidence distribution', 'retired count'], GREEN),
    (0.34, 0.65, 'evolution_state', ['dimensions updated', 'evidence_count growth', 'value stability', 'last_updated recency'], ROSE),
    (0.50, 0.65, 'twin_insights', ['total insights', 'confidence avg', 'drift detections', 'contraindications created'], PURPLE),
    (0.66, 0.65, 'llm_calls', ['total tokens spent', 'cost trend', 'failure rate', 'avg latency trend'], AMBER),
    (0.82, 0.65, 'activity_captures', ['total captures', 'app diversity', 'screen time trend', 'URL capture rate'], BLUE),
]

for x, y, title, items, color in monitors:
    box(ax, x, y, 0.15, 0.075, title, items, color, 7)
    arr(ax, x+0.075, y+0.075, 0.50, 0.76, color, 0.5)

# ═══════════════════════════════════════════════════════════════
# MIDDLE: 3 Phases
# ═══════════════════════════════════════════════════════════════

ax.text(0.5, 0.625, 'THREE PHASES', ha='center',
        fontsize=10, fontweight='bold', color=AMBER, family='monospace')

# Phase 1: Day 1-30
box(ax, 0.02, 0.44, 0.30, 0.16, 'PHASE 1: DATA ACCUMULATION (Day 1-30)', [
    'CHECKS:',
    '  conversations >= 3/day? (expect 100+ by day 30)',
    '  confirm rate > 30%? (system is somewhat useful)',
    '  twin_insights >= 1/week? (Twin is learning)',
    '  evolution dimensions > 0? (Evolution ran)',
    '  activity_captures > 200/day? (monitor working)',
    '',
    'AUTO-FIX if stalled:',
    '  confirm rate < 10% → lower plan complexity',
    '  0 skills after 30 days → lower crystallize threshold to 2',
    '  Evolution empty → run manually + check signals',
], GREEN, 8)

# Phase 2: Day 30-60
box(ax, 0.35, 0.44, 0.30, 0.16, 'PHASE 2: QUALITY CHECK (Day 30-60)', [
    'CHECKS:',
    '  confirm rate trending UP? (system improving)',
    '  skills reuse > 0? (crystallized skills are useful)',
    '  Evolution stable? (dimensions stopped oscillating)',
    '  avg tokens/decision trending DOWN? (efficiency)',
    '  Dream pruned > 0? (memory not bloating)',
    '',
    'AUTO-FIX if stalled:',
    '  skills never reused → widen keyword match to 40%',
    '  tokens not decreasing → tighten graph serialization',
    '  confirm rate flat → adjust communication_tone',
    '  too many failures → lower GEPA aggressiveness',
], AMBER, 8)

# Phase 3: Day 60+
box(ax, 0.68, 0.44, 0.30, 0.16, 'PHASE 3: ADVANCED OPTIMIZATION (Day 60+)', [
    'CHECKS:',
    '  enough data for GEPA? (100+ sessions)',
    '  skill quality stable? (no more retirement)',
    '  prompt length optimal? (not growing unbounded)',
    '  user satisfaction trend (confirm + feedback)',
    '',
    'RECOMMEND if data supports:',
    '  "Ready for GEPA prompt evolution" → notify user',
    '  "Skill PR gate recommended" → add review step',
    '  "Consider Pareto selection" → multi-objective',
    '',
    'NEVER auto-apply GEPA — always recommend + explain',
], RED, 8)

# Phase arrows
arr(ax, 0.32, 0.52, 0.35, 0.52, AMBER, 1.2)
arr(ax, 0.65, 0.52, 0.68, 0.52, AMBER, 1.2)

# ═══════════════════════════════════════════════════════════════
# BOTTOM: Outputs
# ═══════════════════════════════════════════════════════════════

ax.text(0.5, 0.415, 'OUTPUTS', ha='center',
        fontsize=10, fontweight='bold', color=GREEN, family='monospace')

# Output 1: Weekly Report
box(ax, 0.02, 0.26, 0.22, 0.13, 'Weekly Health Report', [
    'Stored in diagnostic_reports table',
    'Dashboard shows latest report',
    '',
    'Format:',
    '  Phase: 1 (Day 12/30)',
    '  Conversations: 45 (+8 this week)',
    '  Confirm Rate: 62% (up from 55%)',
    '  Skills: 0 crystallized (expect 1-3)',
    '  Evolution: 2/5 dims updated',
    '  Overall: ON TRACK',
], GREEN, 8)

# Output 2: Auto-fixes
box(ax, 0.27, 0.26, 0.22, 0.13, 'Auto-Fixes Applied', [
    'Adjusts thresholds automatically:',
    '',
    '  skills.crystallize_min: 3 → 2',
    '  (if 0 skills after 20 days)',
    '',
    '  skills.match_threshold: 0.6 → 0.4',
    '  (if skills exist but never match)',
    '',
    '  evolution.min_signals: 2 → 1',
    '  (if evolution never runs)',
    '',
    'All changes logged + reversible',
], AMBER, 8)

# Output 3: Notifications
box(ax, 0.52, 0.26, 0.22, 0.13, 'Proactive Notifications', [
    'Push to Dashboard + Telegram:',
    '',
    '  Day 7: "System learning well —',
    '    Twin extracted 3 insights"',
    '',
    '  Day 14: "Warning: confirm rate < 20%',
    '    Consider adjusting plan complexity"',
    '',
    '  Day 30: "Phase 1 complete. Report ready."',
    '',
    '  Day 60: "Enough data for GEPA.',
    '    Want me to enable prompt evolution?"',
], BLUE, 8)

# Output 4: GEPA Readiness
box(ax, 0.77, 0.26, 0.21, 0.13, 'GEPA Readiness Score', [
    'Computed at Day 60+:',
    '',
    '  Sessions: 150+ (need 100) .. READY',
    '  Skills: 5 (need 3) ...... READY',
    '  Confirm data: 89 ........ READY',
    '  Token baseline: stable ... READY',
    '',
    '  VERDICT: READY FOR GEPA',
    '  → Recommend to user',
    '  → User clicks "Enable"',
    '  → System starts prompt evolution',
], RED, 8)

# Arrows from diagnostic to outputs
darr(ax, 0.40, 0.76, 0.13, 0.39, GREEN, 0.8)
darr(ax, 0.45, 0.76, 0.38, 0.39, AMBER, 0.8)
darr(ax, 0.55, 0.76, 0.63, 0.39, BLUE, 0.8)
darr(ax, 0.60, 0.76, 0.87, 0.39, RED, 0.8)

# ═══════════════════════════════════════════════════════════════
# BOTTOM: Integration with existing system
# ═══════════════════════════════════════════════════════════════

ax.text(0.5, 0.235, 'HOW IT CONNECTS', ha='center',
        fontsize=9, fontweight='bold', color=PRIMARY, family='monospace')

connections = [
    (0.05, 0.13, 'Cron (cron.ts)', ['schedule("0 7 * * 0")', 'runs after GEPA (5am)', 'before user wakes up'], AMBER),
    (0.22, 0.13, 'Bus (bus.ts)', ['publishes NOTIFICATION', 'with diagnostic results', 'to Dashboard + Telegram'], AMBER),
    (0.39, 0.13, 'DB (db.ts)', ['new: diagnostic_reports table', 'new: system_config table', 'for adjustable thresholds'], CYAN),
    (0.56, 0.13, 'Dashboard', ['new: "System Diagnostic"', 'section showing latest', 'report + phase + score'], PRIMARY),
    (0.73, 0.13, 'Skills/Evolution', ['reads and WRITES thresholds', 'crystallize_min', 'match_threshold', 'min_signals'], GREEN),
]

for x, y, title, items, color in connections:
    box(ax, x, y, 0.15, 0.08, title, items, color, 7)

# ═══════════════════════════════════════════════════════════════
# KEY INSIGHT
# ═══════════════════════════════════════════════════════════════

ax.add_patch(FancyBboxPatch((0.15, 0.03), 0.70, 0.06, boxstyle="round,pad=0.012",
             facecolor=AMBER+'15', edgecolor=AMBER, linewidth=1.5, linestyle='--'))

ax.text(0.50, 0.075, 'THE META-AGENT: watches all other agents, ensures the self-improvement loop actually works', ha='center',
        fontsize=9, fontweight='bold', color=AMBER, family='monospace')
ax.text(0.50, 0.05, 'Phase 1: "is data flowing?" → Phase 2: "is it improving?" → Phase 3: "ready for GEPA?"', ha='center',
        fontsize=7, color=DIM, family='monospace')


fig.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-diagnostic.png', dpi=200,
           bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig)
print("Generated: docs/arch-diagnostic.png")
