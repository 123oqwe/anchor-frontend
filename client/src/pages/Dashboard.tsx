import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Target, Activity, ArrowRight, Sparkles, AlertCircle,
  Send, ChevronRight, ArrowLeft, Briefcase, Users, Heart,
  GraduationCap, DollarSign, Clock, Plus, Minus, Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

const HERO_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-hero-DjRHG9Uoj6QKRBdMyZK5DP.webp";

const DOMAIN_ICONS: Record<string, any> = {
  work: Briefcase, relationships: Users, finance: DollarSign,
  growth: GraduationCap, health: Heart,
};

const typeColors: Record<string, string> = {
  goal: "bg-blue-500/20 text-blue-400", person: "bg-purple-500/20 text-purple-400",
  task: "bg-emerald-500/20 text-emerald-400", opportunity: "bg-amber-500/20 text-amber-400",
  pattern: "bg-rose-500/20 text-rose-400",
};

const statusColors: Record<string, string> = {
  active: "text-emerald-400", "in-progress": "text-blue-400", delayed: "text-red-400",
  decaying: "text-amber-400", overdue: "text-red-400", opportunity: "text-blue-400",
  stable: "text-emerald-400", worsening: "text-red-400", evolving: "text-blue-400",
  declining: "text-amber-400", inactive: "text-muted-foreground", todo: "text-muted-foreground",
  done: "text-emerald-400/50", blocked: "text-red-400",
};

function AgentStatus({ name, status, executions }: { name: string; status: string; executions: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <div className={`w-1.5 h-1.5 rounded-full ${status === "running" ? "bg-blue-400 animate-pulse" : status === "success" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-muted-foreground/30"}`} />
      <span className="text-muted-foreground">{name}</span>
      <div className="flex items-center gap-1 font-mono">
        <Plus className="h-2 w-2 text-emerald-400" /><span className="text-emerald-400">{executions}</span>
        <Minus className="h-2 w-2 text-red-400 ml-1" /><span className="text-red-400">0</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [quickInput, setQuickInput] = useState("");
  const [stateValues, setStateValues] = useState([72, 85, 34]);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [domains, setDomains] = useState<any[]>([]);
  const [totalNodes, setTotalNodes] = useState(0);
  const [todayDecision, setTodayDecision] = useState<any>(null);
  const [agentStatus, setAgentStatus] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const stateMetrics = [
    { label: "Energy", icon: Zap, color: "var(--energy-color)" },
    { label: "Focus", icon: Target, color: "var(--focus-color)" },
    { label: "Stress", icon: Activity, color: "var(--stress-color)" },
  ];

  useEffect(() => {
    Promise.all([
      api.getGraph(),
      api.getDecisionToday(),
      api.getState(),
      api.getAgentStatus(),
    ]).then(([graph, decision, state, agents]) => {
      setDomains(graph.domains);
      setTotalNodes(graph.totalNodes);
      setTodayDecision(decision);
      if (state) setStateValues([state.energy, state.focus, state.stress]);
      setAgentStatus(agents);
    }).finally(() => setLoading(false));
  }, []);

  const handleStateChange = (idx: number, val: number) => {
    const next = [...stateValues];
    next[idx] = val;
    setStateValues(next);
    api.updateState({ energy: next[0], focus: next[1], stress: next[2] }).catch(() => {});
  };

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    window.location.href = "/advisor";
  };

  const selectedDomain = domains.find(d => d.id === activeDomain);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="min-h-screen dot-grid">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-20"><img src={HERO_IMG} alt="" className="w-full h-full object-cover" /></div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
        <div className="relative px-8 pt-8 pb-10">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-xs font-medium text-primary tracking-wider uppercase">Decision Surface</span>
                  <span className="text-xs text-muted-foreground">— Today's Most Important Thing</span>
                </div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-3 max-w-2xl">
                  {todayDecision?.title ?? "Loading..."}
                </h1>
                <p className="text-base text-muted-foreground max-w-xl leading-relaxed mb-4">
                  {todayDecision?.reason}
                </p>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="text-xs border-primary/30 text-primary bg-primary/5">
                    <AlertCircle className="h-3 w-3 mr-1" />{todayDecision?.urgency === "high" ? "High Priority" : "On Track"}
                  </Badge>
                  <span className="text-xs text-muted-foreground font-mono">{todayDecision?.source}</span>
                </div>
              </div>

              <div className="hidden lg:block glass rounded-xl p-4 shrink-0 ml-8">
                <h4 className="text-[10px] font-semibold text-muted-foreground tracking-wider uppercase mb-3">Active Agents</h4>
                <div className="space-y-2">
                  {agentStatus.slice(0, 4).map(a => (
                    <AgentStatus key={a.name} name={a.name} status={a.successes > 0 ? "success" : "idle"} executions={a.successes} />
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      <div className="px-8 pb-8 space-y-6">
        {/* State Projection */}
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }}>
          <h2 className="text-xs font-semibold text-muted-foreground tracking-wider uppercase mb-4">State Projection</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {stateMetrics.map((metric, i) => {
              const Icon = metric.icon;
              return (
                <div key={metric.label} className="glass rounded-xl p-5 group hover:bg-white/[0.07] transition-colors">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4" style={{ color: metric.color }} />
                      <span className="text-sm font-medium text-foreground">{metric.label}</span>
                    </div>
                    <span className="text-2xl font-bold font-mono" style={{ color: metric.color }}>{stateValues[i]}</span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <motion.div className="absolute inset-y-0 left-0 rounded-full" style={{ backgroundColor: metric.color }}
                      initial={{ width: 0 }} animate={{ width: `${stateValues[i]}%` }} transition={{ duration: 1, delay: 0.2 + i * 0.1 }} />
                  </div>
                  <input type="range" min={0} max={100} value={stateValues[i]}
                    onChange={e => handleStateChange(i, parseInt(e.target.value))}
                    className="w-full mt-3 h-1 appearance-none bg-transparent cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md" />
                </div>
              );
            })}
          </div>
        </motion.section>

        {/* Quick Input */}
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.2 }}>
          <form onSubmit={handleQuickSubmit} className="relative">
            <div className="glass rounded-xl overflow-hidden flex items-center group focus-within:border-primary/30 transition-colors">
              <input type="text" value={quickInput} onChange={e => setQuickInput(e.target.value)}
                placeholder="What's on your mind? Quick command to resolve something..."
                className="flex-1 bg-transparent px-5 py-4 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
              <button type="submit" className="px-5 py-4 text-muted-foreground hover:text-primary transition-colors"><Send className="h-4 w-4" /></button>
            </div>
          </form>
        </motion.section>

        {/* Human Graph */}
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.3 }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-muted-foreground tracking-wider uppercase">Human Graph</h2>
            <span className="text-xs text-muted-foreground font-mono">{totalNodes} nodes across {domains.length} domains</span>
          </div>

          <AnimatePresence mode="wait">
            {!activeDomain ? (
              <motion.div key="overview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {domains.map((domain, i) => {
                  const Icon = DOMAIN_ICONS[domain.id] ?? Briefcase;
                  return (
                    <motion.div key={domain.id} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: i * 0.05 }}
                      onClick={() => setActiveDomain(domain.id)}
                      className="glass rounded-xl p-5 cursor-pointer hover:bg-white/[0.07] transition-all group relative overflow-hidden"
                      style={{ borderWidth: "1px", borderColor: "transparent" }} whileHover={{ borderColor: "rgba(255,255,255,0.1)" }}>
                      <div className={`absolute -top-10 -right-10 w-32 h-32 rounded-full ${domain.bgColor} opacity-30 blur-2xl group-hover:opacity-50 transition-opacity`} />
                      <div className="relative">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-lg ${domain.bgColor} flex items-center justify-center`}>
                              <Icon className={`h-5 w-5 ${domain.color}`} />
                            </div>
                            <div>
                              <h3 className="text-sm font-semibold text-foreground">{domain.name}</h3>
                              <span className="text-[10px] text-muted-foreground">{domain.nodeCount} nodes</span>
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-[10px] text-muted-foreground">Health</span>
                          <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                            <motion.div className="h-full rounded-full"
                              style={{ backgroundColor: domain.health > 70 ? "#34d399" : domain.health > 40 ? "#fbbf24" : "#f87171" }}
                              initial={{ width: 0 }} animate={{ width: `${domain.health}%` }} transition={{ duration: 1, delay: 0.3 + i * 0.1 }} />
                          </div>
                          <span className="text-[10px] font-mono text-muted-foreground">{domain.health}%</span>
                        </div>
                        <div className="space-y-1">
                          {domain.items.slice(0, 2).map((item: any) => (
                            <div key={item.id} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                              <div className={`w-1 h-1 rounded-full ${(statusColors[item.status] ?? "").replace("text-", "bg-") || "bg-muted-foreground"}`} />
                              <span className="truncate">{item.label}</span>
                              <span className={`${statusColors[item.status] || ""} ml-auto shrink-0`}>{item.status}</span>
                            </div>
                          ))}
                          {domain.items.length > 2 && <span className="text-[10px] text-muted-foreground/50">+{domain.items.length - 2} more</span>}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            ) : (
              <motion.div key="detail" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }}>
                <button onClick={() => { setActiveDomain(null); setExpandedItem(null); }} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4 transition-colors">
                  <ArrowLeft className="h-3 w-3" />Back to all domains
                </button>
                {selectedDomain && (
                  <div className="glass rounded-xl overflow-hidden">
                    <div className="p-5 border-b border-border/50">
                      <div className="flex items-center gap-3">
                        {(() => { const Icon = DOMAIN_ICONS[selectedDomain.id] ?? Briefcase; return (
                          <div className={`w-10 h-10 rounded-lg ${selectedDomain.bgColor} flex items-center justify-center`}>
                            <Icon className={`h-5 w-5 ${selectedDomain.color}`} />
                          </div>
                        ); })()}
                        <div>
                          <h3 className="text-lg font-bold text-foreground">{selectedDomain.name}</h3>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                            <span>{selectedDomain.nodeCount} nodes</span>
                            <span>Health: {selectedDomain.health}%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="p-3 space-y-1">
                      {selectedDomain.items.map((item: any, i: number) => (
                        <motion.div key={item.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, delay: i * 0.05 }}>
                          <div onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                            className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/[0.05] transition-colors cursor-pointer group">
                            <Badge className={`text-[9px] font-mono shrink-0 ${typeColors[item.type] || ""}`}>{item.type}</Badge>
                            <span className="text-sm font-medium text-foreground flex-1">{item.label}</span>
                            <span className={`text-[10px] font-mono ${statusColors[item.status] || "text-muted-foreground"}`}>{item.status}</span>
                            <motion.div animate={{ rotate: expandedItem === item.id ? 90 : 0 }} transition={{ duration: 0.15 }}>
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            </motion.div>
                          </div>
                          <AnimatePresence>
                            {expandedItem === item.id && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                                <div className="px-3 pb-3 ml-16">
                                  <p className="text-xs text-muted-foreground leading-relaxed mb-2">{item.detail}</p>
                                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
                                    <Clock className="h-3 w-3" /><span>Captured: {item.captured}</span>
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.section>

        {/* Activity Feed */}
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground tracking-wide">Recent Activity</span>
            </div>
            <ActivityFeed />
          </div>
        </motion.section>
      </div>
    </div>
  );
}

function ActivityFeed() {
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    api.getExecutions().then(rows => setEvents(rows.slice(0, 8))).catch(() => {});
    const interval = setInterval(() => {
      api.getExecutions().then(rows => setEvents(rows.slice(0, 8))).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  if (events.length === 0) return <p className="text-xs text-muted-foreground">No activity yet</p>;

  return (
    <div className="space-y-1.5">
      {events.map((e: any) => (
        <div key={e.id} className="flex items-center gap-3 py-1.5">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === "success" ? "bg-emerald-400" : "bg-red-400"}`} />
          <span className="text-[10px] text-muted-foreground font-mono w-16 shrink-0">
            {new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          <Badge className="text-[8px] bg-white/5 text-muted-foreground shrink-0">{e.agent}</Badge>
          <span className="text-[11px] text-foreground/70 truncate flex-1">{e.action}</span>
        </div>
      ))}
    </div>
  );
}
