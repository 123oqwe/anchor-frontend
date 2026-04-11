import { useState } from "react";
import { motion } from "framer-motion";
import {
  Lock,
  Unlock,
  Shield,
  Eye,
  FileEdit,
  Zap,
  Brain,
  TrendingUp,
  AlertTriangle,
  ChevronRight,
  CheckCircle2,
  Info,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TWIN_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-twin-V6HnhyxtWXhYsVfAuB9vqz.webp";

const permissionLevels = [
  {
    level: "L0",
    name: "Observe",
    description: "Read-only analysis of your behavior patterns, decisions, and state changes. The Twin watches but never acts.",
    icon: Eye,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/20",
    capabilities: [
      "Behavioral pattern recognition",
      "Decision style analysis",
      "Risk preference mapping",
      "Energy/focus cycle detection",
    ],
    unlocked: true,
  },
  {
    level: "L1",
    name: "Suggest",
    description: "Generate drafts, recommendations, and insights based on learned patterns. All outputs require your review.",
    icon: FileEdit,
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/20",
    capabilities: [
      "Priority suggestions based on your patterns",
      "Draft generation for emails & plans",
      "Avoidance behavior alerts",
      "Relationship decay warnings",
    ],
    unlocked: true,
  },
  {
    level: "L2",
    name: "Execute with Confirmation",
    description: "Take actions on your behalf, but only after explicit approval. Every action goes through the Draft → Approval pipeline.",
    icon: Shield,
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/20",
    capabilities: [
      "Send approved emails",
      "Schedule calendar events",
      "Create and assign tasks",
      "Execute approved workflows",
    ],
    unlocked: false,
  },
  {
    level: "L3",
    name: "Limited Autonomy",
    description: "Act independently within strict boundaries. Reserved for low-risk, high-frequency actions you've explicitly pre-approved.",
    icon: Zap,
    color: "text-purple-400",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/20",
    capabilities: [
      "Auto-respond to routine messages",
      "Auto-schedule recurring tasks",
      "Auto-update task status",
      "Auto-archive completed items",
    ],
    unlocked: false,
  },
];

const twinInsights = [
  {
    category: "Decision Style",
    insight: "You tend to delay high-stakes decisions by 2-3 days on average. When you do decide, 78% of outcomes are positive.",
    confidence: 0.82,
    trend: "stable",
  },
  {
    category: "Risk Preference",
    insight: "Moderate risk tolerance for business decisions, conservative for personal. You avoid confrontation-related tasks.",
    confidence: 0.75,
    trend: "evolving",
  },
  {
    category: "Behavioral Pattern",
    insight: "Peak productivity between 10am-1pm. Energy drops significantly after 3pm. You procrastinate most on writing tasks.",
    confidence: 0.91,
    trend: "stable",
  },
  {
    category: "Avoidance Detection",
    insight: "Currently avoiding: investor follow-up emails (3 days), team performance review (1 week), personal budget review.",
    confidence: 0.88,
    trend: "worsening",
  },
];

export default function TwinAgent() {
  const [activeLevel, setActiveLevel] = useState<string>("L0");
  const [levelStates, setLevelStates] = useState<Record<string, boolean>>({
    L0: true,
    L1: true,
    L2: false,
    L3: false,
  });

  const toggleLevel = (level: string) => {
    setLevelStates((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  return (
    <div className="min-h-screen dot-grid">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-15">
          <img src={TWIN_IMG} alt="" className="w-full h-full object-cover object-top" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />
        <div className="relative px-8 pt-8 pb-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Brain className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary tracking-wider uppercase">Digital Twin</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-3">Your Second Self</h1>
            <p className="text-base text-muted-foreground max-w-xl leading-relaxed">
              The Twin learns how you think, decide, and act. Over time, it becomes a persistent model of you — 
              not to replace you, but to help you see yourself clearly and act with precision.
            </p>
          </motion.div>
        </div>
      </div>

      <div className="px-8 pb-8">
        <Tabs defaultValue="permissions" className="space-y-6">
          <TabsList className="glass border-0 p-1">
            <TabsTrigger value="permissions" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              Permission Levels
            </TabsTrigger>
            <TabsTrigger value="insights" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              Twin Insights
            </TabsTrigger>
            <TabsTrigger value="evolution" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
              Evolution Log
            </TabsTrigger>
          </TabsList>

          <TabsContent value="permissions" className="space-y-4">
            {permissionLevels.map((level, i) => {
              const Icon = level.icon;
              const isActive = levelStates[level.level];
              return (
                <motion.div
                  key={level.level}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className={`glass rounded-xl overflow-hidden transition-all ${
                    isActive ? level.borderColor : "border-border/50"
                  }`}
                  style={{ borderWidth: "1px" }}
                >
                  <div className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4">
                        <div className={`w-10 h-10 rounded-lg ${level.bgColor} flex items-center justify-center shrink-0`}>
                          <Icon className={`h-5 w-5 ${level.color}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <Badge className={`text-[10px] font-mono ${level.bgColor} ${level.color}`}>
                              {level.level}
                            </Badge>
                            <h3 className="text-sm font-semibold text-foreground">{level.name}</h3>
                            {!level.unlocked && (
                              <Lock className="h-3 w-3 text-muted-foreground" />
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed max-w-lg">
                            {level.description}
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={isActive}
                        onCheckedChange={() => toggleLevel(level.level)}
                        disabled={!level.unlocked}
                      />
                    </div>

                    {isActive && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        className="mt-4 pl-14"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {level.capabilities.map((cap) => (
                            <div key={cap} className="flex items-center gap-2 text-xs text-muted-foreground">
                              <CheckCircle2 className={`h-3 w-3 shrink-0 ${level.color}`} />
                              <span>{cap}</span>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              );
            })}

            <div className="glass rounded-lg p-4 flex items-start gap-3">
              <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div className="text-xs text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Trust is the product.</strong> Unlike other AI agents, Anchor never acts freely. 
                Every action flows through Draft → Preview → Approval → Execution. You control the boundaries.
              </div>
            </div>
          </TabsContent>

          <TabsContent value="insights" className="space-y-4">
            {twinInsights.map((insight, i) => (
              <motion.div
                key={insight.category}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.1 }}
                className="glass rounded-xl p-5"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{insight.category}</h3>
                    <Badge className={`text-[10px] ${
                      insight.trend === "stable" ? "bg-emerald-500/10 text-emerald-400" :
                      insight.trend === "evolving" ? "bg-blue-500/10 text-blue-400" :
                      "bg-red-500/10 text-red-400"
                    }`}>
                      {insight.trend === "worsening" && <AlertTriangle className="h-3 w-3 mr-1" />}
                      {insight.trend === "stable" && <TrendingUp className="h-3 w-3 mr-1" />}
                      {insight.trend}
                    </Badge>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">
                    {Math.round(insight.confidence * 100)}% confidence
                  </span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{insight.insight}</p>
                <div className="mt-3 h-1 rounded-full bg-white/5 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-primary/50"
                    initial={{ width: 0 }}
                    animate={{ width: `${insight.confidence * 100}%` }}
                    transition={{ duration: 1, delay: 0.3 + i * 0.1 }}
                  />
                </div>
              </motion.div>
            ))}
          </TabsContent>

          <TabsContent value="evolution" className="space-y-4">
            <div className="glass rounded-xl p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Evolution Timeline</h3>
              <div className="space-y-4">
                {[
                  { date: "Today", event: "Updated risk preference model — detected shift toward more aggressive business decisions", type: "update" },
                  { date: "2 days ago", event: "New behavioral pattern detected: procrastination on writing tasks correlates with low energy after 3pm", type: "discovery" },
                  { date: "5 days ago", event: "Avoidance detection triggered for investor follow-up emails — pattern matches previous delay behavior", type: "alert" },
                  { date: "1 week ago", event: "Decision style confidence increased from 0.75 to 0.82 after 12 new decision data points", type: "improvement" },
                  { date: "2 weeks ago", event: "Initial Twin calibration complete — baseline personality model established from 47 interactions", type: "milestone" },
                ].map((entry, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, delay: i * 0.05 }}
                    className="flex gap-4"
                  >
                    <div className="flex flex-col items-center">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        entry.type === "alert" ? "bg-amber-400" :
                        entry.type === "milestone" ? "bg-primary" :
                        entry.type === "discovery" ? "bg-emerald-400" :
                        "bg-muted-foreground/50"
                      }`} />
                      {i < 4 && <div className="w-px flex-1 bg-border/50 mt-1" />}
                    </div>
                    <div className="pb-4">
                      <span className="text-[10px] font-mono text-muted-foreground">{entry.date}</span>
                      <p className="text-sm text-foreground/80 mt-0.5">{entry.event}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
