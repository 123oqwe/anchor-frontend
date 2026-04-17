import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, Sparkles, User, FileText, CheckCircle2, XCircle,
  Lightbulb, Brain, MessageSquare, Bot, Play, ChevronDown, ChevronRight,
  Loader2, Plus, Minus, Trash2, GripVertical, Edit3,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";

type MessageRole = "user" | "advisor" | "draft" | "agent-action";

interface EditableStep {
  id: number;
  content: string;
  time_estimate?: string;
}

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  draftType?: string;
  draftStatus?: "pending" | "approved" | "rejected" | "executing" | "done";
  agentName?: string;
  structured?: {
    type: string;
    suggestion_summary: string;
    reasoning: string;
    editable_steps: EditableStep[];
    risk_level: string;
    referenced_nodes: string[];
    why_this_now?: string;
    conflict_flags?: string[];
    confidence?: number;
  };
  packet?: {
    whyThisNow: string;
    conflictFlags: string[];
    confidenceScore: number;
    riskLevel: string;
    boundaryClassification: string;
    stagesTrace: { stage: string; output: string }[];
  };
}

const personalSuggestions = [
  "Am I avoiding something important?",
  "What should I prioritize this week?",
  "Help me follow up with my investors",
];
const generalSuggestions = [
  "Explain transformer architecture",
  "Help me write a pitch deck outline",
  "Compare React vs Vue for our use case",
];

function EditableStepsCard({
  structured,
  packet,
  onConfirm,
  onReject,
}: {
  structured: Message["structured"];
  packet?: Message["packet"];
  onConfirm: (original: EditableStep[], edited: EditableStep[]) => void;
  onReject: () => void;
}) {
  const [showTrace, setShowTrace] = useState(false);
  const [steps, setSteps] = useState<EditableStep[]>(
    () => structured?.editable_steps?.map(s => ({ ...s })) ?? []
  );
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [newStep, setNewStep] = useState("");

  const startEdit = (step: EditableStep) => {
    setEditingId(step.id);
    setEditText(step.content);
  };

  const saveEdit = () => {
    if (editingId === null) return;
    setSteps(prev => prev.map(s => s.id === editingId ? { ...s, content: editText } : s));
    setEditingId(null);
  };

  const deleteStep = (id: number) => {
    setSteps(prev => prev.filter(s => s.id !== id));
  };

  const addStep = () => {
    if (!newStep.trim()) return;
    setSteps(prev => [...prev, { id: Date.now(), content: newStep.trim() }]);
    setNewStep("");
  };

  return (
    <div className="glass-strong rounded-xl border border-primary/20 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30">
        <div className="flex items-center gap-2 mb-1">
          <Badge className="text-[10px] bg-amber-500/10 text-amber-400">Plan — Editable</Badge>
          {structured?.risk_level && (
            <Badge className={`text-[10px] ${structured.risk_level === "high" ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>
              {structured.risk_level} risk
            </Badge>
          )}
        </div>
        <p className="text-sm text-foreground font-medium">{structured?.suggestion_summary}</p>
        {structured?.reasoning && (
          <p className="text-xs text-muted-foreground mt-1">{structured.reasoning}</p>
        )}

        {/* L3 Packet: Why This Now + Confidence + Conflicts */}
        {packet && (
          <div className="mt-3 space-y-2">
            {/* Confidence bar */}
            {packet.confidenceScore > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Confidence</span>
                <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${packet.confidenceScore > 0.7 ? "bg-emerald-400/60" : packet.confidenceScore > 0.4 ? "bg-amber-400/60" : "bg-red-400/60"}`}
                    style={{ width: `${packet.confidenceScore * 100}%` }} />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">{Math.round(packet.confidenceScore * 100)}%</span>
              </div>
            )}

            {/* Why This Now */}
            {packet.whyThisNow && (
              <div className="bg-blue-500/5 border border-blue-500/10 rounded-lg px-3 py-2">
                <span className="text-[9px] text-blue-400 uppercase tracking-wider font-medium">Why now</span>
                <p className="text-xs text-foreground/80 mt-0.5">{packet.whyThisNow}</p>
              </div>
            )}

            {/* Conflict flags */}
            {packet.conflictFlags?.length > 0 && (
              <div className="space-y-1">
                <span className="text-[9px] text-amber-400 uppercase tracking-wider font-medium">Tensions & Risks</span>
                {packet.conflictFlags.map((flag, i) => (
                  <div key={i} className="bg-amber-500/5 border border-amber-500/10 rounded-md px-2.5 py-1.5 text-[11px] text-amber-300/80">
                    {flag}
                  </div>
                ))}
              </div>
            )}

            {/* Reasoning trace (collapsible) */}
            {packet.stagesTrace?.length > 0 && (
              <div>
                <button onClick={() => setShowTrace(!showTrace)}
                  className="text-[9px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
                  {showTrace ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                  Reasoning trace ({packet.stagesTrace.length} stages)
                </button>
                {showTrace && (
                  <div className="mt-1.5 space-y-1 pl-3 border-l border-border/30">
                    {packet.stagesTrace.map((stage, i) => (
                      <div key={i} className="text-[10px]">
                        <span className="text-muted-foreground font-mono">{stage.stage}:</span>
                        <span className="text-foreground/70 ml-1">{stage.output}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="p-3 space-y-1.5">
        {steps.map((step, i) => (
          <div key={step.id} className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/[0.03] transition-colors">
            <GripVertical className="h-3 w-3 text-muted-foreground/30 shrink-0" />
            <span className="text-xs text-muted-foreground font-mono w-5 shrink-0">{i + 1}.</span>

            {editingId === step.id ? (
              <div className="flex-1 flex gap-2">
                <input
                  type="text"
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveEdit()}
                  autoFocus
                  className="flex-1 bg-white/5 rounded px-2 py-1 text-sm text-foreground focus:outline-none border border-primary/30"
                />
                <button onClick={saveEdit} className="text-primary text-xs">Save</button>
              </div>
            ) : (
              <>
                <span className="flex-1 text-sm text-foreground">{step.content}</span>
                {step.time_estimate && (
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">{step.time_estimate}</span>
                )}
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => startEdit(step)} className="text-muted-foreground hover:text-primary transition-colors">
                    <Edit3 className="h-3 w-3" />
                  </button>
                  <button onClick={() => deleteStep(step.id)} className="text-muted-foreground hover:text-red-400 transition-colors">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        {/* Add step */}
        <div className="flex items-center gap-2 px-3 py-2">
          <Plus className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <input
            type="text"
            value={newStep}
            onChange={e => setNewStep(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addStep()}
            placeholder="Add a step..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
          {newStep && (
            <button onClick={addStep} className="text-[10px] text-primary">Add</button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-border/30 flex gap-2">
        <button
          onClick={() => onConfirm(structured?.editable_steps ?? [], steps)}
          className="flex-1 bg-primary/20 text-primary rounded-lg py-2 text-sm hover:bg-primary/30 transition-colors flex items-center justify-center gap-1.5"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Confirm & Execute
        </button>
        <button
          onClick={onReject}
          className="glass rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function AgentStatusBadge({ name, successes, failures }: { name: string; successes: number; failures: number }) {
  return (
    <div className="flex items-center gap-2 glass rounded-lg px-3 py-1.5">
      <Bot className="h-3 w-3 text-primary" />
      <span className="text-[10px] font-medium text-foreground">{name}</span>
      <div className="flex items-center gap-1 text-[10px] font-mono">
        <Plus className="h-2 w-2 text-emerald-400" /><span className="text-emerald-400">{successes}</span>
        <Minus className="h-2 w-2 text-red-400 ml-0.5" /><span className="text-red-400">{failures}</span>
      </div>
    </div>
  );
}

function ChatView({ mode, suggestions }: { mode: string; suggestions: string[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getChatHistory(mode).then(rows => {
      setMessages(rows);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [mode]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;
    const text = input.trim();
    setInput("");

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages(prev => [...prev, userMsg]);
    setIsTyping(true);

    try {
      let response: any;
      if (mode === "personal") response = await api.sendPersonal(text);
      else response = await api.sendGeneral(text);
      setMessages(prev => [...prev, response]);
    } catch {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: "advisor",
        content: "Something went wrong. Check that ANTHROPIC_API_KEY is set.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleConfirm = async (msgId: string, original: EditableStep[], edited: EditableStep[]) => {
    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, draftStatus: "executing" } : m));
    try {
      await api.confirmPlan(original, edited);
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, draftStatus: "done" } : m));
    } catch {
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, draftStatus: "pending" } : m));
    }
  };

  const handleReject = async (msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    const steps = msg?.structured?.editable_steps ?? [];
    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, draftStatus: "rejected" } : m));
    try { await api.rejectPlan(msgId, steps); } catch {}
  };

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4 custom-scrollbar">
        <AnimatePresence initial={false}>
          {messages.map(msg => (
            <motion.div key={msg.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
              className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role !== "user" && (
                <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 ${msg.role === "draft" ? "bg-amber-500/10" : "bg-primary/10"}`}>
                  {msg.role === "draft" ? <FileText className="h-3.5 w-3.5 text-amber-400" /> : <Sparkles className="h-3.5 w-3.5 text-primary" />}
                </div>
              )}
              <div className={`max-w-[600px] ${msg.role === "user" ? "text-right" : ""}`}>
                {/* Structured editable plan */}
                {msg.role === "draft" && msg.structured && msg.draftStatus === "pending" ? (
                  <EditableStepsCard
                    structured={msg.structured}
                    packet={msg.packet}
                    onConfirm={(orig, edited) => handleConfirm(msg.id, orig, edited)}
                    onReject={() => handleReject(msg.id)}
                  />
                ) : (
                  <>
                    {msg.role === "draft" && (
                      <div className="flex items-center gap-2 mb-2">
                        <Badge className="text-[10px] bg-amber-500/10 text-amber-400">Plan</Badge>
                        {msg.draftStatus === "done" && <Badge className="text-[10px] bg-emerald-500/10 text-emerald-400"><CheckCircle2 className="h-3 w-3 mr-1" />Executed</Badge>}
                        {msg.draftStatus === "rejected" && <Badge className="text-[10px] bg-red-500/10 text-red-400"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>}
                        {msg.draftStatus === "executing" && <Badge className="text-[10px] bg-blue-500/10 text-blue-400"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Executing</Badge>}
                      </div>
                    )}
                    <div className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${msg.role === "user" ? "bg-primary text-primary-foreground ml-auto" : msg.role === "draft" ? "glass-strong border-amber-500/20" : "glass"}`}>
                      {msg.content.split("\n").map((line, i) => (
                        <p key={i} className={`${i > 0 ? "mt-1" : ""} ${line.startsWith("**") ? "font-semibold" : ""} ${line.startsWith("→") ? "text-muted-foreground pl-2" : ""}`}>
                          {line.replace(/\*\*/g, "")}
                        </p>
                      ))}
                    </div>
                  </>
                )}
                <span className="text-[10px] text-muted-foreground font-mono mt-1 inline-block">{msg.timestamp}</span>
              </div>
              {msg.role === "user" && (
                <div className="shrink-0 w-7 h-7 rounded-lg bg-muted flex items-center justify-center mt-0.5">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {isTyping && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center"><Sparkles className="h-3.5 w-3.5 text-primary" /></div>
            <div className="glass rounded-xl px-4 py-3">
              <div className="flex gap-1">
                {[0, 150, 300].map(d => <span key={d} className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
              </div>
            </div>
          </motion.div>
        )}
      </div>

      <div className="shrink-0 px-6 pb-2">
        <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
          {suggestions.map(q => (
            <button key={q} onClick={() => setInput(q)} className="shrink-0 flex items-center gap-1.5 glass rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/[0.07] transition-all">
              <Lightbulb className="h-3 w-3 text-primary" />{q}
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-4 pt-1">
        <form onSubmit={handleSend} className="glass rounded-xl overflow-hidden flex items-center focus-within:border-primary/30 transition-colors">
          <input type="text" value={input} onChange={e => setInput(e.target.value)}
            placeholder={mode === "personal" ? "Ask about your priorities, patterns, or decisions..." : "Ask anything — research, analysis, brainstorming..."}
            className="flex-1 bg-transparent px-5 py-3.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
          <button type="submit" disabled={!input.trim() || isTyping} className="px-5 py-3.5 text-muted-foreground hover:text-primary disabled:opacity-30 transition-colors">
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

export default function Advisor() {
  const [agentStatus, setAgentStatus] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [showExecLog, setShowExecLog] = useState(false);

  useEffect(() => {
    api.getAgentStatus().then(setAgentStatus).catch(() => {});
    api.getExecutions().then(rows => setExecutions(rows.slice(0, 5))).catch(() => {});
  }, []);

  const decisionAgent = agentStatus.find((a: any) => a.name === "Decision Agent");
  const execAgent = agentStatus.find((a: any) => a.name === "Execution Agent");

  return (
    <div className="flex flex-col h-screen">
      <div className="shrink-0 px-6 py-4 border-b border-border/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10"><Sparkles className="h-4 w-4 text-primary" /></div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Advisor</h1>
              <p className="text-xs text-muted-foreground">Decision Agent + Execution Agent</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2">
            {decisionAgent && <AgentStatusBadge name="Decision" successes={decisionAgent.successes} failures={decisionAgent.failures} />}
            {execAgent && <AgentStatusBadge name="Execution" successes={execAgent.successes} failures={execAgent.failures} />}
            <button onClick={() => setShowExecLog(!showExecLog)} className="glass rounded-lg px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <Play className="h-3 w-3" />Log<ChevronDown className={`h-3 w-3 transition-transform ${showExecLog ? "rotate-180" : ""}`} />
            </button>
          </div>
        </div>

        <AnimatePresence>
          {showExecLog && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <div className="mt-3 glass rounded-xl p-4">
                <h4 className="text-[10px] font-semibold text-muted-foreground tracking-wider uppercase mb-3">Recent Executions</h4>
                <div className="space-y-2">
                  {executions.map((entry: any) => (
                    <div key={entry.id} className="flex items-center gap-3 text-xs">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${entry.status === "success" ? "bg-emerald-400" : entry.status === "failed" ? "bg-red-400" : "bg-muted-foreground/30"}`} />
                      <span className="text-muted-foreground font-mono w-20 shrink-0 text-[10px]">{new Date(entry.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <Badge className="text-[9px] bg-white/5 text-muted-foreground shrink-0">{entry.agent}</Badge>
                      <span className="text-foreground/80 flex-1">{entry.action}</span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Tabs defaultValue="personal" className="flex-1 flex flex-col overflow-hidden">
        <div className="shrink-0 px-6 pt-3">
          <TabsList className="glass border-0 p-1 w-full justify-start">
            <TabsTrigger value="personal" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary flex items-center gap-1.5"><Brain className="h-3 w-3" />Personal Advisor</TabsTrigger>
            <TabsTrigger value="general" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary flex items-center gap-1.5"><MessageSquare className="h-3 w-3" />General AI</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="personal" className="flex-1 overflow-hidden mt-0">
          <div className="px-6 py-2"><p className="text-[10px] text-muted-foreground">Decision Agent reads your <strong className="text-foreground">Human Graph + Twin insights</strong>. Edit suggestions before execution.</p></div>
          <ChatView mode="personal" suggestions={personalSuggestions} />
        </TabsContent>
        <TabsContent value="general" className="flex-1 overflow-hidden mt-0">
          <div className="px-6 py-2"><p className="text-[10px] text-muted-foreground">General-purpose AI. <strong className="text-foreground">No personal context.</strong></p></div>
          <ChatView mode="general" suggestions={generalSuggestions} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
