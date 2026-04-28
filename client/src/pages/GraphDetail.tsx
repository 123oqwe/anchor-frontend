/**
 * /graphs/:id — detail page for a single vertical graph.
 *
 * Renders shape-specific content per graph id (relationship/time/work/
 * energy/finance) but uses the same SourceHealth strip + "Honest limits"
 * disclosure shape so the user always knows what's real vs planned.
 */
import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { motion } from "framer-motion";
import {
  ArrowLeft, Loader2, AlertCircle, Plus, Trash2,
  Users, Clock, Briefcase, Zap, DollarSign,
} from "lucide-react";
import { api } from "@/lib/api";

interface SourceHealth {
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | "disabled";
  detail?: string;
  rowsObserved?: number;
}

interface GraphSummary {
  graph: string;
  generatedAt: string;
  connections: SourceHealth[];
  data: any;
}

const META: Record<string, { name: string; icon: any; color: string }> = {
  relationship: { name: "Relationships", icon: Users,      color: "text-purple-400" },
  time:         { name: "Time",          icon: Clock,      color: "text-blue-400" },
  work:         { name: "Work",          icon: Briefcase,  color: "text-amber-400" },
  energy:       { name: "Energy",        icon: Zap,        color: "text-emerald-400" },
  finance:      { name: "Finance",       icon: DollarSign, color: "text-rose-400" },
};

export default function GraphDetail() {
  const [, params] = useRoute("/graphs/:id");
  const id = params?.id ?? "";
  const [data, setData] = useState<GraphSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      let g: GraphSummary;
      switch (id) {
        case "relationship": g = await api.getGraphRelationship() as GraphSummary; break;
        case "time":         g = await api.getGraphTime()         as GraphSummary; break;
        case "work":         g = await api.getGraphWork()         as GraphSummary; break;
        case "energy":       g = await api.getGraphEnergy()       as GraphSummary; break;
        case "finance":      g = await api.getGraphFinance()      as GraphSummary; break;
        default: throw new Error(`unknown graph: ${id}`);
      }
      setData(g);
    } catch (e: any) {
      setError(e?.message ?? "failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [id]);

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen text-zinc-500">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );
  if (error || !data) return (
    <div className="flex flex-col items-center justify-center min-h-screen text-rose-400 gap-2">
      <AlertCircle className="w-5 h-5" />
      <span>{error ?? "no data"}</span>
    </div>
  );

  const meta = META[id];
  const Icon = meta?.icon ?? Users;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-12">
      <div className="max-w-4xl mx-auto">
        <Link href="/graphs" className="inline-flex items-center text-zinc-500 hover:text-zinc-300 text-sm mb-6">
          <ArrowLeft className="w-4 h-4 mr-1" /> All graphs
        </Link>

        <header className="mb-8 flex items-center gap-3">
          <Icon className={`w-7 h-7 ${meta?.color ?? "text-zinc-300"}`} />
          <h1 className="text-2xl font-light tracking-tight">{meta?.name ?? id}</h1>
        </header>

        {/* Connection health strip */}
        <ConnectionStrip connections={data.connections} />

        {/* Per-graph body */}
        <div className="mt-8 space-y-6">
          {id === "relationship" && <RelationshipView data={data.data} />}
          {id === "time"         && <TimeView         data={data.data} />}
          {id === "work"         && <WorkView         data={data.data} />}
          {id === "energy"       && <EnergyView       data={data.data} />}
          {id === "finance"      && <FinanceView      data={data.data} onChange={reload} />}
        </div>
      </div>
    </div>
  );
}

// ── Shared widgets ─────────────────────────────────────────────────────────

function ConnectionStrip({ connections }: { connections: SourceHealth[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Data sources</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {connections.map(c => {
          const dot = c.status === "ok" ? "bg-emerald-400"
                   : c.status === "warning" ? "bg-amber-400"
                   : "bg-rose-400/70";
          return (
            <div key={c.id} className="flex items-start gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dot}`} />
              <div className="min-w-0 flex-1">
                <div className="text-zinc-300">{c.label}</div>
                {c.detail && <div className="text-xs text-zinc-500 truncate">{c.detail}</div>}
              </div>
              {typeof c.rowsObserved === "number" && (
                <div className="text-xs text-zinc-600 shrink-0 tabular-nums">{c.rowsObserved}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
      <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">{title}</h3>
      {children}
    </div>
  );
}

// ── Relationship ──────────────────────────────────────────────────────────

function RelationshipView({ data }: { data: any }) {
  const top = data.topClose ?? [];
  const need = data.needsAttention ?? [];
  const bs = data.byStatus ?? {};
  return (
    <>
      <Card title="At a glance">
        <div className="grid grid-cols-4 gap-4 text-center">
          <Stat label="Total" value={data.total} />
          <Stat label="Healthy" value={bs.healthy ?? 0} dotClass="bg-emerald-400" />
          <Stat label="Cooling" value={bs.cooling ?? 0} dotClass="bg-amber-400" />
          <Stat label="Decaying" value={bs.decaying ?? 0} dotClass="bg-rose-400" />
        </div>
      </Card>

      <Card title="Closest people">
        {top.length === 0 ? <Empty /> : (
          <ul className="divide-y divide-zinc-800">
            {top.map((p: any) => (
              <li key={p.id} className="py-2 flex items-center justify-between text-sm">
                <span className="text-zinc-200">{p.name}</span>
                <span className="text-zinc-500 text-xs">
                  closeness {p.closeness} · {p.daysSinceContact !== null ? `${p.daysSinceContact}d` : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Needs attention">
        {need.length === 0 ? <p className="text-sm text-zinc-500">Nothing decaying right now.</p> : (
          <ul className="divide-y divide-zinc-800">
            {need.map((p: any) => (
              <li key={p.id} className="py-2 flex items-center justify-between text-sm">
                <span className="text-zinc-200">{p.name}</span>
                <span className="text-rose-400 text-xs">{p.daysSinceContact}d quiet</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ── Time ──────────────────────────────────────────────────────────────────

function TimeView({ data }: { data: any }) {
  const today = data.today;
  const days = data.last7Days ?? [];
  const blocks = data.deepWorkBlocksLast7d ?? [];
  return (
    <>
      <Card title="Today">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Captured" value={`${today.totalMinutes} min`} />
          <Stat label="Top category" value={today.byCategory?.[0]?.category ?? "—"} />
        </div>
        {today.byCategory?.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {today.byCategory.map((b: any) => (
              <BarRow key={b.category} label={b.category} value={b.minutes} max={today.totalMinutes} unit="min" />
            ))}
          </div>
        )}
      </Card>

      <Card title="Last 7 days">
        <div className="space-y-1">
          {days.map((d: any) => (
            <BarRow key={d.date} label={d.date.slice(5)} value={d.totalMinutes}
                    max={Math.max(...days.map((x: any) => x.totalMinutes), 1)} unit="min" />
          ))}
        </div>
      </Card>

      <Card title="Deep-work blocks (7d)">
        {blocks.length === 0 ? <p className="text-sm text-zinc-500">None detected.</p> : (
          <ul className="divide-y divide-zinc-800">
            {blocks.map((b: any, i: number) => (
              <li key={i} className="py-2 flex items-center justify-between text-sm">
                <span className="text-zinc-200">{b.primaryApp} <span className="text-zinc-500 text-xs">· {b.category}</span></span>
                <span className="text-zinc-500 text-xs">{b.minutes} min · {b.startedAt.slice(11, 16)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ── Work ──────────────────────────────────────────────────────────────────

function WorkView({ data }: { data: any }) {
  const projs = data.activeProjects ?? [];
  const stale = data.staleProjects ?? [];
  const c = data.commitsLast30d ?? { count: 0, byDay: [] };
  const sessions = data.recentAgentSessions ?? [];
  return (
    <>
      <Card title="Snapshot">
        <div className="grid grid-cols-3 gap-4 text-center">
          <Stat label="Projects"    value={data.totals.projects} />
          <Stat label="Commits 30d" value={data.totals.commits30d} />
          <Stat label="AI sessions 7d" value={data.totals.aiSessionsLast7d} />
        </div>
      </Card>

      <Card title="Active projects">
        {projs.length === 0 ? <Empty /> : (
          <ul className="divide-y divide-zinc-800">
            {projs.map((p: any) => (
              <li key={p.id} className="py-2 flex items-center justify-between text-sm">
                <span className="text-zinc-200">{p.label}</span>
                <span className="text-zinc-500 text-xs">{p.status} · {p.daysSinceUpdate}d</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {stale.length > 0 && (
        <Card title="Slipping">
          <ul className="divide-y divide-zinc-800">
            {stale.map((p: any) => (
              <li key={p.id} className="py-2 flex items-center justify-between text-sm">
                <span className="text-zinc-200">{p.label}</span>
                <span className="text-amber-400 text-xs">{p.status} · {p.daysSinceUpdate}d</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Commits last 30 days">
        {c.count === 0 ? <Empty /> : (
          <div className="space-y-1">
            {c.byDay.map((d: any) => (
              <BarRow key={d.date} label={d.date.slice(5)} value={d.count}
                      max={Math.max(...c.byDay.map((x: any) => x.count), 1)} unit="" />
            ))}
          </div>
        )}
      </Card>

      <Card title="Recent AI sessions">
        {sessions.length === 0 ? <Empty /> : (
          <ul className="divide-y divide-zinc-800">
            {sessions.map((s: any) => (
              <li key={s.id} className="py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-200">{s.agentName}</span>
                  <span className="text-zinc-500 text-xs">{s.status} · turn {s.turn}</span>
                </div>
                <p className="text-zinc-500 text-xs mt-1 truncate">{s.preview}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ── Energy ────────────────────────────────────────────────────────────────

function EnergyView({ data }: { data: any }) {
  const cur = data.current; const today = data.todayProfile; const p = data.patterns;
  return (
    <>
      <Card title="Right now">
        <div className="grid grid-cols-3 gap-4 text-center">
          <Stat label="Focus" value={`${cur.focusScore}/100`} />
          <Stat label="State" value={cur.state} />
          <Stat label="Last capture"
                value={cur.minutesSinceLastCapture != null ? `${cur.minutesSinceLastCapture}m ago` : "—"} />
        </div>
      </Card>

      <Card title="Today">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <Stat label="Captured" value={`${today.captureMinutes}m`} />
          <Stat label="App switches" value={today.appSwitches} />
          <Stat label="Longest dwell" value={`${today.longestDwellMinutes}m`} />
          <Stat label="Night-owl mins" value={today.nightOwlMinutes} />
        </div>
        {today.longestDwellApp && (
          <p className="text-xs text-zinc-500 mt-3">Longest in: {today.longestDwellApp}</p>
        )}
      </Card>

      <Card title="7-day rhythm (UTC)">
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            Chronotype: <span className="text-emerald-400">{p.chronotype}</span>
          </p>
          <p className="text-sm text-zinc-500">
            Peak hour: {p.typicalPeakHour ?? "—"}h · Quietest: {p.typicalNadirHour ?? "—"}h
          </p>
          <div className="flex items-end gap-0.5 h-16 mt-3">
            {p.hourHistogram?.map((m: number, h: number) => {
              const max = Math.max(...p.hourHistogram, 1);
              const height = (m / max) * 100;
              return (
                <div key={h} className="flex-1 bg-emerald-500/40 rounded-t-sm relative group"
                     style={{ height: `${height}%`, minHeight: "1px" }}>
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] text-zinc-500 opacity-0 group-hover:opacity-100">
                    {h}h:{m}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
            <span>0h</span><span>12h</span><span>23h</span>
          </div>
        </div>
      </Card>

      <Card title="Honest limit">
        <p className="text-xs text-zinc-500 leading-relaxed">
          v1 hours are UTC (matches storage), not your local time. So "peak hour 22"
          may actually be evening or afternoon depending on where you live.
          Apple Health, mood emoji, and typing telemetry are planned — see Data Sources above.
        </p>
      </Card>
    </>
  );
}

// ── Finance ───────────────────────────────────────────────────────────────

function FinanceView({ data, onChange }: { data: any; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ amount: "", category: "food", merchant: "", isExpense: true });
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) { setErr("amount must be > 0"); return; }
    const cents = Math.round(amount * 100) * (form.isExpense ? -1 : 1);
    try {
      await api.addFinanceTx({ amountCents: cents, category: form.category, merchant: form.merchant || undefined });
      setForm({ amount: "", category: "food", merchant: "", isExpense: true });
      setAdding(false);
      onChange();
    } catch (e: any) {
      setErr(e?.message ?? "failed");
    }
  };

  if (!data.hasData) {
    return (
      <>
        <Card title="No data yet">
          <p className="text-sm text-zinc-400 mb-4">{data.noDataReason}</p>
          <button onClick={() => setAdding(true)}
                  className="text-sm bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 px-3 py-1.5 rounded-md">
            <Plus className="w-3 h-3 inline mr-1" /> Add your first transaction
          </button>
        </Card>
        {adding && <AddTxForm form={form} setForm={setForm} submit={submit} err={err} cancel={() => setAdding(false)} />}
      </>
    );
  }

  const tm = data.thisMonth;
  return (
    <>
      <Card title={`This month (${tm.yyyymm})`}>
        <div className="grid grid-cols-3 gap-4 text-center">
          <Stat label="Income"  value={`$${tm.totalIncome}`}  dotClass="bg-emerald-400" />
          <Stat label="Expense" value={`$${tm.totalExpense}`} dotClass="bg-rose-400" />
          <Stat label="Net"     value={`$${tm.net}`} />
        </div>
        {tm.byCategory.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {tm.byCategory.map((c: any) => (
              <BarRow key={c.category} label={c.category} value={c.expenseCents / 100}
                      max={Math.max(...tm.byCategory.map((x: any) => x.expenseCents / 100), 1)} unit="$" />
            ))}
          </div>
        )}
      </Card>

      <Card title="Last 7 days">
        <div className="grid grid-cols-3 gap-4 text-center">
          <Stat label="Income"  value={`$${data.last7d.income}`} />
          <Stat label="Expense" value={`$${data.last7d.expense}`} />
          <Stat label="Count"   value={data.last7d.count} />
        </div>
      </Card>

      <Card title="Recent transactions">
        <div className="flex justify-end mb-3">
          <button onClick={() => setAdding(!adding)}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded-md">
            <Plus className="w-3 h-3 inline mr-1" /> Add
          </button>
        </div>
        {adding && <AddTxForm form={form} setForm={setForm} submit={submit} err={err} cancel={() => setAdding(false)} />}
        <ul className="divide-y divide-zinc-800">
          {data.recentTransactions.map((t: any) => (
            <li key={t.id} className="py-2 flex items-center justify-between text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-zinc-200">{t.merchant ?? "(no merchant)"} <span className="text-zinc-500 text-xs">· {t.category}</span></div>
                <div className="text-xs text-zinc-500">{t.occurredAt.slice(0, 10)}</div>
              </div>
              <span className={`text-sm tabular-nums ${t.amount >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {t.amount >= 0 ? "+" : ""}${t.amount.toFixed(2)}
              </span>
              <button onClick={async () => { await api.deleteFinanceTx(t.id); onChange(); }}
                      className="ml-3 text-zinc-600 hover:text-rose-400">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function AddTxForm({ form, setForm, submit, err, cancel }: any) {
  return (
    <form onSubmit={submit} className="rounded-md border border-zinc-800 p-3 mb-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input type="number" step="0.01" placeholder="amount"
               value={form.amount}
               onChange={e => setForm({ ...form, amount: e.target.value })}
               className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm" />
        <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm">
          {["food","transport","housing","software","entertainment","bills","healthcare","travel","education","shopping","income","other"].map(c =>
            <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <input type="text" placeholder="merchant (optional)"
             value={form.merchant}
             onChange={e => setForm({ ...form, merchant: e.target.value })}
             className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm" />
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input type="checkbox" checked={form.isExpense}
               onChange={e => setForm({ ...form, isExpense: e.target.checked })} />
        Expense (uncheck for income)
      </label>
      {err && <p className="text-xs text-rose-400">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" className="text-xs bg-emerald-600/30 text-emerald-300 hover:bg-emerald-600/40 px-3 py-1 rounded-md">Save</button>
        <button type="button" onClick={cancel} className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1">Cancel</button>
      </div>
    </form>
  );
}

// ── Tiny shared UI ─────────────────────────────────────────────────────────

function Stat({ label, value, dotClass }: { label: string; value: any; dotClass?: string }) {
  return (
    <div>
      <div className="text-xl font-light tabular-nums text-zinc-100 flex items-center justify-center gap-2">
        {dotClass && <span className={`w-2 h-2 rounded-full ${dotClass}`} />}
        {value}
      </div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  );
}

function BarRow({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 text-zinc-400 truncate">{label}</span>
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <motion.div className="h-full bg-zinc-500/60 rounded-full"
                    initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.4 }} />
      </div>
      <span className="w-16 text-right text-zinc-500 tabular-nums">{value}{unit}</span>
    </div>
  );
}

function Empty() { return <p className="text-sm text-zinc-500">No data.</p>; }
