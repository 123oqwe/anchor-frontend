/**
 * Sprint B (#4) — Unified Approval Inbox.
 *
 * Surfaces every pending decision in one list:
 * - L6 gate require_confirmation rows (informational — audit-only)
 * - bridge app-approval pending
 * - SessionRunner step-level approval (Phase 4 of #2)
 * - agent_runs interrupted (informational link to /admin/runs/:id)
 */
import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Loader2, RefreshCw, Check, X, AlertTriangle, ShieldAlert,
  Mail, Wrench, Bot, ScrollText, FileText,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const REFRESH_MS = 3000;

const SOURCE_META: Record<string, { label: string; icon: any; color: string }> = {
  gate:     { label: "Permission Gate", icon: ShieldAlert, color: "text-amber-400" },
  app:      { label: "App Access",      icon: Wrench,      color: "text-blue-400"  },
  proposal: { label: "Mutation",        icon: ScrollText,  color: "text-purple-400" },
  run:      { label: "Agent Run",       icon: Bot,         color: "text-emerald-400" },
  step:     { label: "Plan Step",       icon: FileText,    color: "text-cyan-400" },
};

const RISK_COLOR: Record<string, string> = {
  low:      "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  medium:   "bg-amber-500/10 text-amber-400 border-amber-500/20",
  high:     "bg-orange-500/10 text-orange-400 border-orange-500/20",
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
};

interface Approval {
  id: string;
  source: string;
  source_ref_id: string;
  title: string;
  summary: string;
  detail: { informational?: boolean; [k: string]: any };
  risk_level: "low" | "medium" | "high" | "critical";
  status: string;
  created_at: string;
}

export default function Approvals() {
  const [items, setItems] = useState<Approval[]>([]);
  const [stats, setStats] = useState<{ pending: number; pendingByRisk: Record<string, number>; pendingBySource: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([
        api.listApprovals("pending", filter || undefined),
        api.approvalStats(),
      ]);
      setItems(list);
      setStats(s);
      setLoading(false);
    } catch {}
  }, [filter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id + (approve ? ":a" : ":r"));
    try {
      await api.decideApproval(id, approve);
      toast.success(approve ? "Approved" : "Rejected");
      refresh();
    } catch (err: any) {
      toast.error(err.message || "Decision failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col p-6 gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="text-sm text-muted-foreground mt-1">
            One inbox for every pending decision across the system.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-md border border-border/50 px-3 py-1.5 text-xs hover:bg-muted/50 inline-flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </header>

      {/* Stats strip */}
      {stats && (
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            onClick={() => setFilter("")}
            className={`rounded-md px-3 py-1.5 border ${!filter ? "bg-primary/10 border-primary/30 text-primary" : "border-border/50 hover:bg-muted/50"}`}
          >
            All <span className="ml-1 font-mono">{stats.pending}</span>
          </button>
          {Object.entries(stats.pendingBySource).filter(([, n]) => n > 0).map(([src, n]) => {
            const meta = SOURCE_META[src];
            const Icon = meta?.icon ?? AlertTriangle;
            return (
              <button
                key={src}
                onClick={() => setFilter(src === filter ? "" : src)}
                className={`rounded-md px-3 py-1.5 border inline-flex items-center gap-1.5 ${filter === src ? "bg-primary/10 border-primary/30 text-primary" : "border-border/50 hover:bg-muted/50"}`}
              >
                <Icon className={`h-3 w-3 ${meta?.color ?? ""}`} />
                {meta?.label ?? src}
                <span className="font-mono">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto rounded-lg border border-border/50 bg-card/30">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No pending approvals.
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {items.map((a) => {
              const meta = SOURCE_META[a.source];
              const Icon = meta?.icon ?? Mail;
              const isInformational = a.detail?.informational === true;
              return (
                <motion.li
                  key={a.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="px-4 py-3 hover:bg-muted/20"
                >
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 ${meta?.color ?? ""}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${RISK_COLOR[a.risk_level] ?? RISK_COLOR.medium}`}>
                          {a.risk_level}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {meta?.label ?? a.source}
                        </span>
                        {isInformational && (
                          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-muted/50 text-muted-foreground">
                            audit-only
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground/60">
                          {new Date(a.created_at + "Z").toLocaleString()}
                        </span>
                      </div>
                      <div className="font-medium text-sm">{a.title}</div>
                      {a.summary && (
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{a.summary}</div>
                      )}
                    </div>
                    {!isInformational ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => decide(a.id, true)}
                          disabled={busy === a.id + ":a"}
                          className="rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 px-3 py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          {busy === a.id + ":a" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Approve
                        </button>
                        <button
                          onClick={() => decide(a.id, false)}
                          disabled={busy === a.id + ":r"}
                          className="rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          {busy === a.id + ":r" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground italic">already decided synchronously</span>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
