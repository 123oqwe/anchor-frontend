/**
 * Admin — Task Brain Jobs Dashboard.
 *
 * Every scheduled / triggered / retried action in Anchor lands in agent_jobs.
 * This is the operator's view: Bull Board-style table with state filters,
 * retry/cancel buttons, and a detail panel for full payload + error.
 */
import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Loader2, RefreshCw, Play, X, Clock, AlertCircle, CheckCircle2,
  RotateCcw, PauseCircle, Zap,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const STATES = [
  { key: "", label: "All", color: "text-foreground" },
  { key: "pending", label: "Pending", color: "text-blue-400" },
  { key: "running", label: "Running", color: "text-amber-400" },
  { key: "retrying", label: "Retrying", color: "text-orange-400" },
  { key: "succeeded", label: "Succeeded", color: "text-emerald-400" },
  { key: "failed", label: "Failed", color: "text-red-400" },
  { key: "cancelled", label: "Cancelled", color: "text-muted-foreground" },
];

const REFRESH_MS = 3000;

function stateColor(s: string): string {
  return STATES.find(x => x.key === s)?.color ?? "text-muted-foreground";
}

function stateIcon(s: string) {
  const cls = "h-3 w-3";
  switch (s) {
    case "succeeded": return <CheckCircle2 className={cls + " text-emerald-400"} />;
    case "failed":    return <AlertCircle className={cls + " text-red-400"} />;
    case "running":   return <Loader2 className={cls + " text-amber-400 animate-spin"} />;
    case "retrying":  return <RotateCcw className={cls + " text-orange-400"} />;
    case "cancelled": return <PauseCircle className={cls + " text-muted-foreground"} />;
    default:          return <Clock className={cls + " text-blue-400"} />;
  }
}

export default function Jobs() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [selected, setSelected] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.getJobs({ state: filter || undefined, limit: 100 });
      setJobs(rows);
      setLoading(false);
      if (selected) {
        const latest = rows.find(r => r.id === selected.id);
        if (latest) setSelected(latest);
      }
    } catch {}
  }, [filter, selected]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const counts: Record<string, number> = {};
  jobs.forEach(j => { counts[j.state] = (counts[j.state] ?? 0) + 1; });

  const handleRetry = async (id: string) => {
    setBusyAction(id + ":retry");
    try { await api.retryJob(id); toast.success("Retry queued"); refresh(); }
    catch (err: any) { toast.error(err.message); }
    finally { setBusyAction(null); }
  };

  const handleCancel = async (id: string) => {
    setBusyAction(id + ":cancel");
    try { await api.cancelJob(id); toast.success("Cancelled"); refresh(); }
    catch (err: any) { toast.error(err.message); }
    finally { setBusyAction(null); }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-400" />
            Task Brain Jobs
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Every cron / trigger / manual enqueue lives here. Retries, failures, and state changes all tracked.
          </p>
        </div>
        <button onClick={refresh} className="glass rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {/* State filter chips */}
      <div className="flex gap-1 flex-wrap">
        {STATES.map(s => {
          const n = s.key ? (counts[s.key] ?? 0) : jobs.length;
          const active = filter === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setFilter(s.key)}
              className={`glass rounded-md px-3 py-1.5 text-xs transition-all flex items-center gap-1.5 ${
                active ? "bg-white/10 border border-white/10" : "hover:bg-white/[0.03]"
              }`}
            >
              <span className={s.color}>{s.label}</span>
              <span className="text-[10px] text-muted-foreground font-mono">{n}</span>
            </button>
          );
        })}
      </div>

      {/* Table + detail panel */}
      <div className="grid grid-cols-12 gap-4">
        <div className={`${selected ? "col-span-7" : "col-span-12"} glass rounded-xl overflow-hidden`}>
          <table className="w-full">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-white/5">
              <tr>
                <th className="text-left p-2 pl-3">State</th>
                <th className="text-left p-2">Name</th>
                <th className="text-left p-2">Source</th>
                <th className="text-left p-2">Action</th>
                <th className="text-right p-2">Attempts</th>
                <th className="text-left p-2">Next / Finished</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr><td colSpan={6} className="p-6 text-center text-xs text-muted-foreground/50">No jobs in this filter</td></tr>
              ) : jobs.map(j => (
                <tr
                  key={j.id}
                  onClick={() => setSelected(j)}
                  className={`border-b border-white/5 cursor-pointer transition-colors ${selected?.id === j.id ? "bg-white/[0.04]" : "hover:bg-white/[0.02]"}`}
                >
                  <td className="p-2 pl-3">
                    <div className="flex items-center gap-1.5">
                      {stateIcon(j.state)}
                      <span className={`text-[11px] ${stateColor(j.state)}`}>{j.state}</span>
                    </div>
                  </td>
                  <td className="p-2 text-sm text-foreground truncate max-w-[200px]">{j.name}</td>
                  <td className="p-2 text-[11px] text-muted-foreground font-mono">{j.source}</td>
                  <td className="p-2 text-[11px] text-muted-foreground">{j.action_type}</td>
                  <td className="p-2 text-right text-[11px] text-muted-foreground font-mono">{j.attempts}/{j.max_attempts}</td>
                  <td className="p-2 text-[10px] text-muted-foreground">
                    {j.finished_at ?? j.next_run_at}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail panel */}
        {selected && (
          <motion.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="col-span-5 glass rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {stateIcon(selected.state)}
                  <span className={`text-sm font-semibold ${stateColor(selected.state)}`}>{selected.state}</span>
                </div>
                <h3 className="text-sm font-medium text-foreground mt-1">{selected.name}</h3>
                <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{selected.id}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-muted-foreground/60 hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {selected.last_error && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Last error</div>
                <div className="bg-red-500/5 border border-red-500/10 rounded p-2 text-[11px] text-red-300 font-mono">
                  {selected.last_error}
                </div>
              </div>
            )}

            {selected.result_summary && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Result</div>
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded p-2 text-[11px] text-foreground/80">
                  {selected.result_summary}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Action config</div>
              <pre className="bg-black/30 rounded p-2 text-[10px] font-mono text-foreground/70 overflow-auto max-h-[200px] whitespace-pre-wrap">
                {JSON.stringify(selected.action_config, null, 2)}
              </pre>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div><span className="text-muted-foreground">source:</span> <span className="font-mono text-foreground/80">{selected.source}</span></div>
              <div><span className="text-muted-foreground">action:</span> <span className="font-mono text-foreground/80">{selected.action_type}</span></div>
              <div><span className="text-muted-foreground">attempts:</span> <span className="font-mono text-foreground/80">{selected.attempts}/{selected.max_attempts}</span></div>
              <div><span className="text-muted-foreground">next:</span> <span className="font-mono text-foreground/80">{selected.next_run_at}</span></div>
              {selected.run_id && <div className="col-span-2"><span className="text-muted-foreground">run_id:</span> <span className="font-mono text-foreground/80">{selected.run_id}</span></div>}
            </div>

            <div className="flex gap-2 pt-2 border-t border-white/5">
              {(selected.state === "pending" || selected.state === "retrying") && (
                <button
                  onClick={() => handleCancel(selected.id)}
                  disabled={busyAction === selected.id + ":cancel"}
                  className="flex-1 glass rounded-lg px-3 py-1.5 text-xs text-orange-400 hover:bg-orange-500/10 disabled:opacity-50"
                >
                  {busyAction === selected.id + ":cancel" ? <Loader2 className="h-3 w-3 animate-spin inline" /> : <X className="h-3 w-3 inline" />}
                  {" "}Cancel
                </button>
              )}
              {(selected.state === "failed" || selected.state === "cancelled") && (
                <button
                  onClick={() => handleRetry(selected.id)}
                  disabled={busyAction === selected.id + ":retry"}
                  className="flex-1 glass rounded-lg px-3 py-1.5 text-xs text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  {busyAction === selected.id + ":retry" ? <Loader2 className="h-3 w-3 animate-spin inline" /> : <Play className="h-3 w-3 inline" />}
                  {" "}Retry
                </button>
              )}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
