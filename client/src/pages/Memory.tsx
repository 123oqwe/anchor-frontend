import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Brain, Calendar, Lightbulb, Trash2, Edit3, Bot,
  Plus, Minus, ChevronDown, ChevronRight, Loader2, X, Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";

const MEMORY_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-memory-mWdwj77x7BXx462iE6yR5q.webp";

type MemoryType = "episodic" | "semantic" | "working";

interface MemoryItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  source: string;
  confidence: number;
}

const typeConfig: Record<MemoryType, { label: string; icon: any; color: string; bgColor: string; description: string }> = {
  working:  { label: "Working Memory",  icon: Lightbulb, color: "text-amber-400",  bgColor: "bg-amber-500/10",  description: "Current active context — tasks, focus areas, and immediate priorities" },
  episodic: { label: "Episodic Memory", icon: Calendar,  color: "text-blue-400",   bgColor: "bg-blue-500/10",   description: "Specific events, meetings, conversations, and experiences" },
  semantic: { label: "Semantic Memory", icon: Brain,     color: "text-purple-400", bgColor: "bg-purple-500/10", description: "Long-term patterns, preferences, and learned knowledge about you" },
};

function timeAgo(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function Memory() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({ episodic: 0, semantic: 0, working: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<MemoryType | "all">("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [agentStats, setAgentStats] = useState<any>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newMem, setNewMem] = useState({ type: "episodic" as MemoryType, title: "", content: "", tags: "" });
  const [editId, setEditId] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [mems, s, agents] = await Promise.all([
        api.getMemories({ type: activeFilter !== "all" ? activeFilter : undefined, q: searchQuery || undefined }),
        api.getMemoryStats(),
        api.getAgentStatus(),
      ]);
      setMemories(mems);
      setStats(s);
      setAgentStats(agents.find((a: any) => a.name === "Memory Agent"));
    } catch (err: any) {
      setLoadError(err.message ?? "Failed to load memories");
    } finally {
      setLoading(false);
    }
  };

  // Debounced search — waits 400ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => { load(); }, searchQuery ? 400 : 0);
    return () => clearTimeout(timer);
  }, [activeFilter, searchQuery]);

  const toggleExpand = (id: string) => setExpandedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const handleDelete = async (id: string) => {
    await api.deleteMemory(id);
    setMemories(prev => prev.filter(m => m.id !== id));
  };

  const handleAdd = async () => {
    if (!newMem.title || !newMem.content) return;
    const tags = newMem.tags.split(",").map(t => t.trim()).filter(Boolean);
    await api.createMemory({ ...newMem, tags });
    setShowAdd(false);
    setNewMem({ type: "episodic", title: "", content: "", tags: "" });
    load();
  };

  return (
    <div className="min-h-screen dot-grid">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-15"><img src={MEMORY_IMG} alt="" className="w-full h-full object-cover" /></div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />
        <div className="relative px-8 pt-8 pb-8">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-center gap-2 mb-4">
              <Brain className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary tracking-wider uppercase">Memory System</span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight mb-3">Your Knowledge Graph</h1>
                <p className="text-base text-muted-foreground max-w-xl leading-relaxed">Three layers of memory that evolve with you.</p>
              </div>
              {agentStats && (
                <div className="hidden lg:block glass rounded-xl p-3 shrink-0">
                  <div className="flex items-center gap-2 text-[10px]">
                    <Bot className="h-3 w-3 text-primary" />
                    <span className="text-muted-foreground">Memory Agent</span>
                    <Plus className="h-2 w-2 text-emerald-400" /><span className="text-emerald-400">{agentStats.successes}</span>
                    <Minus className="h-2 w-2 text-red-400" /><span className="text-red-400">{agentStats.failures}</span>
                    <span className="text-muted-foreground">exec</span>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      </div>

      <div className="px-8 pb-8 space-y-6">
        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 glass rounded-xl flex items-center gap-3 px-4 focus-within:border-primary/30 transition-colors">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search memories, tags, or content..."
              className="flex-1 bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
            {searchQuery && <button onClick={() => setSearchQuery("")}><X className="h-4 w-4 text-muted-foreground hover:text-foreground" /></button>}
          </div>
          <div className="flex gap-2">
            {(["all", "working", "episodic", "semantic"] as const).map(filter => (
              <button key={filter} onClick={() => setActiveFilter(filter)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeFilter === filter ? "bg-primary/10 text-primary" : "glass text-muted-foreground hover:text-foreground"}`}>
                {filter === "all" ? `All (${Object.values(stats).reduce((a, b) => a + b, 0)})` : `${typeConfig[filter].label.split(" ")[0]} (${stats[filter] ?? 0})`}
              </button>
            ))}
            <button onClick={() => setShowAdd(true)} className="glass rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <Plus className="h-3 w-3" />Add
            </button>
          </div>
        </div>

        {/* Type overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(Object.entries(typeConfig) as [MemoryType, any][]).map(([type, cfg]) => {
            const Icon = cfg.icon;
            return (
              <motion.div key={type} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
                onClick={() => setActiveFilter(activeFilter === type ? "all" : type)}
                className={`glass rounded-xl p-4 cursor-pointer hover:bg-white/[0.07] transition-all ${activeFilter === type ? "border-primary/30" : ""}`}>
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-8 h-8 rounded-lg ${cfg.bgColor} flex items-center justify-center`}>
                    <Icon className={`h-4 w-4 ${cfg.color}`} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">{cfg.label}</h3>
                    <span className="text-[10px] text-muted-foreground">{stats[type] ?? 0} items</span>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">{cfg.description}</p>
              </motion.div>
            );
          })}
        </div>

        {/* Memory list */}
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence>
              {memories.map((m, i) => {
                const cfg = typeConfig[m.type];
                const Icon = cfg.icon;
                const isExp = expandedIds.has(m.id);
                return (
                  <motion.div key={m.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ delay: i * 0.03 }}
                    className="glass rounded-xl overflow-hidden">
                    <div onClick={() => toggleExpand(m.id)} className="flex items-center gap-4 p-4 cursor-pointer hover:bg-white/[0.04] transition-colors group">
                      <div className={`shrink-0 w-8 h-8 rounded-lg ${cfg.bgColor} flex items-center justify-center`}>
                        <Icon className={`h-4 w-4 ${cfg.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <h3 className="text-sm font-medium text-foreground truncate">{m.title}</h3>
                          <Badge className={`text-[9px] shrink-0 ${cfg.bgColor} ${cfg.color}`}>{m.type}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{m.content}</p>
                      </div>
                      <div className="shrink-0 flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span className="font-mono">{Math.round(m.confidence * 100)}%</span>
                        <span>{timeAgo(m.created_at)}</span>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={e => { e.stopPropagation(); handleDelete(m.id); }} className="hover:text-red-400 transition-colors"><Trash2 className="h-3 w-3" /></button>
                        </div>
                        <motion.div animate={{ rotate: isExp ? 180 : 0 }} transition={{ duration: 0.2 }}>
                          <ChevronDown className="h-3.5 w-3.5" />
                        </motion.div>
                      </div>
                    </div>

                    <AnimatePresence>
                      {isExp && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                          <div className="px-4 pb-4 border-t border-border/30 pt-3">
                            <p className="text-sm text-foreground/80 leading-relaxed mb-3">{m.content}</p>
                            <div className="flex items-center justify-between">
                              <div className="flex flex-wrap gap-1.5">
                                {m.tags.map(tag => <Badge key={tag} className="text-[9px] bg-white/5 text-muted-foreground">#{tag}</Badge>)}
                              </div>
                              <span className="text-[10px] text-muted-foreground/60">{m.source}</span>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {memories.length === 0 && <div className="text-center py-12 text-muted-foreground text-sm">No memories found</div>}
          </div>
        )}
      </div>

      {/* Add Memory Modal */}
      <AnimatePresence>
        {showAdd && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowAdd(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="glass-strong rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold mb-4">Add Memory</h3>
              <div className="space-y-3">
                <select value={newMem.type} onChange={e => setNewMem(p => ({ ...p, type: e.target.value as MemoryType }))}
                  className="w-full bg-white/5 rounded-lg px-3 py-2 text-sm text-foreground border border-border/50 focus:outline-none">
                  <option value="working">Working Memory</option>
                  <option value="episodic">Episodic Memory</option>
                  <option value="semantic">Semantic Memory</option>
                </select>
                <input type="text" placeholder="Title" value={newMem.title} onChange={e => setNewMem(p => ({ ...p, title: e.target.value }))}
                  className="w-full bg-white/5 rounded-lg px-3 py-2 text-sm text-foreground border border-border/50 focus:outline-none placeholder:text-muted-foreground/60" />
                <textarea placeholder="Content" value={newMem.content} onChange={e => setNewMem(p => ({ ...p, content: e.target.value }))} rows={3}
                  className="w-full bg-white/5 rounded-lg px-3 py-2 text-sm text-foreground border border-border/50 focus:outline-none placeholder:text-muted-foreground/60 resize-none" />
                <input type="text" placeholder="Tags (comma separated)" value={newMem.tags} onChange={e => setNewMem(p => ({ ...p, tags: e.target.value }))}
                  className="w-full bg-white/5 rounded-lg px-3 py-2 text-sm text-foreground border border-border/50 focus:outline-none placeholder:text-muted-foreground/60" />
              </div>
              <div className="flex gap-2 mt-4">
                <button onClick={() => setShowAdd(false)} className="flex-1 glass rounded-lg py-2 text-sm text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                <button onClick={handleAdd} className="flex-1 bg-primary/20 text-primary rounded-lg py-2 text-sm hover:bg-primary/30 transition-colors">Save</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
