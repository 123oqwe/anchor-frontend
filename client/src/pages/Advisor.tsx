import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Sparkles,
  User,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  Lightbulb,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

type MessageRole = "user" | "advisor" | "draft";

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  draftType?: "email" | "plan" | "analysis";
  draftStatus?: "pending" | "approved" | "rejected";
}

const initialMessages: Message[] = [
  {
    id: "1",
    role: "advisor",
    content: "Good morning. Based on your Human Graph, I've identified 3 areas that need attention today. Your YC application has been delayed 3 times — this is the highest priority. Would you like me to help you structure a focused 2-hour work block?",
    timestamp: "9:00 AM",
  },
  {
    id: "2",
    role: "user",
    content: "Yes, help me plan the YC application session. Also, I need to reach out to Matt Zhang — we haven't talked in a while.",
    timestamp: "9:02 AM",
  },
  {
    id: "3",
    role: "advisor",
    content: "I'll create two action items. First, here's a structured plan for your YC session. Second, I've drafted a follow-up message to Matt based on your last conversation context.",
    timestamp: "9:02 AM",
  },
  {
    id: "4",
    role: "draft",
    content: "**YC Application Work Block**\n\n1. Review current draft (15 min)\n2. Refine 'Why Now' section — use market timing data from your research notes\n3. Rewrite founder story — emphasize the behavioral insight angle\n4. Final review & submit to co-founder for feedback\n\n*Estimated: 2 hours | Blocks: Calendar 10:00-12:00*",
    timestamp: "9:03 AM",
    draftType: "plan",
    draftStatus: "pending",
  },
  {
    id: "5",
    role: "draft",
    content: "**Email to Matt Zhang**\n\nSubject: Quick catch-up this week?\n\nHey Matt,\n\nIt's been a few days — hope things are going well with the Series B prep. I've been heads-down on our YC application and would love to get your perspective on our go-to-market framing.\n\nFree for a 20-min call this week?\n\nBest,\n[Your name]",
    timestamp: "9:03 AM",
    draftType: "email",
    draftStatus: "pending",
  },
];

const suggestedQuestions = [
  "Am I avoiding something important?",
  "What should I prioritize this week?",
  "Analyze my decision patterns",
  "Help me prepare for the investor meeting",
];

export default function Advisor() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    setTimeout(() => {
      const advisorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "advisor",
        content: "I understand. Let me analyze your current context and Human Graph state to provide a thoughtful recommendation. Based on your recent patterns and priorities, here's what I suggest...",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, advisorMsg]);
      setIsTyping(false);
    }, 1500);
  };

  const handleDraftAction = (id: string, action: "approved" | "rejected") => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, draftStatus: action } : m))
    );
  };

  const handleSuggestion = (q: string) => {
    setInput(q);
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="shrink-0 px-8 py-5 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Advisor</h1>
            <p className="text-xs text-muted-foreground">Decision conversations powered by your Human Graph</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-6 custom-scrollbar">
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}
            >
              {msg.role !== "user" && (
                <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 ${
                  msg.role === "draft" ? "bg-amber-500/10" : "bg-primary/10"
                }`}>
                  {msg.role === "draft" ? (
                    <FileText className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                  )}
                </div>
              )}

              <div className={`max-w-[600px] ${msg.role === "user" ? "text-right" : ""}`}>
                {msg.role === "draft" && (
                  <div className="flex items-center gap-2 mb-2">
                    <Badge className="text-[10px] bg-amber-500/10 text-amber-400">
                      Draft — {msg.draftType}
                    </Badge>
                    {msg.draftStatus === "approved" && (
                      <Badge className="text-[10px] bg-emerald-500/10 text-emerald-400">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Approved
                      </Badge>
                    )}
                    {msg.draftStatus === "rejected" && (
                      <Badge className="text-[10px] bg-red-500/10 text-red-400">
                        <XCircle className="h-3 w-3 mr-1" /> Rejected
                      </Badge>
                    )}
                  </div>
                )}

                <div className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground ml-auto"
                    : msg.role === "draft"
                    ? "glass-strong border-amber-500/20"
                    : "glass"
                }`}>
                  {msg.content.split("\n").map((line, i) => (
                    <p key={i} className={`${i > 0 ? "mt-1" : ""} ${line.startsWith("**") ? "font-semibold" : ""}`}>
                      {line.replace(/\*\*/g, "")}
                    </p>
                  ))}
                </div>

                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-muted-foreground font-mono">{msg.timestamp}</span>
                  {msg.role === "draft" && msg.draftStatus === "pending" && (
                    <div className="flex gap-1.5 ml-2">
                      <button
                        onClick={() => handleDraftAction(msg.id, "approved")}
                        className="flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        <CheckCircle2 className="h-3 w-3" /> Approve
                      </button>
                      <button
                        onClick={() => handleDraftAction(msg.id, "rejected")}
                        className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 transition-colors"
                      >
                        <XCircle className="h-3 w-3" /> Reject
                      </button>
                    </div>
                  )}
                </div>
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-3"
          >
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="glass rounded-xl px-4 py-3">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Suggested questions */}
      <div className="shrink-0 px-8 pb-2">
        <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
          {suggestedQuestions.map((q) => (
            <button
              key={q}
              onClick={() => handleSuggestion(q)}
              className="shrink-0 flex items-center gap-1.5 glass rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/[0.07] transition-all"
            >
              <Lightbulb className="h-3 w-3 text-primary" />
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 px-8 pb-6 pt-2">
        <form onSubmit={handleSend} className="glass rounded-xl overflow-hidden flex items-center focus-within:border-primary/30 transition-colors">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask your advisor anything..."
            className="flex-1 bg-transparent px-5 py-4 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-5 py-4 text-muted-foreground hover:text-primary disabled:opacity-30 transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
