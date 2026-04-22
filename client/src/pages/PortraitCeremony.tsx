import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Loader2, Check, X, HelpCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAnchorStore } from "@/lib/store";
import { api } from "@/lib/api";

type Phase = "idle" | "profile" | "oracle" | "compass" | "done";

interface OracleCard {
  oracle: string;
  displayName: string;
  icon: string;
  narrative: string;
  questions: string[];
  durationMs?: number;
}

interface CompassData {
  headline: string;
  paragraph: string;
  three_questions: string[];
}

const ORACLE_META: Record<string, { displayName: string; icon: string; colorClass: string }> = {
  historian:    { displayName: "Historian",    icon: "📜", colorClass: "text-amber-400" },
  cartographer: { displayName: "Cartographer", icon: "🗺️", colorClass: "text-cyan-400" },
  purpose:      { displayName: "Purpose",      icon: "🎯", colorClass: "text-rose-400" },
  shadow:       { displayName: "Shadow",       icon: "🌗", colorClass: "text-violet-400" },
  tempo:        { displayName: "Tempo",        icon: "⏱️", colorClass: "text-emerald-400" },
};

export default function PortraitCeremony() {
  const [, navigate] = useLocation();
  const wsEvents = useAnchorStore((s) => s.wsEvents);
  const cursorRef = useRef(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [oracles, setOracles] = useState<OracleCard[]>([]);
  const [compass, setCompass] = useState<CompassData | null>(null);
  const [starting, setStarting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // On mount, try loading previously-generated portrait so user sees it immediately
  useEffect(() => {
    api.getLatestPortrait().then((p: any) => {
      if (!p) return;
      setOracles(p.oracles ?? []);
      setCompass(p.compass ?? null);
      setPhase("done");
    }).catch(() => {});
  }, []);

  // Listen to PORTRAIT_PROGRESS bus events from WebSocket
  useEffect(() => {
    for (let i = cursorRef.current; i < wsEvents.length; i++) {
      const ev = wsEvents[i];
      if (ev.type !== "PORTRAIT_PROGRESS") continue;
      const p = ev.payload;
      if (p.phase === "profile") setPhase("profile");
      else if (p.phase === "oracle") {
        setPhase("oracle");
        setOracles((prev) => {
          const existing = prev.find((o) => o.oracle === p.oracle);
          if (existing) return prev;
          const meta = ORACLE_META[p.oracle] ?? { displayName: p.oracle, icon: "●", colorClass: "text-foreground" };
          return [...prev, {
            oracle: p.oracle,
            displayName: meta.displayName,
            icon: p.icon ?? meta.icon,
            narrative: p.narrative ?? "",
            questions: p.questions ?? [],
            durationMs: p.durationMs,
          }];
        });
      } else if (p.phase === "compass") setPhase("compass");
      else if (p.phase === "done") {
        setPhase("done");
        if (p.compass) setCompass(p.compass);
      }
    }
    cursorRef.current = wsEvents.length;
  }, [wsEvents]);

  async function start() {
    setStarting(true);
    setOracles([]);
    setCompass(null);
    setPhase("profile");
    try {
      await api.startPortrait();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to start");
      setPhase("idle");
    } finally {
      setStarting(false);
    }
  }

  async function answerQuestion(source: string, question: string, answer: "yes" | "no" | "partial") {
    const key = `${source}:${question}`;
    setAnswers((prev) => ({ ...prev, [key]: answer }));
    try {
      await api.savePortraitAnswer({ source, question, answer });
    } catch {
      toast.error("Could not save answer");
    }
  }

  const inProgress = phase !== "idle" && phase !== "done";

  return (
    <div className="min-h-screen max-w-4xl mx-auto p-6 pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard">
          <button className="p-2 glass rounded-lg hover:bg-white/[0.03]">
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          </button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-400" />
            Meet Your Twin
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            5 oracles read your Mac and speak in turn. ~40 seconds. Answer a few questions to sharpen the portrait over time.
          </p>
        </div>
        {phase === "done" ? (
          <button onClick={start} disabled={starting || inProgress}
            className="glass rounded-lg px-4 py-2 text-xs text-amber-400 hover:bg-amber-500/10 disabled:opacity-50">
            Re-read me
          </button>
        ) : phase === "idle" ? (
          <button onClick={start} disabled={starting} className="glass rounded-lg px-4 py-2 text-sm text-foreground bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 font-medium">
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Begin"}
          </button>
        ) : null}
      </div>

      {/* Phase indicator */}
      {inProgress && (
        <div className="flex items-center gap-2 mb-6 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {phase === "profile" && "Inferring your profile…"}
          {phase === "oracle" && `${oracles.length}/5 oracles have spoken…`}
          {phase === "compass" && "Compass is synthesizing…"}
        </div>
      )}

      {/* Compass — shown only after all oracles complete */}
      <AnimatePresence>
        {compass && (
          <motion.div
            key="compass"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-2xl p-6 mb-6 border border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent"
          >
            <div className="flex items-start gap-3 mb-3">
              <Sparkles className="h-5 w-5 text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-lg font-medium text-foreground leading-snug">{compass.headline}</p>
            </div>
            <p className="text-sm text-foreground/80 leading-relaxed mb-4">{compass.paragraph}</p>
            {compass.three_questions.length > 0 && (
              <div className="border-t border-white/5 pt-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Questions worth answering</div>
                {compass.three_questions.map((q, i) => (
                  <QuestionRow
                    key={i}
                    source="compass"
                    question={q}
                    answer={answers[`compass:${q}`]}
                    onAnswer={(a) => answerQuestion("compass", q, a)}
                  />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Oracle cards — 5 in order */}
      <div className="grid grid-cols-1 gap-4">
        {["historian", "cartographer", "purpose", "shadow", "tempo"].map((oracleId) => {
          const oracle = oracles.find((o) => o.oracle === oracleId);
          const meta = ORACLE_META[oracleId];
          return (
            <OracleCardView
              key={oracleId}
              oracle={oracle}
              meta={meta}
              answers={answers}
              onAnswer={answerQuestion}
              loading={inProgress && !oracle}
            />
          );
        })}
      </div>

      {phase === "idle" && !compass && (
        <div className="text-center text-muted-foreground/60 text-sm py-16">
          <p>Tap <span className="text-foreground font-medium">Begin</span> when you're ready.</p>
          <p className="text-xs mt-2">Needs ~40s. Generates a fresh reading each time.</p>
        </div>
      )}
    </div>
  );
}

function OracleCardView({
  oracle, meta, answers, onAnswer, loading,
}: {
  oracle?: OracleCard;
  meta: { displayName: string; icon: string; colorClass: string };
  answers: Record<string, string>;
  onAnswer: (source: string, q: string, a: "yes" | "no" | "partial") => void;
  loading: boolean;
}) {
  if (!oracle) {
    return (
      <div className="glass rounded-xl p-5 opacity-40">
        <div className="flex items-center gap-2">
          <span className="text-xl">{meta.icon}</span>
          <span className={`text-sm font-medium ${meta.colorClass}`}>{meta.displayName}</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin ml-auto text-muted-foreground" />}
        </div>
      </div>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="glass rounded-xl p-5"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl">{oracle.icon}</span>
        <span className={`text-sm font-semibold ${meta.colorClass}`}>{oracle.displayName}</span>
        {oracle.durationMs && (
          <span className="text-[10px] text-muted-foreground/50 ml-auto font-mono">{(oracle.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{oracle.narrative}</p>
      {oracle.questions.length > 0 && (
        <div className="mt-4 pt-3 border-t border-white/5 space-y-2">
          {oracle.questions.map((q, i) => (
            <QuestionRow
              key={i}
              source={oracle.oracle}
              question={q}
              answer={answers[`${oracle.oracle}:${q}`]}
              onAnswer={(a) => onAnswer(oracle.oracle, q, a)}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}

function QuestionRow({
  source: _source, question, answer, onAnswer,
}: {
  source: string;
  question: string;
  answer?: string;
  onAnswer: (a: "yes" | "no" | "partial") => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <HelpCircle className="h-3 w-3 text-muted-foreground mt-1 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-xs text-foreground/80 leading-snug">{question}</p>
        <div className="flex gap-1 mt-1">
          <AnswerBtn label="Yes" active={answer === "yes"} onClick={() => onAnswer("yes")} />
          <AnswerBtn label="Partly" active={answer === "partial"} onClick={() => onAnswer("partial")} />
          <AnswerBtn label="No" active={answer === "no"} onClick={() => onAnswer("no")} />
        </div>
      </div>
    </div>
  );
}

function AnswerBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
        active
          ? "bg-amber-500/20 text-amber-400"
          : "bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
      }`}
    >
      {active && label === "Yes" && <Check className="h-2.5 w-2.5 inline mr-0.5" />}
      {active && label === "No" && <X className="h-2.5 w-2.5 inline mr-0.5" />}
      {label}
    </button>
  );
}
