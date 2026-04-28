/**
 * /graphs — index page for the 5 vertical Human Graphs.
 *
 * Each graph is its own card. Click → /graphs/:id detail. Cards show
 * connection-health dot so the user immediately sees which graphs are
 * fully wired vs partial vs error.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { Users, Clock, Briefcase, Zap, DollarSign, ChevronRight, Loader2, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";

interface GraphMeta {
  id: string;
  name: string;
  path: string;
  status: string;
}

const ICONS: Record<string, any> = {
  relationship: Users,
  time:         Clock,
  work:         Briefcase,
  energy:       Zap,
  finance:      DollarSign,
};

const COLORS: Record<string, string> = {
  relationship: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  time:         "text-blue-400 bg-blue-500/10 border-blue-500/20",
  work:         "text-amber-400 bg-amber-500/10 border-amber-500/20",
  energy:       "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  finance:      "text-rose-400 bg-rose-500/10 border-rose-500/20",
};

const TAGLINES: Record<string, string> = {
  relationship: "Who's in your life — and who's drifting",
  time:         "Where your hours actually go",
  work:         "Projects, commits, AI sessions",
  energy:       "Focus, rhythm, chronotype",
  finance:      "Spend, income, by category",
};

interface ConnectionSummary {
  ok: number;
  warning: number;
  error: number;
}

export default function Graphs() {
  const [graphs, setGraphs] = useState<GraphMeta[]>([]);
  const [conns, setConns] = useState<Record<string, ConnectionSummary>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listGraphs();
        if (cancelled) return;
        setGraphs(list.available);

        // Fetch each graph's health probe in parallel for the connection dots
        const summaries = await Promise.all(list.available.map(async (g) => {
          if (g.status !== "ready") return [g.id, { ok: 0, warning: 0, error: 0 }] as const;
          try {
            const r = await fetch(`${g.path}/health`, { credentials: "include" });
            if (!r.ok) return [g.id, { ok: 0, warning: 0, error: 0 }] as const;
            const data = await r.json() as { connections: Array<{ status: string }> };
            const sum = { ok: 0, warning: 0, error: 0 };
            for (const c of data.connections) {
              if (c.status === "ok") sum.ok++;
              else if (c.status === "warning") sum.warning++;
              else sum.error++;
            }
            return [g.id, sum] as const;
          } catch {
            return [g.id, { ok: 0, warning: 0, error: 0 }] as const;
          }
        }));
        if (cancelled) return;
        setConns(Object.fromEntries(summaries));
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen text-zinc-500">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center min-h-screen text-rose-400 gap-2">
      <AlertCircle className="w-5 h-5" />
      <span>{error}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-12">
      <div className="max-w-5xl mx-auto">
        <header className="mb-10">
          <h1 className="text-3xl font-light tracking-tight">Human Graph</h1>
          <p className="text-zinc-500 text-sm mt-2">5 lenses on your life — each backed by your own data.</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {graphs.map((g, i) => {
            const Icon = ICONS[g.id] ?? Users;
            const colorClass = COLORS[g.id] ?? "text-zinc-400 bg-zinc-500/10 border-zinc-500/20";
            const tagline = TAGLINES[g.id] ?? "";
            const c = conns[g.id];
            const isReady = g.status === "ready";

            return (
              <motion.div
                key={g.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <Link href={isReady ? `/graphs/${g.id}` : "#"}>
                  <div className={`group rounded-xl border p-5 transition cursor-pointer ${colorClass} hover:bg-opacity-20 ${isReady ? "" : "opacity-50 cursor-not-allowed"}`}>
                    <div className="flex items-start justify-between">
                      <Icon className="w-6 h-6" />
                      {isReady ? <ChevronRight className="w-5 h-5 opacity-0 group-hover:opacity-100 transition" />
                               : <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500">planned</span>}
                    </div>
                    <div className="mt-4">
                      <h2 className="text-lg font-medium">{g.name}</h2>
                      <p className="text-zinc-400 text-sm mt-1">{tagline}</p>
                    </div>
                    {isReady && c && (
                      <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-emerald-400" /> {c.ok}
                        </span>
                        {c.warning > 0 && <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-amber-400" /> {c.warning}
                        </span>}
                        {c.error > 0 && <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-rose-400" /> {c.error} planned
                        </span>}
                      </div>
                    )}
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
