/**
 * Admin — Mission Detail.
 *
 * Vertical timeline of agents participating in a mission (root → handoff/sub
 * children), each card showing LLM calls + latency + tool actions. Right side
 * shows the shared blackboard state.
 *
 * Not a full DAG renderer (didn't pull in reaflow / react-flow for this — the
 * linear timeline captures Anchor's handoff semantics well enough). Each child
 * card is indented per its parent to show depth.
 */
import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import {
  Share2, ArrowLeft, Loader2, Bot, ArrowDown, GitBranch,
  Database, Clock, Zap, ExternalLink,
} from "lucide-react";
import { api } from "@/lib/api";

const REFRESH_MS = 5000;

export default function MissionDetail() {
  const params = useParams() as { id: string };
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const d = await api.getMission(params.id);
      setData(d);
      setLoading(false);
    } catch {}
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [params.id]);

  if (loading || !data) return <div className="flex items-center justify-center h-64"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/missions">
            <button className="p-2 glass rounded-lg hover:bg-white/[0.03]"><ArrowLeft className="h-4 w-4 text-muted-foreground" /></button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Share2 className="h-5 w-5 text-cyan-400" />
              Mission
            </h1>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{data.missionId}</p>
          </div>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-5 gap-2">
        <Stat icon={<Bot className="h-3.5 w-3.5 text-cyan-400" />} value={data.stats.agentCount} label="agents" />
        <Stat icon={<GitBranch className="h-3.5 w-3.5 text-violet-400" />} value={data.stats.handoffCount} label="handoffs" />
        <Stat icon={<Bot className="h-3.5 w-3.5 text-amber-400" />} value={data.stats.subagentCount} label="subagents" />
        <Stat icon={<Zap className="h-3.5 w-3.5 text-emerald-400" />} value={data.stats.totalLlmCalls} label="LLM calls" />
        <Stat icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" />} value={`${data.stats.totalLatencyMs}ms`} label="total latency" />
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Timeline: participants */}
        <div className="col-span-8 space-y-0">
          <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Timeline</h2>
          {data.participants.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">No participants found for this mission.</p>
          ) : data.participants.map((p: any, i: number) => (
            <div key={p.runId} className="flex flex-col items-start">
              {i > 0 && (
                <div className={`flex items-center gap-1 text-muted-foreground/50 text-[10px] ml-2 my-1 ${p.kind === "handoff" ? "text-violet-400/60" : p.kind === "sub" ? "text-amber-400/60" : ""}`}>
                  <ArrowDown className="h-3 w-3" />
                  {p.kind === "handoff" && "handoff"}
                  {p.kind === "sub" && "delegated subagent"}
                  {p.kind === "root" && "root"}
                </div>
              )}
              <div
                className="glass rounded-xl p-3 w-full"
                style={{ marginLeft: depthOf(p) * 16 }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center ${
                      p.kind === "root" ? "bg-cyan-500/10 text-cyan-400" :
                      p.kind === "handoff" ? "bg-violet-500/10 text-violet-400" :
                      "bg-amber-500/10 text-amber-400"
                    }`}>
                      <Bot className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-foreground">{p.agent ?? "unknown"}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">{p.runId.slice(-12)}</div>
                    </div>
                  </div>
                  <Link href={`/admin/runs/${p.runId}`}>
                    <button className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                      trace <ExternalLink className="h-2.5 w-2.5" />
                    </button>
                  </Link>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground/80">
                  <span>{p.llmCalls ?? 0} LLM</span>
                  <span>{p.totalLatencyMs ?? 0}ms</span>
                  <span>{(p.inTok ?? 0) + (p.outTok ?? 0)} tokens</span>
                  <span>{p.execs.length} events</span>
                </div>
                {p.execs.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-white/5 space-y-0.5">
                    {p.execs.slice(0, 4).map((e: any, j: number) => (
                      <div key={j} className="text-[10px] text-muted-foreground/70 truncate">
                        <span className={e.status === "failed" ? "text-red-400/70" : "text-foreground/60"}>
                          {e.status === "failed" ? "✗" : "✓"}
                        </span>{" "}
                        {e.action?.slice(0, 150)}
                      </div>
                    ))}
                    {p.execs.length > 4 && <div className="text-[10px] text-muted-foreground/40">+{p.execs.length - 4} more</div>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Blackboard */}
        <div className="col-span-4 space-y-2">
          <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Database className="h-3 w-3" /> Blackboard
          </h2>
          {data.blackboard.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">Empty — no agent wrote to anchor.blackboard.*</p>
          ) : (
            <div className="glass rounded-xl p-3 space-y-2">
              {data.blackboard.map((b: any) => (
                <div key={b.key} className="border-b border-white/5 pb-2 last:border-b-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-cyan-400">{b.key}</span>
                    <span className="text-[9px] text-muted-foreground/60">{fmtTime(b.updated_at)}</span>
                  </div>
                  <div className="text-[11px] text-foreground/80 font-mono mt-0.5 break-all line-clamp-3">
                    {b.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, value, label }: { icon: any; value: number | string; label: string }) {
  return (
    <div className="glass rounded-lg p-2 text-center">
      <div className="flex items-center justify-center gap-1">{icon}<span className="text-lg font-semibold">{value}</span></div>
      <div className="text-[9px] text-muted-foreground/60 uppercase">{label}</div>
    </div>
  );
}

/** Guess indent depth — 0 for root, 1 for first-level, 2+ per handoff/sub suffix. */
function depthOf(p: any): number {
  if (p.kind === "root") return 0;
  return (p.runId.match(/-(handoff|sub)-/g) || []).length;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  } catch { return iso; }
}
