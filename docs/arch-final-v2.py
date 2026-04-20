"""
Anchor OS — Final Architecture (v2, with Self-Diagnostic Agent)
79 server files · 87 client files · 34 tables · 14 cron jobs · 12 agents
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

BG = '#0a0c10'
PRIMARY = '#6366f1'; BLUE = '#3b82f6'; CYAN = '#22d3ee'; GREEN = '#10b981'
AMBER = '#f59e0b'; RED = '#ef4444'; PURPLE = '#a855f7'; ROSE = '#f43f5e'
ORANGE = '#f97316'; TEAL = '#14b8a6'; PINK = '#ec4899'
WHITE = '#f1f5f9'; DIM = '#64748b'; MUTED = '#475569'

def box(ax, x, y, w, h, title, items, color, fs=8):
    b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.01",
                       facecolor=color+'12', edgecolor=color, linewidth=1.4)
    ax.add_patch(b)
    ax.text(x+w/2, y+h-0.01, title, ha='center', va='top',
            fontsize=fs, fontweight='bold', color=WHITE, family='monospace')
    for i, item in enumerate(items):
        ax.text(x+w/2, y+h-0.025-(i+1)*0.012, item, ha='center', va='top',
                fontsize=5, color=DIM, family='monospace')

def arr(ax, x1, y1, x2, y2, color=MUTED, lw=0.7):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, connectionstyle='arc3,rad=0.04'))

fig, ax = plt.subplots(1, 1, figsize=(26, 18))
fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')

ax.text(0.5, 0.99, 'ANCHOR OS — Complete System Architecture (Final)', ha='center',
        fontsize=22, fontweight='bold', color=WHITE, family='monospace')
ax.text(0.5, 0.975, '79 server · 87 client · 21K lines · 34 tables · 14 cron · 12 agents · 15 tools · 5 channels',
        ha='center', fontsize=8, color=DIM, family='monospace')

# ═══ CHANNELS ═══
box(ax, 0.10, 0.935, 0.10, 0.025, 'Web', ['React SPA + SSE'], CYAN, 7)
box(ax, 0.22, 0.935, 0.10, 0.025, 'WebSocket', ['/ws real-time'], CYAN, 7)
box(ax, 0.34, 0.935, 0.10, 0.025, 'Telegram', ['telegraf bot'], CYAN, 7)
box(ax, 0.46, 0.935, 0.10, 0.025, 'iMessage', ['AppleScript'], CYAN, 7)
box(ax, 0.58, 0.935, 0.10, 0.025, 'MCP', ['bidirectional'], CYAN, 7)
box(ax, 0.70, 0.935, 0.10, 0.025, 'Voice', ['Web Speech'], CYAN, 7)

# ═══ L7 SURFACE ═══
ax.add_patch(FancyBboxPatch((0.05, 0.905), 0.90, 0.022, boxstyle="round,pad=0.005",
             facecolor=BLUE+'08', edgecolor=BLUE+'33', linewidth=0.6))
ax.text(0.02, 0.915, 'L7', fontsize=6, color=BLUE, fontweight='bold', family='monospace')
routes = 'advisor · graph · user · memory · workspace · twin · agents · admin · skills · integrations · privacy · notifications · crons · mcp'
ax.text(0.50, 0.915, routes, ha='center', fontsize=4.5, color=BLUE, family='monospace')

# ═══ L6 GATE ═══
box(ax, 0.10, 0.87, 0.25, 0.025, 'Permission Gate (4 levels L0-L3)', ['trust progression · rate limit · audit trail'], RED, 7)
box(ax, 0.37, 0.87, 0.18, 0.025, 'Emergency Lockdown', ['one-click deny all'], RED, 7)
box(ax, 0.57, 0.87, 0.20, 0.025, 'Contract Violations', ['derived-write prohibition'], RED, 7)

# ═══ L5 EXEC ═══
box(ax, 0.05, 0.825, 0.20, 0.03, 'Execution Agent', ['ReAct 12 turns · checkpoint · tool compose'], GREEN, 7)
box(ax, 0.27, 0.825, 0.25, 0.03, '15 Tools', ['DB: write_task · update_graph · record_outcome', 'Shell: email · calendar · reminder · open_url', 'Net: web_search · read_url | Code: run_code', 'Browser: navigate · screenshot · click · type · extract'], GREEN, 6)
box(ax, 0.54, 0.825, 0.13, 0.03, 'Exec Swarm', ['parallel phases', 'fallback sequential'], GREEN, 7)

# ═══ L4 ORCH ═══
box(ax, 0.05, 0.77, 0.15, 0.04, 'Event Bus', ['7 event types', 'USER_CONFIRMED', 'EXECUTION_DONE', 'TWIN_UPDATED', 'NOTIFICATION...'], AMBER, 7)
box(ax, 0.22, 0.77, 0.13, 0.04, 'Handlers', ['dispatch + retry 2x', 'handoff validation', 'dead letter'], AMBER, 7)
box(ax, 0.37, 0.77, 0.17, 0.04, '14 Cron Jobs', ['5min: activity', '3am: dream · 4am: evolution', '8am: digest · 10pm: tasks', 'Sun: GEPA · SysEvo · Diagnostic'], AMBER, 7)
box(ax, 0.56, 0.77, 0.14, 0.04, 'Proactive', ['decay alerts', 'overdue tasks', 'outcome follow-up'], AMBER, 7)
box(ax, 0.72, 0.77, 0.15, 0.04, 'Recommendations', ['pattern → suggest', 'agent/cron/skill', 'one-click accept'], ORANGE, 7)

# ═══ L3 COGNITION ═══
ax.text(0.02, 0.755, 'L3', fontsize=6, color=PRIMARY, fontweight='bold', family='monospace')

# Main agents
box(ax, 0.03, 0.665, 0.22, 0.07, 'Decision Agent', [
    'intent classify (local, 0 LLM)', 'cache LRU 50, 5min TTL',
    'skill match → fast path', '5-stage: constraint→option→twin→risk→select',
    'cognitive failure detect (8 modes)', 'trajectory confidence verify'], PRIMARY, 8)

box(ax, 0.27, 0.665, 0.17, 0.07, 'Twin Agent', [
    'learn from:', '  edit diffs → contraindications',
    '  exec results → quality', '  accept/reject → prefs',
    '  weekly drift detection', 'dialectic modeling'], PURPLE, 7)

box(ax, 0.46, 0.665, 0.17, 0.07, 'Evolution Engine', [
    'auto-tune daily 4am:', '  decision_style',
    '  plan_complexity', '  communication_tone',
    '  domain_weights', '  time_preference',
    'reads system_config thresholds'], ROSE, 7)

box(ax, 0.65, 0.665, 0.15, 0.07, 'Skills Engine', [
    '5 templates + auto:', '  3+ confirms → crystallize',
    '  match → skip pipeline', '  edit → evolve',
    '  reject 3x → retire', 'reads system_config thresholds'], TEAL, 7)

box(ax, 0.82, 0.665, 0.16, 0.07, 'Self-Diagnostic', [
    'PURE SQL, 0 LLM', '9 health checks weekly',
    'Phase by data volume:', '  1: accumulate → 2: quality',
    '  → 3: GEPA readiness', 'auto-fix via system_config',
    'baseline first 2 weeks'], RED, 7)

# Support agents
box(ax, 0.03, 0.61, 0.11, 0.04, 'Extractor', ['msg → nodes', 'quality filter'], GREEN, 6)
box(ax, 0.16, 0.61, 0.11, 0.04, 'Self-Portrait', ['5 layers math', 'entropy · decay'], ROSE, 6)
box(ax, 0.29, 0.61, 0.11, 0.04, 'Cogn. Swarm', ['3-role debate', 'Adv→Crit→Judge'], ORANGE, 6)
box(ax, 0.42, 0.61, 0.11, 0.04, 'Observation', ['graph→memory', 'cascade unlock'], BLUE, 6)
box(ax, 0.55, 0.61, 0.11, 0.04, 'GEPA', ['trace analysis', 'auto route_override'], RED, 6)
box(ax, 0.68, 0.61, 0.11, 0.04, 'Sparse', ['5 micro-analysts', '<5 nodes fallback'], PURPLE, 6)

# Custom agents
ax.add_patch(FancyBboxPatch((0.03, 0.575), 0.94, 0.025, boxstyle="round,pad=0.005",
             facecolor=CYAN+'08', edgecolor=CYAN+'33', linewidth=0.8, linestyle='--'))
ax.text(0.50, 0.59, 'USER CUSTOM AGENTS — NL creation · independent memory · Twin feedback · persona overlay on Decision Agent',
        ha='center', fontsize=5.5, color=CYAN, family='monospace')

# ═══ L2 MEMORY ═══
box(ax, 0.05, 0.52, 0.22, 0.04, 'Memory Retrieval', ['working(7d) · episodic(30d) · semantic(perm)', 'scored: confidence x recency x keyword', 'FTS5 search · nudge · snapshot freeze'], PURPLE, 7)
box(ax, 0.29, 0.52, 0.22, 0.04, 'Dream Engine (3am)', ['prune · merge contradictions · promote', 'create skills · capacity enforce (200)', 'time normalize · expire temporal edges'], ROSE, 7)
box(ax, 0.53, 0.52, 0.15, 0.04, 'Dialectic', ['stated vs observed', 'tension modeling', 'writeDialecticInsight'], PURPLE, 7)

# ═══ L1 GRAPH ═══
box(ax, 0.05, 0.465, 0.20, 0.04, 'Graph Nodes', ['21 types x 5 domains', 'PageRank · Entropy · Decay · Bayesian', 'status: active→decaying→done...'], CYAN, 7)
box(ax, 0.27, 0.465, 0.15, 0.04, 'Graph Edges', ['10 types · weight 0-1', 'valid_from / valid_to', 'auto-expire in Dream'], CYAN, 7)
box(ax, 0.44, 0.465, 0.13, 0.04, 'Serializer', ['graph → LLM prompt', 'PR-weighted order', 'edge + state inject'], CYAN, 7)

# ═══ L8 INFRA ═══
box(ax, 0.05, 0.395, 0.17, 0.05, 'Cortex LLM', ['text · stream · tools · vision · embed', 'task→capability→tier routing', 'fallback chain · telemetry', 'Anthropic · OpenAI · Google'], BLUE, 7)
box(ax, 0.24, 0.395, 0.12, 0.05, 'SQLite', ['34 tables · WAL', '21 indexes · FTS5', 'daily backup 2:55am', 'system_config table'], BLUE, 7)
box(ax, 0.38, 0.395, 0.20, 0.05, 'Local Integrations', ['browser-history (Chrome/Safari/Arc)', 'contacts · calendar (AppleScript)', 'activity-monitor (app+title+URL)', 'people-extractor · deep-scan · finance'], BLUE, 7)
box(ax, 0.60, 0.395, 0.12, 0.05, 'MCP Server', ['outbound: tools', 'inbound: connect', 'external servers'], BLUE, 7)
box(ax, 0.74, 0.395, 0.12, 0.05, 'Hand', ['AppleScript tools', 'Playwright (opt)', 'Mail · Calendar'], BLUE, 7)

# ═══ FRONTEND ═══
ax.text(0.02, 0.375, 'CLIENT', fontsize=6, color=PINK, fontweight='bold', family='monospace')

pages = [
    (0.05, 'Dashboard', ['mirror · suggestions', 'diagnostic · decay', 'twin · evolution']),
    (0.17, 'Advisor', ['SSE stream · plans', 'confirm/reject', 'voice input']),
    (0.29, 'Agents', ['NL create · chat', 'crons · skills', 'templates · feedback']),
    (0.41, 'Twin', ['XP · quests', '4 levels', 'insights']),
    (0.53, 'Memory', ['3 layers', 'search · add', 'agent stats']),
    (0.65, 'Workspace', ['projects · tasks', 'kanban · subtasks', 'priority']),
    (0.77, 'Settings', ['profile · models', 'privacy · notif', 'telegram · activity']),
]
for x, name, items in pages:
    box(ax, x, 0.32, 0.10, 0.04, name, items, PINK, 6)

box(ax, 0.89, 0.32, 0.09, 0.04, 'Admin', ['5 areas · 12 pages', ':3001 separate', 'process'], PINK, 6)

# ═══ SELF-IMPROVEMENT LOOP ═══
ax.add_patch(FancyBboxPatch((0.05, 0.04), 0.90, 0.09, boxstyle="round,pad=0.01",
             facecolor='#ffffff04', edgecolor=AMBER+'55', linewidth=1.2))

ax.text(0.50, 0.125, 'SELF-IMPROVEMENT LOOP', ha='center',
        fontsize=11, fontweight='bold', color=AMBER, family='monospace')

steps = [
    ('User\nmessage', CYAN, 0.08),
    ('Decision\n5-stage', PRIMARY, 0.19),
    ('Plan\nreturned', GREEN, 0.30),
    ('User\nconfirm/edit', CYAN, 0.41),
    ('Twin\nlearns', PURPLE, 0.52),
    ('Evolution\ntunes', ROSE, 0.63),
    ('Skills\ncrystallize', TEAL, 0.74),
    ('Diagnostic\nmonitors', RED, 0.85),
]

for label, color, x in steps:
    ax.text(x, 0.08, label, ha='center', va='center', fontsize=6.5, color=color,
            family='monospace', fontweight='bold')

for i in range(len(steps)-1):
    arr(ax, steps[i][2]+0.04, 0.08, steps[i+1][2]-0.04, 0.08, MUTED, 0.7)

# Loop back arrow
ax.annotate('', xy=(0.08, 0.055), xytext=(0.85, 0.055),
            arrowprops=dict(arrowstyle='->', color=AMBER, lw=1.0,
                           connectionstyle='arc3,rad=-0.12'))
ax.text(0.46, 0.045, 'next response automatically better · diagnostic auto-fixes if stalled',
        ha='center', fontsize=5.5, color=AMBER, family='monospace', style='italic')

# Layer labels
for y, label, color in [(0.915, 'L7', BLUE), (0.88, 'L6', RED), (0.84, 'L5', GREEN),
                         (0.79, 'L4', AMBER), (0.71, 'L3', PRIMARY), (0.53, 'L2', PURPLE),
                         (0.48, 'L1', CYAN), (0.42, 'L8', BLUE)]:
    ax.text(0.02, y, label, fontsize=6, color=color, fontweight='bold', family='monospace')

# Key data flow arrows
arr(ax, 0.50, 0.935, 0.50, 0.927, CYAN, 0.5)
arr(ax, 0.50, 0.905, 0.50, 0.895, BLUE, 0.5)

# Stats
stats = [
    'SERVER: 79 files, 14K lines',
    'CLIENT: 87 files, 7K lines',
    'TABLES: 34 + FTS5',
    'AGENTS: 12 system + N custom',
    'TOOLS:  15 (10+5 browser)',
    'CRONS:  14 scheduled',
    'CHANNELS: 6',
    'SKILLS: 5 templates + auto',
    'EVENTS: 7 bus types',
    'MATH: 4 models',
    'TRUST: 4 levels L0-L3',
    'ADMIN: 5 areas, 12 pages',
]
for i, s in enumerate(stats):
    ax.text(0.89, 0.29 - i*0.012, s, fontsize=4.5, color=DIM, family='monospace')

fig.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-final-v2.png', dpi=200,
           bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig)
print("Generated: docs/arch-final-v2.png")
