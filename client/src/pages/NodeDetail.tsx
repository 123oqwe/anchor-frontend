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
  ArrowLeft, Save, Trash2, Mail, Target, Send,
  Loader2, Users, Briefcase, Heart, DollarSign,
  GraduationCap, Brain, ChevronRight, CheckCircle2,
  Circle, Clock, MessageSquare, X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { toast } from "sonner";
import VoiceInput from "@/components/VoiceInput";

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

function MiniGraph({ node, edges }: { node: any; edges: { outgoing: any[]; incoming: any[] } }) {
  const allEdges = [
    ...(edges.outgoing ?? []).filter((e: any) => e.weight > 0.3 || e.type !== "contextual"),
    ...(edges.incoming ?? []).filter((e: any) => e.weight > 0.3 || e.type !== "contextual"),
  ].slice(0, 12);

  if (allEdges.length === 0) return null;

  const [, navigate] = useLocation();
  const cx = 150, cy = 100; // center
  const r = 70; // radius

  const neighbors = allEdges.map((e: any, i: number) => {
    const angle = (i / allEdges.length) * 2 * Math.PI - Math.PI / 2;
    return {
      id: e.toId ?? e.fromId,
      label: e.toLabel ?? e.fromLabel,
      type: e.type,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    };
  });

  return (
    <svg viewBox="0 0 300 200" className="w-full h-40">
      {/* Edges */}
      {neighbors.map((n, i) => (
        <line key={`e${i}`} x1={cx} y1={cy} x2={n.x} y2={n.y}
          stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      ))}
      {/* Center node */}
      <circle cx={cx} cy={cy} r="18" fill="rgba(59, 130, 246, 0.2)" stroke="rgba(59, 130, 246, 0.5)" strokeWidth="1.5" />
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill="rgba(59, 130, 246, 0.9)" fontSize="7" fontWeight="600">
        {node.label.length > 12 ? node.label.slice(0, 10) + ".." : node.label}
      </text>
      {/* Neighbor nodes */}
      {neighbors.map((n, i) => (
        <g key={i} onClick={() => n.id && navigate(`/graph/${n.id}`)} className="cursor-pointer">
          <circle cx={n.x} cy={n.y} r="14" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <text x={n.x} y={n.y - 2} textAnchor="middle" dominantBaseline="middle" fill="rgba(255,255,255,0.6)" fontSize="5.5">
            {n.label.length > 10 ? n.label.slice(0, 8) + ".." : n.label}
          </text>
          <text x={n.x} y={n.y + 6} textAnchor="middle" fill="rgba(255,255,255,0.25)" fontSize="4">
            {n.type}
          </text>
        </g>
      ))}
    </svg>
  );
}

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
  const [skills, setSkills] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [executing, setExecuting] = useState(false);
  const [toolModal, setToolModal] = useState<{ name: string; tool: string; icon: string } | null>(null);
  const [toolInput, setToolInput] = useState("");

  useEffect(() => {
    if (!nodeId) return;
    Promise.all([
      api.getNodeDetail(nodeId),
      fetch(`/api/graph/nodes/${nodeId}/tasks`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/api/skills").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/api/agents/executions").then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([d, t, sk, ex]) => {
      setData(d);
      setNote(d.node?.detail ?? "");
      setTasks(t);
      setSkills(sk);
      // Filter executions related to this node
      const nodeLabel = d.node?.label ?? "";
      setExecutions(ex.filter((e: any) => e.action?.toLowerCase().includes(nodeLabel.split(" ")[0]?.toLowerCase())).slice(0, 5));
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

        {/* ── Graph Visualization ────────────────────── */}
        {(edges.outgoing?.length > 0 || edges.incoming?.length > 0) && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08 }} className="mb-6">
            <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Graph</h2>
            <div className="glass rounded-xl p-4">
              <MiniGraph node={node} edges={edges} />
            </div>
          </motion.div>
        )}

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
            <div className="flex gap-2 items-center">
              <input value={askInput} onChange={(e) => setAskInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                placeholder={`What should I do next with "${node.label}"?`}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none" />
              <VoiceInput onTranscript={(t) => { setAskInput(t); }} className="relative" />
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

        {/* ── Skills ──────────────────────────────────── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mb-6">
          <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Skills</h2>
          <div className="glass rounded-xl p-4">
            {skills.length > 0 ? (
              <div className="space-y-2">
                {skills.map((sk: any) => (
                  <div key={sk.id} className="flex items-center gap-2 text-xs">
                    <span className="text-primary">⚡</span>
                    <span className="text-foreground flex-1">{sk.name}</span>
                    <span className="text-[10px] text-muted-foreground/40">used {sk.use_count}x</span>
                    <button onClick={async () => {
                      setExecuting(true);
                      toast.success(`Running skill: ${sk.name}...`);
                      try {
                        await fetch(`/api/graph/nodes/${nodeId}/ask`, {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ message: `Execute skill "${sk.name}" for "${node.label}": ${sk.steps?.join(", ") ?? sk.description}` }),
                        });
                        toast.success("Skill executed");
                      } catch { toast.error("Failed"); }
                      setExecuting(false);
                    }} className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] hover:bg-primary/20">
                      Run
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-2">
                <p className="text-xs text-muted-foreground/40 mb-2">No skills yet — they auto-generate from repeated patterns</p>
                <p className="text-[10px] text-muted-foreground/30">Confirm 3+ similar plans → skill crystallizes automatically</p>
              </div>
            )}
          </div>
        </motion.div>

        {/* ── Agent Execution ────────────────────────────── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }} className="mb-6">
          <h2 className="text-xs text-muted-foreground/60 tracking-widest uppercase mb-3">Agent Tools</h2>
          <div className="glass rounded-xl p-4">
            <div className="grid grid-cols-2 gap-2 mb-3">
              {[
                { name: "Send Email", tool: "send_email", icon: "📧", desc: "via Mail.app" },
                { name: "Calendar Event", tool: "create_calendar", icon: "📅", desc: "via Calendar.app" },
                { name: "Set Reminder", tool: "create_reminder", icon: "🔔", desc: "via Reminders" },
                { name: "Web Search", tool: "web_search", icon: "🔍", desc: "DuckDuckGo" },
                { name: "Open URL", tool: "open_url", icon: "🌐", desc: "default browser" },
                { name: "Run Code", tool: "execute_code", icon: "💻", desc: "Python / Node / bash" },
              ].map(t => (
                <button key={t.tool} onClick={() => { setToolModal({ name: t.name, tool: t.tool, icon: t.icon }); setToolInput(""); }}
                  disabled={executing}
                  className="flex items-center gap-2 glass rounded-lg px-3 py-2 text-xs hover:bg-white/[0.03] disabled:opacity-50">
                  <span>{t.icon}</span>
                  <div className="text-left">
                    <div className="text-foreground">{t.name}</div>
                    <div className="text-[9px] text-muted-foreground/40">{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Tool Input Modal */}
            {toolModal && (
              <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="mt-3 p-3 border border-primary/20 rounded-lg bg-background/80">
                <div className="flex items-center gap-2 mb-2">
                  <span>{toolModal.icon}</span>
                  <span className="text-xs font-medium text-foreground">{toolModal.name}</span>
                  <button onClick={() => setToolModal(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={toolInput}
                    onChange={(e) => setToolInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && toolInput.trim()) {
                        setExecuting(true);
                        setToolModal(null);
                        toast.success(`Running ${toolModal.name}...`);
                        fetch(`/api/graph/nodes/${nodeId}/ask`, {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ message: `Use the ${toolModal.tool} tool for "${node.label}": ${toolInput}` }),
                        }).then(() => toast.success(`${toolModal.name} complete`))
                          .catch(() => toast.error("Failed"))
                          .finally(() => setExecuting(false));
                      }
                    }}
                    placeholder={`Details for ${toolModal.name}...`}
                    autoFocus
                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none glass rounded-lg px-3 py-2"
                  />
                  <button
                    onClick={() => {
                      if (!toolInput.trim()) return;
                      setExecuting(true);
                      const modal = toolModal;
                      setToolModal(null);
                      toast.success(`Running ${modal.name}...`);
                      fetch(`/api/graph/nodes/${nodeId}/ask`, {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ message: `Use the ${modal.tool} tool for "${node.label}": ${toolInput}` }),
                      }).then(() => toast.success(`${modal.name} complete`))
                        .catch(() => toast.error("Failed"))
                        .finally(() => setExecuting(false));
                    }}
                    disabled={!toolInput.trim() || executing}
                    className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Send className="h-3 w-3" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* Recent executions for this node */}
            {executions.length > 0 && (
              <div className="border-t border-white/5 pt-2 mt-2">
                <p className="text-[10px] text-muted-foreground/40 mb-1.5">Recent Activity</p>
                {executions.map((ex: any) => (
                  <div key={ex.id} className="flex items-center gap-2 text-[10px] text-muted-foreground py-0.5">
                    <span className={ex.status === "success" ? "text-emerald-400" : "text-red-400"}>●</span>
                    <span className="truncate flex-1">{ex.action?.slice(0, 60)}</span>
                    <span className="text-muted-foreground/30">{ex.agent}</span>
                  </div>
                ))}
              </div>
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
