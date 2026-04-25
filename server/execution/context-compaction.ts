/**
 * L5 Execution — Context compaction for long-horizon ReAct loops.
 *
 * Anthropic's 200K context window gets exhausted quickly when tools return
 * bulk data (git log dumps, web_search results, file contents). After ~8-10
 * turns an agent hits the wall and either errors or degrades.
 *
 * Strategy: "elide old tool bodies, keep reasoning chain."
 *   - Walk the messages array
 *   - Keep the last K tool_result blocks untouched (recent context the agent
 *     is actively reasoning about)
 *   - For all OLDER tool_result blocks, replace `content` with a short
 *     marker that preserves length metadata but drops the bulk
 *   - All assistant TEXT blocks are preserved — these hold the agent's
 *     reasoning trail, which is what carries continuity across turns
 *   - tool_use_id stays valid → API shape unchanged → no SDK errors
 *
 * Why not server-side (Anthropic context_management)?
 *   Anthropic's managed feature is promising (39% perf lift, 84% token
 *   reduction per their benchmarks) but the SDK surface is still moving.
 *   This client-side impl is semantically equivalent, ships today, and can
 *   be swapped out for the managed version when stable. Meanwhile we get
 *   our own compaction stats for observability.
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface CompactionStats {
  beforeChars: number;
  afterChars: number;
  blocksCompacted: number;
  recentPairsKept: number;
  triggered: boolean;
}

const DEFAULT_MAX_CHARS = 150_000;        // ~37.5K tokens — well under 200K window
const DEFAULT_KEEP_RECENT_PAIRS = 3;      // last 3 tool_result blocks always kept whole
const COMPACTION_MARKER = "[compacted]";
const PREVIEW_CHARS = 160;                // first N chars of each elided tool_result

/**
 * Compact a messages array so the total character footprint stays under
 * `maxChars`. Safe to call every turn — no-op when under budget.
 */
export function compactMessages(
  messages: Anthropic.Messages.MessageParam[],
  opts: { maxChars?: number; keepRecentToolPairs?: number } = {},
): { messages: Anthropic.Messages.MessageParam[]; stats: CompactionStats } {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const keepRecent = opts.keepRecentToolPairs ?? DEFAULT_KEEP_RECENT_PAIRS;

  const beforeChars = measureChars(messages);
  const stats: CompactionStats = {
    beforeChars,
    afterChars: beforeChars,
    blocksCompacted: 0,
    recentPairsKept: 0,
    triggered: false,
  };

  if (beforeChars <= maxChars) return { messages, stats };
  stats.triggered = true;

  // Locate every tool_result block with its (messageIndex, blockIndex) address
  const toolResultAddrs: Array<{ mi: number; bi: number }> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (let bi = 0; bi < m.content.length; bi++) {
      const block = m.content[bi] as any;
      if (block?.type === "tool_result") toolResultAddrs.push({ mi, bi });
    }
  }

  // Keep the last K intact; elide the rest (oldest first)
  const keepSet = new Set(
    toolResultAddrs
      .slice(-keepRecent)
      .map(a => `${a.mi}:${a.bi}`),
  );
  stats.recentPairsKept = keepSet.size;

  // Deep-clone only the blocks we mutate — preserve original messages[]
  const compacted = messages.map((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    let touched = false;
    const newContent = m.content.map((block: any, bi) => {
      if (block?.type !== "tool_result") return block;
      if (keepSet.has(`${mi}:${bi}`)) return block;
      if (typeof block.content === "string" && block.content.startsWith(COMPACTION_MARKER)) return block;
      touched = true;
      stats.blocksCompacted++;
      const original = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
      const preview = original.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ");
      return {
        ...block,
        content: `${COMPACTION_MARKER} tool returned ${original.length} chars. preview: ${preview}${original.length > PREVIEW_CHARS ? "…" : ""}`,
      };
    });
    return touched ? { ...m, content: newContent } : m;
  });

  stats.afterChars = measureChars(compacted);
  return { messages: compacted, stats };
}

function measureChars(messages: Anthropic.Messages.MessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    n += typeof m.content === "string"
      ? m.content.length
      : JSON.stringify(m.content).length;
  }
  return n;
}
