"""
Anchor OS — Detailed System Flow Diagrams
4 diagrams showing exactly how everything connects:
  1. User Request Flow (what happens when you type a message)
  2. Background Learning Loop (overnight engines)
  3. Self-Diagnostic Flow (how the meta-agent works)
  4. Data Flow Map (what reads/writes what)
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
                       facecolor=color+'15', edgecolor=color, linewidth=1.5)
    ax.add_patch(b)
    ax.text(x+w/2, y+h-0.012, title, ha='center', va='top',
            fontsize=fs, fontweight='bold', color=WHITE, family='monospace')
    for i, item in enumerate(items):
        ax.text(x+w/2, y+h-0.028-(i+1)*0.014, item, ha='center', va='top',
                fontsize=5.5, color=DIM, family='monospace')

def arr(ax, x1, y1, x2, y2, color=MUTED, lw=1.0, label=''):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, connectionstyle='arc3,rad=0.05'))
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx, my+0.01, label, ha='center', va='bottom',
                fontsize=5, color=color, family='monospace', style='italic')

def darr(ax, x1, y1, x2, y2, color=MUTED, lw=0.7, label=''):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw, linestyle='dashed',
                               connectionstyle='arc3,rad=0.05'))
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx, my+0.01, label, ha='center', va='bottom',
                fontsize=5, color=color, family='monospace', style='italic')

def numcircle(ax, x, y, num, color):
    circle = plt.Circle((x, y), 0.012, facecolor=color+'33', edgecolor=color, linewidth=1.2)
    ax.add_patch(circle)
    ax.text(x, y, str(num), ha='center', va='center', fontsize=7, fontweight='bold',
            color=color, family='monospace')


# ════════════════════════════════════════════════════════════════════════════
# DIAGRAM 1: User Request Flow
# ════════════════════════════════════════════════════════════════════════════

fig1, ax1 = plt.subplots(1, 1, figsize=(22, 16))
fig1.patch.set_facecolor(BG); ax1.set_facecolor(BG)
ax1.set_xlim(0, 1); ax1.set_ylim(0, 1); ax1.axis('off')

ax1.text(0.5, 0.98, 'DIAGRAM 1: What Happens When You Send A Message', ha='center',
         fontsize=18, fontweight='bold', color=WHITE, family='monospace')
ax1.text(0.5, 0.96, 'Every step numbered. Every data flow labeled. Every decision point explained.',
         ha='center', fontsize=8, color=DIM, family='monospace')

# Step 1: User input
numcircle(ax1, 0.08, 0.92, 1, CYAN)
box(ax1, 0.10, 0.90, 0.18, 0.04, 'User sends message', ['"Should I pitch investors Tuesday?"', 'via: Web / Telegram / iMessage / Voice'], CYAN)

# Step 2: Route to advisor
numcircle(ax1, 0.34, 0.92, 2, BLUE)
box(ax1, 0.36, 0.90, 0.18, 0.04, 'POST /api/advisor/personal', ['Express route → advisor.ts', 'Zod validates message body'], BLUE)

arr(ax1, 0.28, 0.92, 0.36, 0.92, CYAN, 1.2)

# Step 3: Load context
numcircle(ax1, 0.08, 0.84, 3, PURPLE)
box(ax1, 0.03, 0.76, 0.30, 0.07, 'Load Context (4 sources in parallel)', [
    'A. messages table → last 10 conversation turns',
    'B. memories table → top 12 scored by confidence x recency x keyword',
    'C. graph_nodes + graph_edges → full graph serialized for LLM',
    'D. twin_insights → behavioral priors sorted by confidence',
    'E. evolution_state → prompt adaptations (tone, complexity, style)',
], PURPLE, 8)

arr(ax1, 0.45, 0.90, 0.20, 0.83, PURPLE, 1.0, 'load history + context')

# Step 4: Intent classification
numcircle(ax1, 0.40, 0.84, 4, AMBER)
box(ax1, 0.35, 0.76, 0.25, 0.07, 'Intent Classification (LOCAL, 0 LLM)', [
    'regex rules, no API call:',
    '  "hi/hello/thanks" → GREETING (instant reply, 0 cost)',
    '  "send/email/create" → EXECUTION (skip analysis)',
    '  "should I/decide/recommend" → DECISION (full pipeline)',
    '  "what is/show me/explain" → INFO (light pipeline)',
    '  anything else → CONVERSATION',
], AMBER, 8)

# Step 5: Cache check
numcircle(ax1, 0.68, 0.84, 5, GREEN)
box(ax1, 0.63, 0.76, 0.20, 0.07, 'Cache Check', [
    'LRU cache: 50 entries, 5min TTL',
    'key = MD5(message + graph_version',
    '  + memory_version + history_hash)',
    '',
    'HIT → return cached result (0 LLM)',
    'MISS → continue to pipeline',
], GREEN, 7)

arr(ax1, 0.60, 0.79, 0.63, 0.79, AMBER, 1.0, 'if decision')

# Step 6: Skill match
numcircle(ax1, 0.88, 0.84, 6, TEAL)
box(ax1, 0.84, 0.76, 0.14, 0.07, 'Skill Match?', [
    'scan skills table',
    'keyword match 60%+',
    '(reads system_config',
    ' for threshold)',
    '',
    'MATCH → cheap model',
    'adapts template steps',
], TEAL, 7)

arr(ax1, 0.83, 0.79, 0.84, 0.79, GREEN, 1.0, 'if miss')

# Step 7: 5-stage pipeline
numcircle(ax1, 0.08, 0.69, 7, PRIMARY)
box(ax1, 0.03, 0.55, 0.94, 0.12, '5-STAGE LLM PIPELINE (1 LLM call, ~2500 tokens output)', [
    '',
], PRIMARY, 12)

stages = [
    (0.05, 0.58, 'Stage 1', 'CONSTRAINT\nEXTRACTION', 'graph → blockers\ndeadlines\nconflicts', RED),
    (0.22, 0.58, 'Stage 2', 'OPTION\nGENERATION', '2-3 candidates\nconsidering\nconstraints', BLUE),
    (0.39, 0.58, 'Stage 3', 'TWIN\nALIGNMENT', 'check vs priors\nuser > twin rule\nflag conflicts', PURPLE),
    (0.56, 0.58, 'Stage 4', 'BOUNDARY\nCLASSIFY', 'risk: low|high\napproval needed?\nmoney/external?', AMBER),
    (0.73, 0.58, 'Stage 5', 'DELTA\nSELECTION', 'best option\nwhy NOW\nnot tomorrow', GREEN),
]

for x, y, label, title, desc, color in stages:
    box(ax1, x, y, 0.15, 0.07, title, desc.split('\n'), color, 7)
    ax1.text(x+0.005, y+0.065, label, fontsize=5, color=color, fontweight='bold', family='monospace')

for i in range(4):
    arr(ax1, stages[i][0]+0.15, stages[i][1]+0.035, stages[i+1][0], stages[i+1][1]+0.035, PRIMARY, 0.8)

arr(ax1, 0.50, 0.76, 0.50, 0.67, PRIMARY, 1.0, 'no skill match → full pipeline')

# Step 8: Post-processing
numcircle(ax1, 0.08, 0.52, 8, RED)
box(ax1, 0.03, 0.43, 0.22, 0.08, 'Post-Processing', [
    'A. JSON parse + auto-repair truncated',
    'B. Cognitive failure detect (8 modes):',
    '   context starvation, over-planning,',
    '   conflict suppression, missing timing...',
    'C. Confidence verify (independent LLM)',
    'D. Swarm escalation if conf < 0.7',
], RED, 7)

# Step 9: Response
numcircle(ax1, 0.30, 0.52, 9, GREEN)
box(ax1, 0.27, 0.43, 0.20, 0.08, 'Return to User', [
    'structured JSON:',
    '  suggestion_summary',
    '  editable_steps[]',
    '  why_this_now',
    '  confidence: 0.82',
    '  stages_trace[]',
], GREEN, 7)

arr(ax1, 0.25, 0.47, 0.27, 0.47, RED, 1.0)

# Step 10: Side effects (non-blocking)
numcircle(ax1, 0.53, 0.52, 10, BLUE)
box(ax1, 0.49, 0.43, 0.24, 0.08, 'Side Effects (async, non-blocking)', [
    'A. writeMemory() → episodic: "User asked about X"',
    'B. extractFromMessage() → new graph nodes',
    'C. flushConversationToMemory() if history long',
    'D. messages table → persist user msg + response',
    'E. logExecution() → agent_executions table',
], BLUE, 7)

darr(ax1, 0.47, 0.47, 0.49, 0.47, BLUE, 0.8, 'async')

# Step 11: User confirms
numcircle(ax1, 0.08, 0.37, 11, CYAN)
box(ax1, 0.03, 0.29, 0.20, 0.07, 'User Confirms Plan', [
    'can edit steps before confirming',
    'compute diff: what changed?',
    'satisfaction signal: confirmed/modified',
    'POST /api/advisor/confirm',
], CYAN, 7)

# Step 12: Bus event
numcircle(ax1, 0.28, 0.37, 12, AMBER)
box(ax1, 0.25, 0.29, 0.18, 0.07, 'bus.publish', [
    'type: USER_CONFIRMED',
    'payload: {',
    '  original_steps,',
    '  user_steps,',
    '  changes: [{modified,...}]',
    '}',
], AMBER, 7)

arr(ax1, 0.23, 0.33, 0.25, 0.33, CYAN, 1.0)

# Step 13: Twin learns
numcircle(ax1, 0.48, 0.37, 13, PURPLE)
box(ax1, 0.45, 0.29, 0.18, 0.07, 'Twin Learns (async)', [
    'twinLearnFromEdits(changes)',
    '→ extract behavioral insight',
    '→ create contraindication node',
    '→ dialectic tension if gap',
    '→ bus: TWIN_UPDATED',
], PURPLE, 7)

arr(ax1, 0.43, 0.33, 0.45, 0.33, AMBER, 1.0, 'sidecar')

# Step 14: Execution
numcircle(ax1, 0.68, 0.37, 14, GREEN)
box(ax1, 0.65, 0.29, 0.18, 0.07, 'Execution Agent', [
    'runExecutionReAct(user_steps)',
    'loop up to 12 turns:',
    '  LLM picks tool → L6 gate check',
    '  → execute → checkpoint → next',
    'bus: EXECUTION_DONE',
], GREEN, 7)

arr(ax1, 0.63, 0.33, 0.65, 0.33, AMBER, 1.0, 'main flow')

# Step 15: Skills check
numcircle(ax1, 0.88, 0.37, 15, TEAL)
box(ax1, 0.85, 0.29, 0.13, 0.07, 'Skill Check', [
    'tryCrystallizeSkill()',
    '3+ similar?',
    '→ new skill row',
    'evolveSkill() if',
    'from existing skill',
], TEAL, 7)

arr(ax1, 0.83, 0.33, 0.85, 0.33, AMBER, 1.0)

# Step 16: Twin learns from results
numcircle(ax1, 0.08, 0.23, 16, PURPLE)
box(ax1, 0.03, 0.15, 0.20, 0.07, 'Twin Learns Results', [
    'EXECUTION_DONE event',
    'twinLearnFromResults()',
    '→ success pattern insight',
    'evaluateDecisionOutcome()',
    '→ quality trending',
], PURPLE, 7)

# Step 17: Memory persist
numcircle(ax1, 0.28, 0.23, 17, PURPLE)
box(ax1, 0.25, 0.15, 0.18, 0.07, 'Memory Persist', [
    'TWIN_UPDATED event',
    'persistInsightAsSemanticMemory()',
    '→ twin insight → semantic layer',
    'permanent, high confidence',
], PURPLE, 7)

# Step 18: Graph update
numcircle(ax1, 0.48, 0.23, 18, CYAN)
box(ax1, 0.45, 0.15, 0.18, 0.07, 'Graph Update', [
    'GRAPH_UPDATED event',
    'recordGraphChange()',
    '→ episodic memory of change',
    'unlockBlockedNodes() cascade',
], CYAN, 7)

# Step 19: XP
numcircle(ax1, 0.68, 0.23, 19, GREEN)
box(ax1, 0.65, 0.15, 0.15, 0.07, 'Task → XP', [
    'TASK_COMPLETED event',
    'grantTaskCompletionXp()',
    '→ twin_evolution.xp++',
    'level up check',
], GREEN, 7)

# Loop back
ax1.annotate('', xy=(0.10, 0.91), xytext=(0.80, 0.15),
            arrowprops=dict(arrowstyle='->', color=AMBER+'88', lw=1.5,
                           connectionstyle='arc3,rad=0.3'))
ax1.text(0.93, 0.55, 'next message\nis informed by\neverything that\njust happened',
         ha='center', fontsize=6, color=AMBER, family='monospace',
         style='italic', rotation=-90)

# LEGEND
ax1.text(0.03, 0.10, 'LEGEND:', fontsize=7, fontweight='bold', color=WHITE, family='monospace')
ax1.text(0.03, 0.085, 'Solid arrow = synchronous flow  |  Dashed arrow = async/non-blocking  |  Numbers = execution order',
         fontsize=5, color=DIM, family='monospace')
ax1.text(0.03, 0.07, 'Steps 1-9: REQUEST (user → system → response)  |  Steps 11-15: CONFIRM (user approves → execute)  |  Steps 16-19: LEARN (system improves)',
         fontsize=5, color=DIM, family='monospace')
ax1.text(0.03, 0.055, 'Total LLM calls per message: 1 (pipeline) + 0-1 (confidence verify) + 0-3 (swarm if needed) = typically 1-2 calls',
         fontsize=5, color=DIM, family='monospace')

fig1.savefig('/Users/guanjieqiao/anchor-ui/docs/flow-1-request.png', dpi=200,
            bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig1)
print("1/2 Generated: flow-1-request.png")


# ════════════════════════════════════════════════════════════════════════════
# DIAGRAM 2: Background Learning Loop + Diagnostic
# ════════════════════════════════════════════════════════════════════════════

fig2, ax2 = plt.subplots(1, 1, figsize=(22, 14))
fig2.patch.set_facecolor(BG); ax2.set_facecolor(BG)
ax2.set_xlim(0, 1); ax2.set_ylim(0, 1); ax2.axis('off')

ax2.text(0.5, 0.98, 'DIAGRAM 2: Background Learning Loop (14 Cron Jobs + Diagnostic)', ha='center',
         fontsize=18, fontweight='bold', color=WHITE, family='monospace')
ax2.text(0.5, 0.96, 'What happens when you sleep. The system learns, cleans, optimizes, and monitors itself.',
         ha='center', fontsize=8, color=DIM, family='monospace')

# Timeline
ax2.plot([0.05, 0.95], [0.88, 0.88], color=MUTED, lw=1.5)

times = [
    (0.08, '2:55am', 'Backup', 'SQLite → anchor-YYYY-MM-DD.db\nkeep 7 days', BLUE),
    (0.16, '3:00am', 'Dream', 'prune stale memories\nmerge contradictions\npromote episodic→semantic\ncreate skills from logs\nexpire temporal edges\ncapacity enforce (200)', ROSE),
    (0.30, '4:00am', 'Evolution', 'capture 24h signals\ndeviation analysis\npattern detection\nupdate 5 dimensions\ngenerate prompt adaptations', ROSE),
    (0.44, 'Sun 5am', 'GEPA', 'analyze llm_calls traces\ndetect waste patterns\nauto route_overrides\nmodel downgrade', RED),
    (0.56, 'Sun 6am', 'Sys Evolution', 'model routing optimization\ntask→model performance\nrecommend changes', RED),
    (0.68, 'Sun 7am', 'Diagnostic', 'PURE SQL, 0 LLM\n9 health checks\nauto-fix thresholds\ntrend vs last week\nGEPA readiness score', RED),
    (0.82, '8:00am', 'Digest', 'LLM generates\n3-bullet briefing\noverdue + delayed items', AMBER),
]

for x, time, name, desc, color in times:
    ax2.plot([x, x], [0.87, 0.86], color=color, lw=1.5)
    ax2.text(x, 0.895, time, ha='center', fontsize=6, color=WHITE, family='monospace', fontweight='bold')
    box(ax2, x-0.06, 0.73, 0.12, 0.12, name, desc.split('\n'), color, 7)

# Continuous jobs
ax2.text(0.5, 0.70, 'CONTINUOUS (always running)', ha='center',
         fontsize=10, fontweight='bold', color=AMBER, family='monospace')

cont_jobs = [
    (0.05, 'Every 5min', 'Activity\nCapture', 'AppleScript:\napp + title + URL', BLUE),
    (0.20, 'Every 6h', 'Decay\nChecker', 'mark nodes\ndecaying if\n5+ days stale', AMBER),
    (0.35, 'Every 6h', 'Ingestion', 'Gmail + Calendar\nscan → nodes', BLUE),
    (0.50, 'Every 6h', 'Graph from\nActivity', 'update projects\nrelationship\nstrength', CYAN),
    (0.65, 'Every 12h', 'Proactive', 'decay alerts\noverdue tasks\noutcome follow\nattention drift', AMBER),
    (0.80, 'Daily 10pm', 'Stale Tasks', 'in-progress >7d\n→ blocked', AMBER),
]

for x, freq, name, desc, color in cont_jobs:
    ax2.text(x+0.06, 0.68, freq, ha='center', fontsize=5, color=color, family='monospace', fontweight='bold')
    box(ax2, x, 0.56, 0.12, 0.10, name, desc.split('\n'), color, 7)

# What each engine reads and writes
ax2.text(0.5, 0.52, 'DATA FLOW: What Each Engine Reads / Writes', ha='center',
         fontsize=10, fontweight='bold', color=PRIMARY, family='monospace')

# Dream
box(ax2, 0.02, 0.32, 0.22, 0.16, 'Dream Engine reads/writes', [
    'READS:',
    '  memories (all 3 layers)',
    '  agent_executions (for skill creation)',
    '  graph_edges (for temporal expiry)',
    '',
    'WRITES:',
    '  DELETE stale working/episodic memories',
    '  UPDATE memories (merge contradictions)',
    '  INSERT skills (from exec patterns)',
    '  DELETE graph_edges (expired temporal)',
    '  INSERT dream_log (stats)',
], ROSE, 7)

# Evolution
box(ax2, 0.26, 0.32, 0.22, 0.16, 'Evolution Engine reads/writes', [
    'READS:',
    '  satisfaction_signals (24h)',
    '  twin_insights (24h)',
    '  skills (last_used)',
    '  messages (user role, 24h)',
    '  system_config (min_signals threshold)',
    '',
    'WRITES:',
    '  evolution_state (5 dimensions)',
    '  agent_executions (log)',
], ROSE, 7)

# GEPA
box(ax2, 0.50, 0.32, 0.22, 0.16, 'GEPA Optimizer reads/writes', [
    'READS:',
    '  llm_calls (7 days)',
    '  agent_executions (7 days)',
    '',
    'WRITES:',
    '  route_overrides (model downgrade)',
    '  agent_executions (log)',
    '',
    'LOGIC:',
    '  redundant_calls > 3 → flag',
    '  avg_tokens > 3000 → flag',
    '  autoApplicable → setRouteOverride()',
], RED, 7)

# Diagnostic
box(ax2, 0.74, 0.32, 0.24, 0.16, 'Self-Diagnostic reads/writes', [
    'READS (9 checks, pure SQL):',
    '  satisfaction_signals → confirm rate',
    '  skills → crystallization count',
    '  evolution_state → dimensions updated',
    '  twin_insights → learning count',
    '  graph_nodes/edges → orphan ratio',
    '  memories → capacity check',
    '  llm_calls → cost per day',
    '  activity_captures → monitor health',
    '',
    'WRITES:',
    '  system_config (threshold fixes, 7d expiry)',
    '  diagnostic_reports (weekly snapshot)',
], RED, 7)

# Bottom: tables
ax2.text(0.5, 0.28, 'TABLES TOUCHED', ha='center',
         fontsize=8, fontweight='bold', color=CYAN, family='monospace')

tables = [
    'memories', 'skills', 'evolution_state', 'twin_insights', 'satisfaction_signals',
    'llm_calls', 'agent_executions', 'graph_nodes', 'graph_edges', 'dream_log',
    'route_overrides', 'system_config', 'diagnostic_reports', 'activity_captures',
]

for i, t in enumerate(tables):
    x = 0.05 + (i % 7) * 0.13
    y = 0.23 if i < 7 else 0.20
    ax2.text(x, y, t, fontsize=5.5, color=CYAN, family='monospace',
             bbox=dict(boxstyle='round,pad=0.2', facecolor=CYAN+'11', edgecolor=CYAN+'33', linewidth=0.5))

fig2.savefig('/Users/guanjieqiao/anchor-ui/docs/flow-2-background.png', dpi=200,
            bbox_inches='tight', facecolor=BG, edgecolor='none')
plt.close(fig2)
print("2/2 Generated: flow-2-background.png")
