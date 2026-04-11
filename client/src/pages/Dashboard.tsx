import { useState } from "react";
import { motion } from "framer-motion";
import {
  Zap,
  Target,
  Activity,
  ArrowRight,
  Sparkles,
  Clock,
  UserCircle,
  TrendingUp,
  AlertCircle,
  Send,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const HERO_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-hero-DjRHG9Uoj6QKRBdMyZK5DP.webp";
const GRAPH_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-graph-GLJi9PDwSefYME3bkfdUzh.webp";

// Mock data representing Human Graph state
const stateMetrics = [
  { label: "Energy", value: 72, icon: Zap, color: "var(--energy-color)", gradient: "from-emerald-500/20 to-emerald-500/5" },
  { label: "Focus", value: 85, icon: Target, color: "var(--focus-color)", gradient: "from-blue-500/20 to-blue-500/5" },
  { label: "Stress", value: 34, icon: Activity, color: "var(--stress-color)", gradient: "from-amber-500/20 to-amber-500/5" },
];

const graphNodes = [
  { id: 1, label: "YC Application", type: "goal", status: "active", captured: "Command input, 3 days ago" },
  { id: 2, label: "Matt Zhang", type: "relationship", status: "decaying", captured: "Calendar sync, last meeting 5 days ago" },
  { id: 3, label: "CTO Candidate", type: "relationship", status: "opportunity", captured: "Email thread analysis" },
  { id: 4, label: "Product Roadmap", type: "commitment", status: "active", captured: "Workspace project creation" },
  { id: 5, label: "Investor Follow-up", type: "action", status: "overdue", captured: "Draft center, auto-detected from email" },
  { id: 6, label: "Technical Architecture", type: "goal", status: "active", captured: "Advisor conversation, 2 days ago" },
];

const todayDecision = {
  title: "Finish YC application draft",
  reason: "You've delayed this 3 times. Completing it today unlocks 2 downstream tasks and aligns with your Q2 commitment.",
  urgency: "high",
  source: "Decision Agent — priority inference + avoidance detection",
};

const opportunities = [
  { name: "Matt Zhang", detail: "3 days silent — should follow up", urgency: "medium" },
  { name: "Series A Prep", detail: "Window closing in 2 weeks", urgency: "high" },
  { name: "Team Standup", detail: "Missed last 2 — team morale risk", urgency: "low" },
];

const nodeTypeColors: Record<string, string> = {
  goal: "bg-blue-500/20 text-blue-400",
  relationship: "bg-purple-500/20 text-purple-400",
  commitment: "bg-emerald-500/20 text-emerald-400",
  action: "bg-amber-500/20 text-amber-400",
};

const statusColors: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  decaying: "bg-amber-500/20 text-amber-400",
  opportunity: "bg-blue-500/20 text-blue-400",
  overdue: "bg-red-500/20 text-red-400",
};

export default function Dashboard() {
  const [quickInput, setQuickInput] = useState("");
  const [stateValues, setStateValues] = useState(stateMetrics.map((m) => m.value));

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    setQuickInput("");
  };

  return (
    <div className="min-h-screen dot-grid">
      {/* Hero: Today's Decision */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-20">
          <img src={HERO_IMG} alt="" className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
        <div className="relative px-8 pt-8 pb-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary tracking-wider uppercase">Decision Surface</span>
              <span className="text-xs text-muted-foreground">— Today's Most Important Thing</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-3 max-w-2xl">
              {todayDecision.title}
            </h1>
            <p className="text-base text-muted-foreground max-w-xl leading-relaxed mb-4">
              {todayDecision.reason}
            </p>
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="text-xs border-primary/30 text-primary bg-primary/5">
                <AlertCircle className="h-3 w-3 mr-1" />
                High Priority
              </Badge>
              <span className="text-xs text-muted-foreground font-mono">{todayDecision.source}</span>
            </div>
          </motion.div>
        </div>
      </div>

      <div className="px-8 pb-8 space-y-6">
        {/* State Projection */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
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
                    <span className="text-2xl font-bold font-mono" style={{ color: metric.color }}>
                      {stateValues[i]}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <motion.div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{ backgroundColor: metric.color }}
                      initial={{ width: 0 }}
                      animate={{ width: `${stateValues[i]}%` }}
                      transition={{ duration: 1, delay: 0.2 + i * 0.1, ease: [0.25, 0.1, 0.25, 1] }}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={stateValues[i]}
                    onChange={(e) => {
                      const newValues = [...stateValues];
                      newValues[i] = parseInt(e.target.value);
                      setStateValues(newValues);
                    }}
                    className="w-full mt-3 h-1 appearance-none bg-transparent cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
                  />
                </div>
              );
            })}
          </div>
        </motion.section>

        {/* Quick Input */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <form onSubmit={handleQuickSubmit} className="relative">
            <div className="glass rounded-xl overflow-hidden flex items-center group focus-within:border-primary/30 transition-colors">
              <input
                type="text"
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                placeholder="What's on your mind? Quick command to resolve something..."
                className="flex-1 bg-transparent px-5 py-4 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <button
                type="submit"
                className="px-5 py-4 text-muted-foreground hover:text-primary transition-colors"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </motion.section>

        {/* Two-column layout: Human Graph + Opportunities */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Human Graph */}
          <motion.section
            className="lg:col-span-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-muted-foreground tracking-wider uppercase">Human Graph</h2>
              <span className="text-xs text-muted-foreground font-mono">{graphNodes.length} nodes active</span>
            </div>

            {/* Graph visualization hint */}
            <div className="glass rounded-xl overflow-hidden mb-4">
              <div className="relative h-40 overflow-hidden">
                <img src={GRAPH_IMG} alt="Human Graph Visualization" className="w-full h-full object-cover opacity-40" />
                <div className="absolute inset-0 bg-gradient-to-t from-card to-transparent" />
                <div className="absolute bottom-4 left-4">
                  <span className="text-xs text-muted-foreground">Interactive graph visualization</span>
                </div>
              </div>
            </div>

            {/* Graph nodes list */}
            <div className="space-y-2">
              {graphNodes.map((node, i) => (
                <motion.div
                  key={node.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: 0.4 + i * 0.05 }}
                  className="glass rounded-lg p-4 hover:bg-white/[0.07] transition-all group cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge className={`text-[10px] font-mono ${nodeTypeColors[node.type] || ""}`}>
                        {node.type}
                      </Badge>
                      <span className="text-sm font-medium text-foreground">{node.label}</span>
                      <Badge className={`text-[10px] ${statusColors[node.status] || ""}`}>
                        {node.status}
                      </Badge>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>Captured: {node.captured}</span>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* Opportunities & People */}
          <motion.section
            className="lg:col-span-2"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <h2 className="text-xs font-semibold text-muted-foreground tracking-wider uppercase mb-4">People & Opportunities</h2>
            <div className="space-y-3">
              {opportunities.map((opp, i) => (
                <motion.div
                  key={opp.name}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: 0.5 + i * 0.1 }}
                  className="glass rounded-lg p-4 hover:bg-white/[0.07] transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <UserCircle className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">{opp.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground pl-8">{opp.detail}</p>
                  <div className="mt-2 pl-8">
                    <Badge variant="outline" className={`text-[10px] ${
                      opp.urgency === "high" ? "border-red-500/30 text-red-400" :
                      opp.urgency === "medium" ? "border-amber-500/30 text-amber-400" :
                      "border-muted-foreground/30 text-muted-foreground"
                    }`}>
                      {opp.urgency} urgency
                    </Badge>
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Suggested Actions */}
            <div className="mt-6">
              <h2 className="text-xs font-semibold text-muted-foreground tracking-wider uppercase mb-4">Suggested Actions</h2>
              <div className="space-y-2">
                {[
                  { text: "Send follow-up to Matt Zhang", icon: ArrowRight },
                  { text: "Review CTO candidate profile", icon: TrendingUp },
                  { text: "Block 2h for YC draft", icon: Target },
                ].map((action, i) => (
                  <motion.button
                    key={action.text}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.7 + i * 0.1 }}
                    className="w-full flex items-center gap-3 glass rounded-lg px-4 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.07] transition-all text-left group"
                  >
                    <action.icon className="h-4 w-4 text-primary shrink-0" />
                    <span className="flex-1">{action.text}</span>
                    <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </motion.button>
                ))}
              </div>
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}
