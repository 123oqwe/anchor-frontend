/**
 * Phase 1-4 of #2 — Action sessions list.
 *
 * One row per compiled plan. Click into /sessions/:id for step-level
 * detail + pause/resume/cancel/takeover controls.
 */
import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import {
  Loader2, RefreshCw, Workflow, CheckCircle2, AlertCircle,
  PauseCircle, XCircle, Clock,
} from "lucide-react";
import { api } from "@/lib/api";

const REFRESH_MS = 3000;

const STATUS_META: Record<string, { color: string; icon: any; label: string }> = {
  pending:    { color: "text-blue-400",     icon: Clock,        label: "Pending" },
  running:    { color: "text-amber-400",    icon: Loader2,      label: "Running" },
  paused:     { color: "text-orange-400",   icon: PauseCircle,  label: "Paused" },
  completed:  { color: "text-emerald-400",  icon: CheckCircle2, label: "Completed" },
  failed:     { color: "text-red-400",      icon: AlertCircle,  label: "Failed" },
  cancelled:  { color: "text-muted-foreground", icon: XCircle,  label: "Cancelled" },
  compiling:  { color: "text-purple-400",   icon: Loader2,      label: "Compiling" },
};

interface Session {
  id: string;
  goal: string;
  status: string;
  current_step_id: string | null;
  plan_summary: string;
  compile_error: string | null;
  created_at: string;
  updated_at: string;
}

export default function Sessions() {
  const [items, setItems] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const list = await api.listSessions(filter || undefined);
      setItems(list);
      setLoading(false);
    } catch {}
  }, [filter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const counts: Record<string, number> = {};
  items.forEach(s => { counts[s.status] = (counts[s.status] ?? 0) + 1; });

  return (
    <div className="flex h-full flex-col p-6 gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <Workflow className="h-5 w-5" /> Sessions
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Compiled plan executions — one row per advisor confirmation.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-md border border-border/50 px-3 py-1.5 text-xs hover:bg-muted/50 inline-flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </header>

      <div className="flex flex-wrap gap-2 text-xs">
        <button
          onClick={() => setFilter("")}
          className={`rounded-md px-3 py-1.5 border ${!filter ? "bg-primary/10 border-primary/30 text-primary" : "border-border/50 hover:bg-muted/50"}`}
        >
          All
        </button>
        {Object.keys(STATUS_META).filter(k => counts[k]).map(k => {
          const m = STATUS_META[k];
          return (
            <button
              key={k}
              onClick={() => setFilter(k === filter ? "" : k)}
              className={`rounded-md px-3 py-1.5 border ${filter === k ? "bg-primary/10 border-primary/30 text-primary" : "border-border/50 hover:bg-muted/50"}`}
            >
              <span className={m.color}>{m.label}</span>
              <span className="ml-2 font-mono">{counts[k]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg border border-border/50 bg-card/30">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No sessions yet. Confirm a plan in Advisor to create one.
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {items.map(s => {
              const meta = STATUS_META[s.status] ?? STATUS_META.pending;
              const Icon = meta.icon;
              return (
                <motion.li
                  key={s.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <Link href={`/sessions/${s.id}`}>
                    <a className="block px-4 py-3 hover:bg-muted/20">
                      <div className="flex items-start gap-3">
                        <div className={meta.color}>
                          <Icon className={`h-4 w-4 ${s.status === "running" || s.status === "compiling" ? "animate-spin" : ""}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span className={`text-[10px] uppercase tracking-wider ${meta.color}`}>{meta.label}</span>
                            <span className="text-[10px] text-muted-foreground/60 font-mono">{s.id.slice(0, 8)}</span>
                            <span className="text-[10px] text-muted-foreground/60">
                              {new Date(s.updated_at + "Z").toLocaleString()}
                            </span>
                          </div>
                          <div className="font-medium text-sm line-clamp-1">{s.goal}</div>
                          {s.plan_summary && (
                            <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{s.plan_summary}</div>
                          )}
                          {s.compile_error && (
                            <div className="text-xs text-red-400 line-clamp-1 mt-0.5">⚠ {s.compile_error}</div>
                          )}
                        </div>
                      </div>
                    </a>
                  </Link>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
