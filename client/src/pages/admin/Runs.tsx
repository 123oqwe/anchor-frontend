/**
 * Admin — Recent Agent Runs list (OPT-4)
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2, Clock, DollarSign, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";

export default function Runs() {
  const [, navigate] = useLocation();
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRecentRuns(50).then(setRuns).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Agent Runs</h1>
        <p className="text-xs text-muted-foreground mt-1">Recent traces across all agents with run_id instrumentation</p>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5 text-[10px] text-muted-foreground uppercase tracking-wider">
              <th className="text-left p-3">Agent</th>
              <th className="text-left p-3">Started</th>
              <th className="text-right p-3">Duration</th>
              <th className="text-right p-3">Tools</th>
              <th className="text-right p-3">LLM</th>
              <th className="text-right p-3">Cost</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r: any) => {
              const duration = r.started_at && r.finished_at
                ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
                : 0;
              return (
                <tr key={r.run_id} onClick={() => navigate(`/admin/runs/${r.run_id}`)}
                    className="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer">
                  <td className="p-3 text-sm font-medium text-foreground">{r.agent_name ?? "—"}</td>
                  <td className="p-3 text-xs text-muted-foreground font-mono">
                    {r.started_at ? new Date(r.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td className="p-3 text-xs text-right font-mono text-muted-foreground">{duration}ms</td>
                  <td className="p-3 text-xs text-right font-mono">{r.tool_count}</td>
                  <td className="p-3 text-xs text-right font-mono">{r.llm_count}</td>
                  <td className="p-3 text-xs text-right font-mono text-emerald-400">${(r.cost ?? 0).toFixed(4)}</td>
                  <td className="p-3 text-right"><ChevronRight className="h-3 w-3 text-muted-foreground/30 ml-auto" /></td>
                </tr>
              );
            })}
            {runs.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-xs text-muted-foreground">No runs yet. Run a custom agent to see traces here.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
