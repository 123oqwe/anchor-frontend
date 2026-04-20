/**
 * Admin — Agent Run Trace (OPT-4 observability)
 * Shows full timeline of tools + LLM calls for a single agent run.
 */
import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { Loader2, ArrowLeft, Bot, DollarSign, Clock, Terminal, Zap as ZapIcon } from "lucide-react";
import { api } from "@/lib/api";

export default function RunTrace() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/runs/:runId");
  const [trace, setTrace] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.runId) return;
    api.getRunTrace(params.runId)
      .then(setTrace)
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params?.runId]);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;
  if (error || !trace) return <div className="p-8 text-center text-muted-foreground">{error ?? "Run not found"}</div>;

  return (
    <div className="space-y-6 p-6">
      <button onClick={() => navigate("/admin/runs")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to runs
      </button>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Bot className="h-4 w-4 text-primary" />
          <h1 className="text-2xl font-bold">{trace.agentName ?? "Run"}</h1>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground font-mono">
          <span>Run: {trace.runId.slice(0, 8)}</span>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{trace.durationMs}ms</span>
          <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />{(trace.totalCost ?? 0).toFixed(4)}</span>
          <span>{trace.totalTokens} tokens</span>
          <span>{trace.llmCount} LLM calls</span>
          <span>{trace.toolCount} tool calls</span>
          {typeof trace.providerCount === "number" && (
            <span>{trace.providerCount} bridge attempts</span>
          )}
        </div>
      </div>

      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-4">Timeline</h2>
        <div className="space-y-2">
          {trace.timeline?.map((event: any, i: number) => (
            <div key={event.id ?? i} className="flex gap-3 text-xs">
              <span className="text-muted-foreground/50 font-mono w-20 shrink-0">
                {event.ts?.slice(11, 19)}
              </span>
              <span className={`w-16 shrink-0 flex items-center gap-1 ${
                event.type === "llm" ? "text-purple-400"
                  : event.type === "provider" ? "text-cyan-400"
                  : "text-emerald-400"
              }`}>
                {event.type === "provider" && (event.provider_id?.includes("mcp") ? <ZapIcon className="h-3 w-3" /> : <Terminal className="h-3 w-3" />)}
                {event.type === "llm" ? "LLM" : event.type === "provider" ? "BRIDGE" : "TOOL"}
              </span>
              {event.type === "llm" ? (
                <div className="flex-1 min-w-0">
                  <div className="flex gap-2 items-center">
                    <span className="text-foreground font-medium">{event.task}</span>
                    <span className="text-muted-foreground">{event.model_id}</span>
                    <span className="text-muted-foreground">{event.latency_ms}ms</span>
                    <span className="text-muted-foreground">${(event.cost_usd ?? 0).toFixed(4)}</span>
                  </div>
                  {event.response_preview && (
                    <p className="text-muted-foreground mt-1 line-clamp-2">{event.response_preview}</p>
                  )}
                </div>
              ) : event.type === "provider" ? (
                <div className="flex-1 min-w-0">
                  <div className="flex gap-2 items-center">
                    <span className="text-foreground font-mono text-[11px]">{event.capability}</span>
                    <span className="text-cyan-400 font-mono text-[11px]">→ {event.provider_id}</span>
                    <span className={event.status === "success" ? "text-emerald-400" : event.status === "skipped" ? "text-muted-foreground" : "text-red-400"}>
                      {event.status}
                    </span>
                    <span className="text-muted-foreground">{event.latency_ms}ms</span>
                    {event.error_kind && <span className="text-[10px] px-1 rounded bg-red-500/10 text-red-400 font-mono">{event.error_kind}</span>}
                  </div>
                  {event.reason && <p className="text-muted-foreground mt-0.5 line-clamp-1 text-[11px]">{event.reason}</p>}
                </div>
              ) : (
                <div className="flex-1 min-w-0">
                  <div className="flex gap-2">
                    <span className="text-foreground font-medium">{event.agent}</span>
                    <span className={event.status === "success" ? "text-emerald-400" : "text-red-400"}>{event.status}</span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 truncate">{event.action}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
