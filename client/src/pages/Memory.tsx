import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Brain,
  Clock,
  Tag,
  ChevronRight,
  ChevronDown,
  Plus,
  Filter,
  Calendar,
  MessageCircle,
  FileText,
  Lightbulb,
  Users,
  Trash2,
  Edit3,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MEMORY_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663309741543/XAV3v9QesjBrkPBXbAU6Pq/anchor-memory-mWdwj77x7BXx462iE6yR5q.webp";

type MemoryType = "episodic" | "semantic" | "working";

interface MemoryItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  timestamp: string;
  source: string;
  confidence: number;
  expanded?: boolean;
}

const memoryData: MemoryItem[] = [
  {
    id: "1",
    type: "working",
    title: "YC Application — Current Focus",
    content: "Active task: Refine 'Why Now' section. Key angle: behavioral insight + market timing. Co-founder feedback pending. Deadline: This Friday.",
    tags: ["YC", "application", "active"],
    timestamp: "Active now",
    source: "Workspace project",
    confidence: 0.95,
  },
  {
    id: "2",
    type: "episodic",
    title: "Meeting with Matt Zhang — Product Strategy",
    content: "Discussed go-to-market strategy for Anchor. Matt suggested focusing on founder persona first. Agreed to follow up with detailed user journey. Matt mentioned potential intro to a16z partner.",
    tags: ["Matt Zhang", "strategy", "meeting"],
    timestamp: "5 days ago",
    source: "Calendar + conversation analysis",
    confidence: 0.88,
  },
  {
    id: "3",
    type: "episodic",
    title: "Investor Call — Pre-Seed Discussion",
    content: "30-min call with Sarah Chen from Sequoia Scout. She was interested in the Human Graph concept. Asked about defensibility and data moat. Follow-up requested with technical architecture doc.",
    tags: ["investor", "Sequoia", "fundraising"],
    timestamp: "1 week ago",
    source: "Call transcript analysis",
    confidence: 0.82,
  },
  {
    id: "4",
    type: "semantic",
    title: "Decision Pattern: Avoidance Behavior",
    content: "Long-term pattern: You tend to delay confrontation-related tasks (performance reviews, difficult emails, pricing negotiations) by an average of 4.2 days. This pattern has been consistent across 23 observed instances.",
    tags: ["pattern", "avoidance", "behavioral"],
    timestamp: "Learned over 3 months",
    source: "Twin Agent behavioral analysis",
    confidence: 0.91,
  },
  {
    id: "5",
    type: "semantic",
    title: "Preference: Communication Style",
    content: "You prefer concise, direct communication. Average email length: 47 words. You respond faster to messages that include specific asks. You dislike open-ended meeting invites without agendas.",
    tags: ["preference", "communication", "style"],
    timestamp: "Learned over 2 months",
    source: "Email + message pattern analysis",
    confidence: 0.86,
  },
  {
    id: "6",
    type: "working",
    title: "CTO Search — Active Pipeline",
    content: "3 candidates in pipeline. Top candidate: Alex Rivera (ex-Stripe). Scheduled intro call for Thursday. Key criteria: systems thinking, startup experience, AI/ML background.",
    tags: ["hiring", "CTO", "active"],
    timestamp: "Updated 2 hours ago",
    source: "Advisor conversation + email",
    confidence: 0.90,
  },
  {
    id: "7",
    type: "episodic",
    title: "Product Insight — User Testing Session",
    content: "Tested Anchor prototype with 3 founders. Key feedback: 'The mirror concept is powerful but needs clearer onboarding.' All 3 wanted the avoidance detection feature. One suggested gamification (rejected — doesn't align with philosophy).",
    tags: ["user-testing", "product", "feedback"],
    timestamp: "2 weeks ago",
    source: "Session notes + recording analysis",
    confidence: 0.85,
  },
];

const typeConfig: Record<MemoryType, { label: string; icon: typeof Brain; color: string; bgColor: string; description: string }> = {
  working: {
    label: "Working Memory",
    icon: Lightbulb,
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    description: "Current active context — tasks, focus areas, and immediate priorities",
  },
  episodic: {
    label: "Episodic Memory",
    icon: Calendar,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    description: "Specific events, meetings, conversations, and experiences",
  },
  semantic: {
    label: "Semantic Memory",
    icon: Brain,
    color: "text-purple-400",
    bgColor: "bg-purple-500/10",
    description: "Long-term patterns, preferences, and learned knowledge about you",
  },
};

export default function Memory() {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(["1"]));
  const [activeFilter, setActiveFilter] = useState<MemoryType | "all">("all");

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = memoryData.filter((m) => {
    if (activeFilter !== "all" && m.type !== activeFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <div className="min-h-screen dot-grid">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-15">
          <img src={MEMORY_IMG} alt="" className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />
        <div className="relative px-8 pt-8 pb-8">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <div className="flex items-center gap-2 mb-4">
              <Brain className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary tracking-wider uppercase">Memory System</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-3">Your Knowledge Graph</h1>
            <p className="text-base text-muted-foreground max-w-xl leading-relaxed">
              Three layers of memory that evolve with you: working context for the now, episodic records of what happened, and semantic understanding of who you are.
            </p>
          </motion.div>
        </div>
      </div>

      <div className="px-8 pb-8 space-y-6">
        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 glass rounded-xl flex items-center gap-3 px-4 focus-within:border-primary/30 transition-colors">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search memories, tags, or content..."
              className="flex-1 bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div className="flex gap-2">
            {(["all", "working", "episodic", "semantic"] as const).map((filter) => (
              <button
                key={filter}
                onClick={() => setActiveFilter(filter)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  activeFilter === filter
                    ? "bg-primary/10 text-primary"
                    : "glass text-muted-foreground hover:text-foreground"
                }`}
              >
                {filter === "all" ? "All" : typeConfig[filter].label.split(" ")[0]}
              </button>
            ))}
          </div>
        </div>

        {/* Memory type overview cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(Object.entries(typeConfig) as [MemoryType, typeof typeConfig[MemoryType]][]).map(([type, config]) => {
            const Icon = config.icon;
            const count = memoryData.filter((m) => m.type === type).length;
            return (
              <motion.div
                key={type}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className="glass rounded-xl p-4 cursor-pointer hover:bg-white/[0.07] transition-colors"
                onClick={() => setActiveFilter(type)}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-8 h-8 rounded-lg ${config.bgColor} flex items-center justify-center`}>
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{config.label}</h3>
                    <span className="text-xs text-muted-foreground">{count} items</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{config.description}</p>
              </motion.div>
            );
          })}
        </div>

        {/* Memory items */}
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground font-mono">{filtered.length} memories</span>
            <button className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors">
              <Plus className="h-3 w-3" />
              Add Memory
            </button>
          </div>

          <AnimatePresence>
            {filtered.map((item, i) => {
              const config = typeConfig[item.type];
              const Icon = config.icon;
              const isExpanded = expandedIds.has(item.id);

              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, delay: i * 0.03 }}
                  className="glass rounded-xl overflow-hidden"
                >
                  <button
                    onClick={() => toggleExpand(item.id)}
                    className="w-full p-4 flex items-start gap-3 text-left hover:bg-white/[0.03] transition-colors"
                  >
                    <div className={`w-7 h-7 rounded-lg ${config.bgColor} flex items-center justify-center shrink-0 mt-0.5`}>
                      <Icon className={`h-3.5 w-3.5 ${config.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-foreground truncate">{item.title}</h3>
                        <Badge className={`text-[10px] shrink-0 ${config.bgColor} ${config.color}`}>
                          {config.label.split(" ")[0]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {item.timestamp}
                        </span>
                        <span>{item.source}</span>
                        <span className="font-mono">{Math.round(item.confidence * 100)}% conf.</span>
                      </div>
                    </div>
                    <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </motion.div>
                  </button>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 pl-14">
                          <p className="text-sm text-muted-foreground leading-relaxed mb-3">{item.content}</p>
                          <div className="flex items-center gap-2 flex-wrap mb-3">
                            {item.tags.map((tag) => (
                              <Badge key={tag} variant="outline" className="text-[10px] border-border/50 text-muted-foreground">
                                <Tag className="h-2.5 w-2.5 mr-1" />
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <button className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                              <Edit3 className="h-3 w-3" /> Edit
                            </button>
                            <button className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-400 transition-colors">
                              <Trash2 className="h-3 w-3" /> Delete
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
