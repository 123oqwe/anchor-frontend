"""
Anchor OS — Definitive Architecture Diagram (from GitHub main)
78 server files · 86 client files · 20K+ lines · 32 tables
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import numpy as np

BG = '#0a0c10'
CARD = '#141820'
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
PINK = '#ec4899'
WHITE = '#f1f5f9'
DIM = '#64748b'
MUTED = '#475569'

def box(ax, x, y, w, h, title, items, color, title_fs=9):
    b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012",
                       facecolor=color+'15', edgecolor=color, linewidth=1.6)
    ax.add_patch(b)
    ax.text(x+w/2, y+h-0.012, title, ha='center', va='top',
            fontsize=title_fs, fontweight='bold', color=WHITE, family='monospace')
    for i, item in enumerate(items):
        ax.text(x+w/2, y+h-0.028-(i+1)*0.013, item, ha='center', va='top',
                fontsize=5.5, color=DIM, family='monospace')

def label_box(ax, x, y, text, color, fs=7):
    ax.text(x, y, text, fontsize=fs, fontweight='bold', color=color, family='monospace', va='center')

def arr(ax, x1, y1, x2, y2, color=MUTED, lw=0.8):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, connectionstyle='arc3,rad=0.05'))

def darr(ax, x1, y1, x2, y2, color=MUTED, lw=0.6):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, linestyle='dashed', connectionstyle='arc3,rad=0.05'))

def biarr(ax, x1, y1, x2, y2, color=MUTED, lw=0.8):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='<->', color=color, lw=lw, connectionstyle='arc3,rad=0.05'))


# ════════════════════════════════════════════════════════════════════════════
fig, ax = plt.subplots(1, 1, figsize=(24, 18))
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)
ax.set_xlim(0, 1); ax.set_ylim(0, 1)
ax.axis('off')

# Title
ax.text(0.5, 0.985, 'ANCHOR OS — Complete System Architecture', ha='center',
        fontsize=22, fontweight='bold', color=WHITE, family='monospace')
ax.text(0.5, 0.97, '78 server files · 86 client files · 20,310 lines · 32 tables · 21 indexes',
        ha='center', fontsize=8, color=DIM, family='monospace')
ax.text(0.5, 0.958, 'github.com/123oqwe/anchor · main branch · commit 5887339',
        ha='center', fontsize=7, color=MUTED, family='monospace')

# ═══════════════════════════════════════════════════════════════
# TOP: User + Channels
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.94, 'CHANNELS', CYAN, 8)

box(ax, 0.12, 0.92, 0.12, 0.035, 'Web App', ['React SPA · SSE · WebSocket'], CYAN)
box(ax, 0.26, 0.92, 0.12, 0.035, 'Telegram', ['telegraf · /today /status'], CYAN)
box(ax, 0.40, 0.92, 0.12, 0.035, 'iMessage', ['AppleScript R/W Messages.app'], CYAN)
box(ax, 0.54, 0.92, 0.12, 0.035, 'Voice', ['Web Speech API · Cmd+Shift'], CYAN)
box(ax, 0.68, 0.92, 0.12, 0.035, 'MCP', ['bidirectional · tool protocol'], CYAN)

# ═══════════════════════════════════════════════════════════════
# L7: Surface (14 routes)
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.895, 'L7 SURFACE', BLUE, 8)
ax.add_patch(FancyBboxPatch((0.12, 0.87), 0.76, 0.04, boxstyle="round,pad=0.008",
             facecolor=BLUE+'10', edgecolor=BLUE+'44', linewidth=0.8))

routes = ['advisor', 'graph', 'user', 'memory', 'workspace', 'twin', 'agents',
          'admin', 'skills', 'integrations', 'privacy', 'notifications', 'crons', 'mcp']
for i, r in enumerate(routes):
    x = 0.13 + i * 0.053
    ax.text(x, 0.885, r, fontsize=4.5, color=BLUE, family='monospace', ha='center')

ax.text(0.90, 0.885, '14 routes', fontsize=5.5, color=BLUE, family='monospace', fontweight='bold')

# Arrows from channels to surface
for x in [0.18, 0.32, 0.46, 0.60, 0.74]:
    arr(ax, x, 0.92, x, 0.91, CYAN, 0.6)

# ═══════════════════════════════════════════════════════════════
# L6: Permission Gate
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.845, 'L6 GATE', RED, 8)

box(ax, 0.12, 0.825, 0.18, 0.04, 'Permission Gate', ['L0 read → L1 draft → L2 confirm → L3 auto', 'trust progression · rate limiting'], RED)
box(ax, 0.32, 0.825, 0.15, 0.04, 'Audit Trail', ['append-only · permission_audit table', 'all outcomes logged'], RED)
box(ax, 0.49, 0.825, 0.15, 0.04, 'Emergency', ['lockdown mode · contract violations', 'derived-write prohibition'], RED)

# ═══════════════════════════════════════════════════════════════
# L5: Execution
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.79, 'L5 EXEC', GREEN, 8)

box(ax, 0.12, 0.765, 0.20, 0.045, 'Execution Agent', ['ReAct loop · 12 turns max', 'checkpoint recovery · tool composition'], GREEN)
box(ax, 0.34, 0.765, 0.14, 0.045, '15 Tools', ['DB: write_task · update_graph · record_outcome', 'Shell: email · calendar · reminder · open_url', 'Net: web_search · read_url', 'Code: run_code (sandbox)', 'Browser: navigate · screenshot · click · type · extract'], GREEN, 7)
box(ax, 0.50, 0.765, 0.13, 0.045, 'Exec Swarm', ['parallel phases', '3+ steps → try swarm', 'fallback → sequential'], GREEN)

# ═══════════════════════════════════════════════════════════════
# L4: Orchestration
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.735, 'L4 ORCH', AMBER, 8)

box(ax, 0.12, 0.695, 0.16, 0.055, 'Event Bus', ['USER_CONFIRMED', 'EXECUTION_DONE', 'TWIN_UPDATED', 'GRAPH_UPDATED · TASK_COMPLETED', 'NOTIFICATION · SCAN_PROGRESS'], AMBER, 8)
box(ax, 0.30, 0.695, 0.14, 0.055, 'Handlers', ['event → trigger classify', '→ mode select → dispatch', 'handoff validation', 'retry 2x · dead letter'], AMBER, 8)
box(ax, 0.46, 0.695, 0.16, 0.055, '13 Cron Jobs', ['5min: activity capture', '6h: decay · ingestion · graph update', '12h: proactive push', 'daily: backup · dream · evolution · digest · tasks', 'weekly: twin · GEPA · sys-evolution'], AMBER, 8)
box(ax, 0.64, 0.695, 0.14, 0.055, 'Proactive Agent', ['relationship decay alerts', 'overdue task warnings', 'outcome follow-ups', 'attention drift detection', '→ NOTIFICATION event'], AMBER, 8)

# Recommendations engine
box(ax, 0.80, 0.695, 0.17, 0.055, 'Recommendations', ['pattern detection → suggest:', '• repeated topics → agent', '• fading contacts → cron', '• matching behavior → skill', 'one-click accept → auto-create'], ORANGE, 8)

# ═══════════════════════════════════════════════════════════════
# L3: Cognition (the brain)
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.67, 'L3 COGN', PRIMARY, 8)

# Decision Agent (largest, center)
box(ax, 0.12, 0.57, 0.24, 0.09, 'Decision Agent', [
    '1. Intent classify (local, no LLM)',
    '2. Cache check (LRU 50, 5min TTL)',
    '3. Skill match (60% keyword → fast path)',
    '4. 5-stage pipeline:',
    '   constraints → options → twin align → risk → select',
    '5. Cognitive failure detect (8 modes)',
    '6. Trajectory confidence verify',
    '7. Swarm escalation if low confidence',
], PRIMARY, 10)

# Twin Agent
box(ax, 0.38, 0.57, 0.18, 0.09, 'Twin Agent', [
    'learns from 4 sources:',
    '• edit diffs → contraindications',
    '• exec results → quality patterns',
    '• accept/reject → preferences',
    '• weekly drift detection',
    '',
    'creates constraint nodes in graph',
], PURPLE, 8)

# Evolution Engine
box(ax, 0.58, 0.57, 0.18, 0.09, 'Evolution Engine', [
    'auto-tunes 5 dimensions:',
    '• decision_style (cautious↔aggressive)',
    '• plan_complexity (simple↔detailed)',
    '• communication_tone (direct↔analytical)',
    '• domain_weights {work:0.5...}',
    '• time_preference {peak:10am}',
    'daily 4am · prompt adaptation injection',
], ROSE, 8)

# Skills Engine
box(ax, 0.78, 0.57, 0.18, 0.09, 'Skills Engine', [
    '5 templates + auto-crystallize:',
    '• 3+ confirms → new skill',
    '• match → skip LLM pipeline',
    '• edit → evolve template',
    '• reject 3x → retire (conf<0.3)',
    '• Dream creates from exec logs',
    'source: behavior/dream/template',
], TEAL, 8)

# Smaller agents
box(ax, 0.12, 0.50, 0.12, 0.055, 'Extractor', ['message → graph nodes', 'NLP extraction', 'quality filter:', '"skip tools/apps/infra"'], GREEN, 7)
box(ax, 0.26, 0.50, 0.12, 0.055, 'Self-Portrait', ['5 layers (pure math):', '1. Life Balance (entropy)', '2. Say vs Do', '3. Identity Tensions', '4. Relationship Depth', '5. Time Audit'], ROSE, 7)
box(ax, 0.40, 0.50, 0.12, 0.055, 'Cognitive Swarm', ['3-role debate:', 'Advocate → Critic → Judge', 'not merge — ruling', 'activates on low conf'], ORANGE, 7)
box(ax, 0.54, 0.50, 0.12, 0.055, 'Observation Agent', ['graph changes →', 'episodic memory', 'cascade unlocks', 'XP on task complete'], BLUE, 7)
box(ax, 0.68, 0.50, 0.12, 0.055, 'GEPA Optimizer', ['exec trace analysis:', '• redundant calls', '• excessive tokens', '• failed retries', 'auto-apply route_overrides'], RED, 7)
box(ax, 0.82, 0.50, 0.14, 0.055, 'Sparse Analysis', ['5 micro-analysts:', 'Identity · Behavior', 'Priority · BlindSpot · Risk', 'for < 5 nodes + < 5 mems', 'always produces output'], PURPLE, 7)

# Custom Agents area
ax.add_patch(FancyBboxPatch((0.12, 0.44), 0.84, 0.045, boxstyle="round,pad=0.008",
             facecolor=CYAN+'08', edgecolor=CYAN+'44', linewidth=1.0, linestyle='--'))
ax.text(0.54, 0.478, 'USER CUSTOM AGENTS (persona overlays on Decision Agent · N agents · independent memory · Twin feedback)',
        ha='center', fontsize=6.5, fontweight='bold', color=CYAN, family='monospace')

templates = ['Competitor Analyst', 'Email Drafter', 'Code Reviewer', 'Meeting Prep', 'Weekly Strategist', 'Your Custom...']
for i, t in enumerate(templates):
    x = 0.15 + i * 0.135
    ax.text(x, 0.455, f'🤖 {t}', fontsize=5, color=CYAN, family='monospace')

# ═══════════════════════════════════════════════════════════════
# L2: Memory
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.415, 'L2 MEM', PURPLE, 8)

box(ax, 0.12, 0.375, 0.22, 0.055, 'Memory Retrieval', [
    '3 layers: working (7d) · episodic (30d) · semantic (∞)',
    'scoring: confidence × recency × keyword_match',
    'FTS5 full-text search · hybrid ranking',
    'conversation flush · periodic nudge',
], PURPLE, 8)

box(ax, 0.36, 0.375, 0.22, 0.055, 'Dream Engine (3am)', [
    '6 operations:',
    '1. prune stale · 2. merge contradictions (LLM)',
    '3. promote episodic→semantic · 4. time normalize',
    '5. create skills from exec logs · 6. capacity enforce (200 max)',
    '+ expire temporal edges (valid_to < now)',
], ROSE, 8)

box(ax, 0.60, 0.375, 0.17, 0.055, 'Memory Classes', [
    'working: temp context, 7-day TTL',
    'episodic: specific events, promotable',
    'semantic: stable facts, permanent',
    'dream: consolidation artifacts',
], PURPLE, 7)

# ═══════════════════════════════════════════════════════════════
# L1: Human Graph
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.35, 'L1 GRAPH', CYAN, 8)

box(ax, 0.12, 0.30, 0.22, 0.06, 'Graph Nodes', [
    '21 types: person · goal · project · risk · value · constraint',
    'decision · event · skill · behavioral_pattern · opportunity...',
    '5 domains: work · relationships · finance · health · growth',
    'statuses: active · in-progress · done · blocked · decaying...',
], CYAN, 8)

box(ax, 0.36, 0.30, 0.15, 0.06, 'Graph Edges', [
    '10 types: depends-on · influences',
    'relates-to · blocks · enables...',
    'weight: 0.0-1.0',
    'temporal: valid_from / valid_to',
    'auto-expire in Dream Engine',
], CYAN, 7)

box(ax, 0.53, 0.30, 0.15, 0.06, 'Math Models', [
    'PageRank: node importance',
    'Shannon Entropy: focus score',
    'Exponential Decay: relationship health',
    'Bayesian Update: confidence',
    '5min cache · version-keyed',
], CYAN, 7)

box(ax, 0.70, 0.30, 0.15, 0.06, 'Serializer', [
    'graph → LLM prompt text',
    'PageRank-weighted ordering',
    'edge context injection',
    'state + constitution + adaptations',
], CYAN, 7)

# ═══════════════════════════════════════════════════════════════
# L8: Infrastructure
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.275, 'L8 INFRA', BLUE, 8)

box(ax, 0.12, 0.215, 0.18, 0.065, 'Cortex LLM', [
    'text() · textStream() · textWithTools()',
    'vision() · embed()',
    'task → capability → tier routing',
    'fallback chain (try next provider)',
    'providers: Anthropic · OpenAI · Google',
    'telemetry: tokens · latency · cost',
], BLUE, 8)

box(ax, 0.32, 0.215, 0.13, 0.065, 'SQLite', [
    'anchor.db · WAL mode',
    '32 tables · 21 indexes',
    'FTS5 on memories',
    'daily backup (2:55am)',
    '7-day retention',
], BLUE, 7)

box(ax, 0.47, 0.215, 0.18, 0.065, 'Local Integrations', [
    'browser-history.ts: Chrome/Safari/Arc SQLite',
    'contacts.ts: AppleScript → Contacts.app',
    'calendar.ts: AppleScript → Calendar.app',
    'activity-monitor.ts: app + title + URL (5min)',
    'people-extractor.ts: LinkedIn/Twitter/email',
    'deep-scan.ts: apps · projects · tech stack',
], BLUE, 7)

box(ax, 0.67, 0.215, 0.13, 0.065, 'MCP Server', [
    'outbound: expose tools',
    'to Cursor/Claude Desktop',
    'inbound: connect external',
    'MCP servers → import tools',
    'mcp_servers table',
], BLUE, 7)

box(ax, 0.82, 0.215, 0.14, 0.065, 'Hand (macOS)', [
    'AppleScript tools:',
    'Mail.app → send email',
    'Calendar → create event',
    'Reminders → create reminder',
    'Playwright (optional):',
    '5 browser automation tools',
], BLUE, 7)

# ═══════════════════════════════════════════════════════════════
# FRONTEND
# ═══════════════════════════════════════════════════════════════
label_box(ax, 0.01, 0.19, 'CLIENT', PINK, 8)

box(ax, 0.12, 0.145, 0.13, 0.055, 'Dashboard', [
    'priority · state · tension',
    'suggestions (1-click accept)',
    'fading relationships',
    'twin model · evolution dims',
    'human graph · self-portrait',
], PINK, 7)

box(ax, 0.27, 0.145, 0.10, 0.055, 'Advisor', [
    'personal (SSE stream)',
    'general mode',
    'plan editor',
    'confirm/reject',
    'voice input',
], PINK, 7)

box(ax, 0.39, 0.145, 0.10, 0.055, 'Node Detail', [
    'meta + health',
    'mini graph SVG',
    'tasks · connections',
    'ask anchor',
    'agent tools (modal)',
], PINK, 7)

box(ax, 0.51, 0.145, 0.10, 0.055, 'Settings', [
    'profile · models',
    'custom agents CRUD',
    'crons · skill templates',
    'privacy · notifications',
    'integrations · API keys',
], PINK, 7)

box(ax, 0.63, 0.145, 0.10, 0.055, 'Admin', [
    'cortex (model mgmt)',
    'costs · performance',
    'LLM call logs',
    'system health',
    'graph viz · memory',
], PINK, 7)

box(ax, 0.75, 0.145, 0.10, 0.055, 'Other Pages', [
    'Onboarding (7 steps)',
    'Memory (3 layers)',
    'Workspace (Kanban)',
    'Twin Agent (XP/quests)',
    'Cmd+K palette',
], PINK, 7)

# State management
box(ax, 0.87, 0.145, 0.10, 0.055, 'State', [
    'Zustand store',
    'SWR cache:',
    'graph (5min)',
    'decision (5min)',
    'digest (2min)',
    'WebSocket auto-reconnect',
], PINK, 7)

# ═══════════════════════════════════════════════════════════════
# CONNECTION ARROWS (key data flows)
# ═══════════════════════════════════════════════════════════════

# L7 → L6
arr(ax, 0.50, 0.87, 0.50, 0.865, BLUE, 0.8)
# L6 → L5
arr(ax, 0.30, 0.825, 0.30, 0.81, RED, 0.8)
# L5 → L4
arr(ax, 0.40, 0.765, 0.40, 0.75, GREEN, 0.8)
# L4 → L3
arr(ax, 0.30, 0.695, 0.24, 0.66, AMBER, 0.8)

# Decision → Twin (priors)
biarr(ax, 0.36, 0.61, 0.38, 0.61, PURPLE, 0.8)
# Decision → Evolution (adaptations)
darr(ax, 0.36, 0.59, 0.58, 0.63, ROSE, 0.6)
# Decision → Skills (match)
darr(ax, 0.36, 0.58, 0.78, 0.62, TEAL, 0.6)

# L3 → L2
arr(ax, 0.24, 0.50, 0.24, 0.43, PRIMARY, 0.8)
# L2 → L1
arr(ax, 0.24, 0.375, 0.24, 0.36, PURPLE, 0.8)
# L1 → L8
arr(ax, 0.24, 0.30, 0.24, 0.28, CYAN, 0.8)

# Events flow
arr(ax, 0.46, 0.72, 0.64, 0.75, AMBER, 0.6)  # cron → proactive
arr(ax, 0.78, 0.72, 0.82, 0.72, AMBER, 0.6)   # proactive → recommendations

# Custom agents → Decision
darr(ax, 0.54, 0.44, 0.24, 0.57, CYAN, 0.6)

# Client → L7
arr(ax, 0.50, 0.20, 0.50, 0.87, PINK, 0.4)

# ═══════════════════════════════════════════════════════════════
# BOTTOM: Learning Loop Summary
# ═══════════════════════════════════════════════════════════════

ax.add_patch(FancyBboxPatch((0.05, 0.02), 0.90, 0.10, boxstyle="round,pad=0.012",
             facecolor='#ffffff05', edgecolor=AMBER+'66', linewidth=1.2))

ax.text(0.50, 0.115, 'SELF-IMPROVING LEARNING LOOP — Every interaction teaches the system', ha='center',
        fontsize=10, fontweight='bold', color=AMBER, family='monospace')

loop_steps = [
    ('User sends\nmessage', CYAN, 0.10),
    ('Decision Agent\n5-stage pipeline', PRIMARY, 0.22),
    ('Returns plan\nwith editable steps', GREEN, 0.34),
    ('User confirms\n/edits/rejects', CYAN, 0.46),
    ('Twin learns\nbehavior pattern', PURPLE, 0.58),
    ('Evolution tunes\n5 dimensions', ROSE, 0.70),
    ('Next response\nautomatically better', GREEN, 0.82),
]

for label, color, x in loop_steps:
    ax.text(x, 0.075, label, ha='center', va='center', fontsize=6, color=color, family='monospace', fontweight='bold')

for i in range(len(loop_steps)-1):
    x1 = loop_steps[i][2] + 0.05
    x2 = loop_steps[i+1][2] - 0.05
    arr(ax, x1, 0.075, x2, 0.075, MUTED, 0.8)

# Circular arrow back
ax.annotate('', xy=(0.10, 0.055), xytext=(0.82, 0.055),
            arrowprops=dict(arrowstyle='->', color=AMBER, lw=1.0,
                           connectionstyle='arc3,rad=-0.15'))
ax.text(0.46, 0.035, 'repeat — system gets smarter each cycle', ha='center',
        fontsize=6, color=AMBER, family='monospace', style='italic')


# ═══════════════════════════════════════════════════════════════
# STATS SIDEBAR
# ═══════════════════════════════════════════════════════════════

stats_x = 0.87
stats = [
    ('SERVER', '78 files · 14K lines', BLUE),
    ('CLIENT', '86 files · 6K lines', PINK),
    ('TABLES', '32 + FTS5', CYAN),
    ('INDEXES', '21', CYAN),
    ('AGENTS', '11 system + N custom', PRIMARY),
    ('TOOLS', '10 built-in + 5 browser', GREEN),
    ('CRON JOBS', '13 scheduled', AMBER),
    ('CHANNELS', '5 (web·ws·tg·imsg·mcp)', CYAN),
    ('SKILLS', '5 templates + auto', TEAL),
    ('EVENTS', '7 bus event types', AMBER),
    ('MATH', '4 models (PR·Ent·Dec·Bay)', CYAN),
    ('TRUST', '4 levels (L0→L3)', RED),
]

for i, (label, value, color) in enumerate(stats):
    y = 0.94 - i * 0.018
    # Skip if overlaps with boxes
    if y < 0.87 and y > 0.30:
        continue

ax.text(0.97, 0.30, '─── STATS ───', ha='center', fontsize=6, color=MUTED, family='monospace')
for i, (label, value, color) in enumerate(stats):
    y = 0.285 - i * 0.014
    ax.text(0.92, y, label, fontsize=5, color=color, family='monospace', fontweight='bold')
    ax.text(0.97, y, value, fontsize=4.5, color=DIM, family='monospace', ha='right')


fig.savefig('/Users/guanjieqiao/anchor-ui/docs/arch-final.png', dpi=200,
           bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig)
print("Generated: docs/arch-final.png")
