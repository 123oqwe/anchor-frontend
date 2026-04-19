/**
 * Node Detail — drill into any graph node.
 *
 * Shows: what it is, progress (tasks), who's connected, inline advisor.
 * User can: edit notes, add tasks, ask advisor, execute, change status, delete.
 *
 * Design: simple. Action-oriented. Not a data dump.
 */
import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  ArrowLeft, Save, Trash2, Mail, Target, Bell, Send,
  Loader2, Users, Briefcase, Heart, DollarSign,
  GraduationCap, Brain, ChevronRight, CheckCircle2,
  Circle, Clock, MessageSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { toast } from "sonner";

const TYPE_COLORS: Record<string, string> = {
  person: "text-purple-400", goal: "text-blue-400", project: "text-emerald-400",
  commitment: "text-amber-400", task: "text-blue-300", risk: "text-red-400",
  constraint: "text-amber-400", value: "text-emerald-300", preference: "text-cyan-400",
  behavioral_pattern: "text-rose-400", opportunity: "text-emerald-400", decision: "text-blue-400",
};
const DOMAIN_ICONS: Record<string, any> = {
  work: Briefcase, relationships: Users, finance: DollarSign, growth: GraduationCap, health: Heart,
};
const STATUS_ICON: Record<string, any> = {
  done: CheckCircle2, "in-progress": Clock, todo: Circle, blocked: Circle, active: Circle,
};
const STATUSES = ["active", "in-progress", "done", "blocked", "decaying", "stable"];

export default function NodeDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/graph/:id");
  const nodeId = params?.id;

  const [data, setData] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [askInput, setAskInput] = useState("");
  const [askResult, setAskResult] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!nodeId) return;
    Promise.all([
      api.getNodeDetail(nodeId),
      fetch(`/api/graph/nodes/${nodeId}/tasks`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([d, t]) => {
      setData(d);
      setNote(d.node?.detail ?? "");
      setTasks(t);
    }).catch(() => {})
    .finally(() => setLoading(false));
  }, [nodeId]);

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;
  if (!data?.node) return (
    <div className="min-h-screen flex items-center justify-center text-center">
      <div>
        <p className="text-sm text-muted-foreground mb-2">Node not found</p>
        <button onClick={() => navigate("/dashboard")} className="text-xs text-primary hover:underline">Back</button>
      </div>
    </div>
  );

  const { node, edges, health, importance } = data;
  const DomainIcon = DOMAIN_ICONS[node.domain] ?? Brain;
  const typeColor = TYPE_COLORS[node.type] ?? "text-muted-foreground";

  // Only show meaningful edges (not mass contextual 0.3 links)
  const meaningfulEdges = [
    ...(edges.outgoing ?? []).filter((e: any) => e.weight > 0.4 || e.type !== "contextual"),
    ...(edges.incoming ?? []).filter((e: any) => e.weight > 0.4 || e.type !== "contextual"),
  ].slice(0, 10);

  const handleSave = async () => {
    setSaving(true);
    await api.updateNode(node.id, { ...node, detail: note }).catch(() => toast.error("Failed"));
    setSaving(false);
    toast.success("Saved");
  };

  const handleAsk = async () => {
    if (asking) return;
    setAsking(true);
    setAskResult(null);
    try {
      const res = await fetch(`/api/graph/nodes/${nodeId}/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: askInput || undefined }),
      }).then(r => r.json());
      setAskResult(res.content);
      setAskInput("");
    } catch { toast.error("Failed to get advice"); }
    finally { setAsking(false); }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${node.label}"?`)) return;
    await api.deleteNode(node.id);
    toast.success("Deleted");
    navigate("/dashboard");
  };

  const handleStatusChange = async (s: string) => {
    await api.updateNode(node.id, { ...node, status: s });
    setData({ ...data, node: { ...node, status: s } });
    toast.success(`→ ${s}`);
  };

  return (
    <div className="min-h-screen dot-grid">
      <div className="max-w-2xl mx-auto px-6 pt-8 pb-20">

        <button onClick={() => navigate("/dashboard")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-3 w-3" /> Back
        </button>

        {/* ── Header ──────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-3 mb-1">
            <DomainIcon className={`h-5 w-5 ${typeColor}`} />
            <h1 className="text-2xl font-bold">{node.label}</h1>
          </div>
          <div className="flex items-center gap-2 mb-6">
            <Badge className={`text-[10px] ${typeColor} bg-white/5`}>{node.type}</Badge>
            <span className="text-[10px] text-muted-foreground">{node.domain}</span>
            <span className="text-[10px] text-muted-foreground">·</span>
            <select value={node.status} onChange={(e) => handleStatusChange(e.target.value)}
              className="text-[10px] text-primary bg-transparent border-none cursor-pointer focus:outline-none">
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* ── Meta ──────────────────────────────────── */}
          <div className="glass rounded-xl p-4 text-xs space-y-1.5 mb-6">
            <div className="flex justify-between"><span className="text-muted-foreground">Source</span><span>{node.captured}</span></div>
            {health !== null && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Health</span>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1 rounded-full bg-white/5 overflow-hidden">
                    <div className={`h-full rounded-full ${health > 70 ? "bg-emerald-400" : health > 40 ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${health}%` }} />
                  </div>
                  <span className="font-mono">{health}%</span>
                </div>
              </div>
            )}
            {importance !== null && importance > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Importance</span><span className="font-mono">{importance}%</span></div>
            )}
            <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{node.createdAt?.slice(0, 10)}</span></div>
          </div>
        </motion.div>

        {/* ── Tasks (progress) ────────────────────────── */}
        {tasks.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }} className="mb-6">
            <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Tasks</h2>
            <div className="glass rounded-xl p-4 space-y-2">
              {tasks.map((t: any) => {
                const Icon = STATUS_ICON[t.status] ?? Circle;
                return (
                  <div key={t.id} className="flex items-center gap-2 text-xs">
                    <Icon className={`h-3 w-3 ${t.status === "done" ? "text-emerald-400" : "text-muted-foreground/40"}`} />
                    <span className={t.status === "done" ? "line-through text-muted-foreground" : "text-foreground"}>{t.title}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/40">{t.projectName}</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* ── Connections (only meaningful ones) ────────── */}
        {meaningfulEdges.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }} className="mb-6">
            <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Connections</h2>
            <div className="glass rounded-xl p-4 space-y-1">
              {meaningfulEdges.map((e: any, i: number) => (
                <div key={i} onClick={() => navigate(`/graph/${e.toId ?? e.fromId}`)}
                  className="flex items-center gap-2 text-xs cursor-pointer hover:bg-white/[0.03] rounded px-2 py-1 -mx-2">
                  <span className={e.toId ? "text-primary" : "text-emerald-400"}>{e.toId ? "→" : "←"}</span>
                  <span className="text-muted-foreground">{e.type}</span>
                  <span className="text-foreground">{e.toLabel ?? e.fromLabel}</span>
                  <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/20 ml-auto" />
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── Notes ───────────────────────────────────── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="mb-6">
          <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Notes</h2>
          <div className="glass rounded-xl p-4">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="Add notes..."
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none resize-none" />
            <button onClick={handleSave} disabled={saving}
              className="mt-2 flex items-center gap-1 px-3 py-1 rounded-lg bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
            </button>
          </div>
        </motion.div>

        {/* ── Ask Anchor (inline advisor) ─────────────── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="mb-6">
          <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Ask Anchor</h2>
          <div className="glass rounded-xl p-4">
            <div className="flex gap-2">
              <input value={askInput} onChange={(e) => setAskInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                placeholder={`What should I do next with "${node.label}"?`}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none" />
              <button onClick={handleAsk} disabled={asking}
                className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                {asking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              </button>
            </div>
            {askResult && (
              <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="mt-3 p-3 bg-primary/5 rounded-lg">
                <div className="flex items-center gap-1.5 mb-1">
                  <MessageSquare className="h-3 w-3 text-primary" />
                  <span className="text-[10px] text-primary font-medium">Anchor</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{askResult}</p>
              </motion.div>
            )}
          </div>
        </motion.div>

        {/* ── Actions ─────────────────────────────────── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
          <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Actions</h2>
          <div className="flex flex-wrap gap-2">
            {node.type === "person" && (
              <button onClick={async () => {
                try {
                  const res = await fetch("/api/notifications/suggest-action", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ personLabel: node.label, context: node.detail, actionType: "send_email" }),
                  }).then(r => r.json());
                  window.location.href = `mailto:${res.to}?subject=${encodeURIComponent(res.subject)}&body=${encodeURIComponent(res.body)}`;
                } catch { toast.error("Could not draft email"); }
              }} className="flex items-center gap-1.5 glass rounded-lg px-3 py-2 text-xs hover:bg-white/[0.05]">
                <Mail className="h-3 w-3 text-blue-400" /> Draft Email
              </button>
            )}
            <button onClick={async () => {
              await api.createNode({ domain: "work", label: `Follow up: ${node.label}`, type: "task", status: "todo", detail: `Related to ${node.label}` });
              toast.success("Task created");
            }} className="flex items-center gap-1.5 glass rounded-lg px-3 py-2 text-xs hover:bg-white/[0.05]">
              <Target className="h-3 w-3 text-emerald-400" /> Create Task
            </button>
            <button onClick={handleDelete} className="flex items-center gap-1.5 glass rounded-lg px-3 py-2 text-xs text-red-400 hover:bg-red-500/5">
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        </motion.div>

      </div>
    </div>
  );
}
