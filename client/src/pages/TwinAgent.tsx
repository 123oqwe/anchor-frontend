import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Eye, FileEdit, Shield, Crown, Trophy, Brain, TrendingUp,
  Target, Swords, Flame, Star, Bot, Plus, Minus, Loader2,
  CheckCircle2, Lock, ChevronDown, ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";

const TWIN_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-twin-V6HnhyxtWXhYsVfAuB9vqz.webp";

const LEVEL_ICONS = [Eye, FileEdit, Shield, Crown];
const LEVEL_COLORS = ["text-blue-400", "text-emerald-400", "text-amber-400", "text-purple-400"];
const LEVEL_BG = ["bg-blue-500/10", "bg-emerald-500/10", "bg-amber-500/10", "bg-purple-500/10"];

const TREND_COLORS: Record<string, string> = {
  stable: "text-emerald-400", evolving: "text-blue-400", worsening: "text-red-400",
};

export default function TwinAgent() {
  const [evolution, setEvolution] = useState<any>(null);
  const [insights, setInsights] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [agentStats, setAgentStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<number | null>(null);

  const load = async () => {
    try {
      const [evo, ins, projs, agents] = await Promise.all([
        api.getTwinEvolution(),
        api.getTwinInsights(),
        api.getProjects(),
        api.getAgentStatus(),
      ]);
      setEvolution(evo);
      setInsights(ins);
      setProjects(projs);
      setAgentStats(agents.find((a: any) => a.name === "Twin Agent"));
      // Set activeStage to actual level (0-indexed)
      if (evo?.level != null) setActiveStage(Math.max(0, evo.level - 1));
      else setActiveStage(0);
    } catch (err: any) {
      setLoadError(err.message ?? "Failed to load Twin data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCompleteQuest = async (questId: string) => {
    await api.completeQuest(questId);
    const evo = await api.getTwinEvolution();
    setEvolution(evo);
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  const currentXP = evolution?.currentXP ?? 0;
  const currentLevel = evolution?.currentLevel ?? 1;
  const stages = evolution?.stages ?? [];

  return (
    <div className="min-h-screen dot-grid">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-15"><img src={TWIN_IMG} alt="" className="w-full h-full object-cover object-top" /></div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />
        <div className="relative px-8 pt-8 pb-10">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <Brain className="h-4 w-4 text-primary" />
                  <span className="text-xs font-medium text-primary tracking-wider uppercase">Digital Twin</span>
                </div>
                <h1 className="text-3xl font-bold tracking-tight mb-3">Your Second Self</h1>
                <p className="text-base text-muted-foreground max-w-xl leading-relaxed">
                  The Twin learns how you think, decide, and act. Level up by using it — unlock new capabilities as trust grows.
                </p>
              </div>
              <div className="hidden lg:block glass rounded-xl p-4 shrink-0">
                <div className="flex items-center gap-2 mb-2">
                  <Trophy className="h-4 w-4 text-amber-400" />
                  <span className="text-sm font-bold text-foreground">Level {currentLevel}</span>
                  <span className="text-xs text-muted-foreground">/ 4</span>
                </div>
                <div className="text-2xl font-bold font-mono text-primary mb-1">{currentXP} XP</div>
                {agentStats && (
                  <div className="flex items-center gap-2 text-[10px]">
                    <Bot className="h-3 w-3 text-primary" />
                    <span className="text-muted-foreground">Twin Agent</span>
                    <Plus className="h-2 w-2 text-emerald-400" /><span className="text-emerald-400">{agentStats.successes}</span>
                    <Minus className="h-2 w-2 text-red-400" /><span className="text-red-400">{agentStats.failures}</span>
                    <span className="text-muted-foreground">exec</span>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      <div className="px-8 pb-8">
        <Tabs defaultValue="evolution" className="space-y-6">
          <TabsList className="glass border-0 p-1">
            <TabsTrigger value="evolution" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary flex items-center gap-1.5"><Swords className="h-3 w-3" />Evolution</TabsTrigger>
            <TabsTrigger value="insights" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary flex items-center gap-1.5"><TrendingUp className="h-3 w-3" />Insights</TabsTrigger>
            <TabsTrigger value="projects" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary flex items-center gap-1.5"><Target className="h-3 w-3" />Projects</TabsTrigger>
          </TabsList>

          {/* Evolution */}
          <TabsContent value="evolution" className="space-y-4">
            {stages.map((stage: any, i: number) => {
              const Icon = LEVEL_ICONS[i] ?? Star;
              const isActive = i + 1 === activeStage;
              const progressPct = stage.xpRequired > 0 ? Math.min((stage.xpCurrent / stage.xpRequired) * 100, 100) : 0;

              return (
                <motion.div key={stage.level} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}
                  className={`glass rounded-xl overflow-hidden transition-all cursor-pointer ${!stage.unlocked ? "opacity-60" : ""}`}
                  style={{ borderWidth: "1px", borderColor: isActive ? "rgba(255,255,255,0.1)" : "transparent" }}
                  onClick={() => setActiveStage(isActive ? 0 : i + 1)}>
                  <div className="p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl ${LEVEL_BG[i]} flex items-center justify-center`}>
                          {stage.unlocked ? <Icon className={`h-5 w-5 ${LEVEL_COLORS[i]}`} /> : <Lock className="h-5 w-5 text-muted-foreground" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground font-mono">LEVEL {stage.level}</span>
                            {stage.unlocked && <Badge className="text-[9px] bg-emerald-500/10 text-emerald-400">Unlocked</Badge>}
                          </div>
                          <h3 className="text-base font-bold text-foreground">{stage.name}</h3>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-xs font-mono text-muted-foreground">{stage.xpCurrent} / {stage.xpRequired} XP</div>
                          <div className="text-[10px] text-muted-foreground">{Math.round(progressPct)}%</div>
                        </div>
                        <motion.div animate={{ rotate: isActive ? 180 : 0 }} transition={{ duration: 0.2 }}>
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        </motion.div>
                      </div>
                    </div>

                    <div className="relative h-2 rounded-full bg-white/5 overflow-hidden">
                      <motion.div className={`absolute inset-y-0 left-0 rounded-full ${LEVEL_BG[i].replace("/10", "/60")}`}
                        initial={{ width: 0 }} animate={{ width: `${progressPct}%` }} transition={{ duration: 1, delay: 0.3 + i * 0.1 }} />
                    </div>
                  </div>

                  <AnimatePresence>
                    {isActive && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                        <div className="px-5 pb-5 border-t border-border/30 pt-4 space-y-4">
                          <p className="text-sm text-muted-foreground leading-relaxed">{stage.description}</p>

                          <div>
                            <h4 className="text-[10px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">Rewards</h4>
                            <div className="flex flex-wrap gap-2">
                              {stage.rewards.map((r: string) => <Badge key={r} className="text-[10px] bg-white/5 text-muted-foreground">{r}</Badge>)}
                            </div>
                          </div>

                          {stage.quests.length > 0 && (
                            <div>
                              <h4 className="text-[10px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">Active Quests</h4>
                              <div className="space-y-2">
                                {stage.quests.map((q: any) => (
                                  <div key={q.id} className={`flex items-center gap-3 p-3 rounded-lg ${q.completed ? "bg-emerald-500/5" : "bg-white/[0.03]"}`}>
                                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${q.completed ? "bg-emerald-500/20" : "bg-white/5"}`}>
                                      {q.completed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Target className="h-3.5 w-3.5 text-muted-foreground" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="text-xs font-medium text-foreground truncate">{q.name}</span>
                                        <span className="text-[10px] text-amber-400 font-mono shrink-0 ml-2">+{q.xp_reward} XP</span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                                          <div className="h-full bg-primary/50 rounded-full" style={{ width: `${Math.min((q.progress / q.total) * 100, 100)}%` }} />
                                        </div>
                                        <span className="text-[10px] text-muted-foreground font-mono">{q.progress}/{q.total}</span>
                                      </div>
                                    </div>
                                    {!q.completed && q.progress >= q.total && (
                                      <button onClick={() => handleCompleteQuest(q.id)} className="shrink-0 text-[10px] text-primary hover:text-primary/80 transition-colors">Claim</button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </TabsContent>

          {/* Insights */}
          <TabsContent value="insights" className="space-y-4">
            {insights.map((ins: any, i: number) => (
              <motion.div key={ins.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}
                className="glass rounded-xl p-5">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <Badge className="text-[10px] bg-primary/10 text-primary mb-2">{ins.category}</Badge>
                    <p className="text-sm text-foreground leading-relaxed">{ins.insight}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-muted-foreground">Confidence</span>
                      <span className="text-[10px] font-mono text-muted-foreground">{Math.round(ins.confidence * 100)}%</span>
                    </div>
                    <Progress value={ins.confidence * 100} className="h-1" />
                  </div>
                  <Badge className={`text-[10px] shrink-0 ${TREND_COLORS[ins.trend] ?? "text-muted-foreground"} bg-white/5`}>{ins.trend}</Badge>
                </div>
              </motion.div>
            ))}
          </TabsContent>

          {/* Projects */}
          <TabsContent value="projects" className="space-y-3">
            {projects.filter(p => p.tasks?.length > 0).map((p: any, i: number) => {
              const done = p.tasks?.filter((t: any) => t.status === "done").length ?? 0;
              const total = p.tasks?.length ?? 0;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <motion.div key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
                  className="glass rounded-xl p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${p.color}`} />
                    <span className="text-sm font-medium text-foreground flex-1">{p.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{done}/{total} tasks</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress value={pct} className="flex-1 h-1.5" />
                    <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">{pct}%</span>
                  </div>
                </motion.div>
              );
            })}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
