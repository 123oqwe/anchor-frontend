/**
 * Scan — the cinematic scan flow.
 *
 * Modeled after the 999anchor.co landing page narrative:
 *   Observation → Processing → Action → Evolution
 *
 * Pure frontend choreography. Each phase plays for ~7s with an animated
 * icon, a stream of sample items rolling past, and a progress bar.
 * No real backend trigger here — this is the user's first impression of
 * "Anchor reading my Mac." Real scan can be triggered separately later.
 */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  Eye, Brain, Send, Sparkles,
  CheckCircle2, ChevronRight, Calendar, Mail,
  ListTodo, Activity, Zap, Target, Anchor as AnchorIcon,
} from "lucide-react";

type PhaseId = "observation" | "processing" | "action" | "evolution" | "done";

interface Phase {
  id: PhaseId;
  label: string;
  headline: string;
  subline: string;
  icon: typeof Eye;
  accent: string;
  durationMs: number;
  stream: string[];
}

// Each phase plays its `stream` items in sequence, one every ~600ms,
// while the page keeps an aggregate progress bar.
const PHASES: Phase[] = [
  {
    id: "observation",
    label: "01 / Observation",
    headline: "Reading your last 14 days.",
    subline: "Calendar · Email · Tasks · Behavior",
    icon: Eye,
    accent: "text-cyan-400",
    durationMs: 8400,
    stream: [
      "📅 38 calendar events parsed",
      "📧 247 emails read",
      "💬 412 messages observed",
      "✓ 23 tasks completed, 7 still open",
      "🌐 1,247 pages browsed",
      "📝 16 notes scanned",
      "👤 64 contacts indexed",
      "💻 8 active code repositories",
    ],
  },
  {
    id: "processing",
    label: "02 / Processing",
    headline: "Surfacing what matters.",
    subline: "Detecting patterns. Finding tensions. Watching for avoidance.",
    icon: Brain,
    accent: "text-violet-400",
    durationMs: 7200,
    stream: [
      "🔍 Pattern detected: late-night browsing on Tuesdays",
      "💡 3 priorities crystallizing",
      "⚠️ Decision delayed 3 times: 'YC application'",
      "📈 Relationship cooling: 2 contacts gone quiet",
      "🎯 Strong signal: building, not researching",
      "🌗 Tension: stated focus vs actual time spent",
    ],
  },
  {
    id: "action",
    label: "03 / Action",
    headline: "Building your decision surface.",
    subline: "Drafts, plans, suggestions — ready when you ask. Never sent without you.",
    icon: Send,
    accent: "text-amber-400",
    durationMs: 6000,
    stream: [
      "✍️ Email draft: investor follow-up",
      "📋 Plan: Q2 roadmap with dependencies",
      "🎤 Briefing: Wednesday's stand-up",
      "🔗 4 follow-ups suggested",
      "⏰ 2 deadlines flagged",
    ],
  },
  {
    id: "evolution",
    label: "04 / Evolution",
    headline: "Your digital twin is forming.",
    subline: "Every interaction makes Anchor more like you.",
    icon: Sparkles,
    accent: "text-emerald-400",
    durationMs: 5400,
    stream: [
      "🧬 Identity inferred: builder, late-stage early career",
      "🗣️ Voice modeled: direct, terse, action-first",
      "❤️ Values surfaced: craft, autonomy, depth",
      "🔮 Twin online — listening for your next decision",
    ],
  },
];

const STREAM_INTERVAL_MS = 700;

export default function Scan() {
  const [, navigate] = useLocation();
  const [phaseIdx, setPhaseIdx] = useState<number>(0);
  const [streamIdx, setStreamIdx] = useState<number>(0);
  const [phaseStartMs, setPhaseStartMs] = useState<number>(Date.now());
  const [done, setDone] = useState<boolean>(false);
  const startRef = useRef<number>(Date.now());

  // Drive phase progression
  useEffect(() => {
    if (done) return;
    if (phaseIdx >= PHASES.length) {
      setDone(true);
      return;
    }
    const phase = PHASES[phaseIdx];
    const t = setTimeout(() => {
      setPhaseIdx((i) => i + 1);
      setStreamIdx(0);
      setPhaseStartMs(Date.now());
    }, phase.durationMs);
    return () => clearTimeout(t);
  }, [phaseIdx, done]);

  // Drive stream item progression within each phase
  useEffect(() => {
    if (done) return;
    if (phaseIdx >= PHASES.length) return;
    const phase = PHASES[phaseIdx];
    const t = setInterval(() => {
      setStreamIdx((i) => Math.min(i + 1, phase.stream.length));
    }, STREAM_INTERVAL_MS);
    return () => clearInterval(t);
  }, [phaseIdx, done]);

  // Total progress across all phases (0..1)
  const totalDuration = PHASES.reduce((s, p) => s + p.durationMs, 0);
  const elapsedSoFar =
    PHASES.slice(0, phaseIdx).reduce((s, p) => s + p.durationMs, 0) +
    Math.min(Date.now() - phaseStartMs, PHASES[phaseIdx]?.durationMs ?? 0);
  const totalProgress = Math.min(1, elapsedSoFar / totalDuration);

  if (done) return <DoneView onContinue={() => navigate("/dashboard")} />;

  const current = PHASES[phaseIdx];
  const visibleStream = current.stream.slice(0, streamIdx + 1);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 relative overflow-hidden">
      {/* Subtle radial backdrop for depth */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.04),transparent_60%)]" />

      <div className="relative w-full max-w-2xl mx-auto">
        {/* ── Phase eyebrow ─────────────────────────────────── */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`label-${current.id}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3 }}
            className="flex items-center gap-3 mb-12"
          >
            <span className={`text-[11px] font-medium tracking-[0.2em] uppercase ${current.accent}`}>
              {current.label}
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-foreground/15 to-transparent" />
          </motion.div>
        </AnimatePresence>

        {/* ── Animated icon ─────────────────────────────────── */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`icon-${current.id}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="mb-10"
          >
            <PhaseIcon phase={current} />
          </motion.div>
        </AnimatePresence>

        {/* ── Headline + subline ────────────────────────────── */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`text-${current.id}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="mb-10"
          >
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-[1.1]">
              {current.headline}
            </h1>
            <p className="text-base text-muted-foreground mt-3 leading-relaxed">
              {current.subline}
            </p>
          </motion.div>
        </AnimatePresence>

        {/* ── Scrolling stream of items being processed ────── */}
        <div className="min-h-[200px] mb-10">
          <ul className="space-y-2">
            <AnimatePresence>
              {visibleStream.map((item, i) => (
                <motion.li
                  key={`${current.id}-${i}-${item}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  className="text-sm text-foreground/85 font-mono tabular-nums"
                >
                  {item}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>

        {/* ── Progress bar ──────────────────────────────────── */}
        <div className="space-y-3">
          <div className="h-[2px] w-full bg-foreground/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-foreground/70 rounded-full"
              initial={false}
              animate={{ width: `${totalProgress * 100}%` }}
              transition={{ duration: 0.5, ease: "linear" }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground/60 tracking-wider">
            <span>{Math.round(totalProgress * 100)}%</span>
            <span>Phase {phaseIdx + 1} of {PHASES.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Animated icon for each phase ─────────────────────────────────────────

function PhaseIcon({ phase }: { phase: Phase }) {
  const Icon = phase.icon;
  return (
    <div className="relative w-20 h-20">
      {/* Pulsing ring */}
      <motion.div
        className={`absolute inset-0 rounded-full bg-current ${phase.accent}`}
        style={{ opacity: 0.08 }}
        animate={{ scale: [1, 1.4, 1], opacity: [0.08, 0.0, 0.08] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Inner soft halo */}
      <div className={`absolute inset-2 rounded-full bg-current ${phase.accent}`} style={{ opacity: 0.12 }} />
      {/* Icon */}
      <div className="absolute inset-0 flex items-center justify-center">
        <Icon className={`h-9 w-9 ${phase.accent}`} strokeWidth={1.5} />
      </div>
    </div>
  );
}

// ─── Done view ────────────────────────────────────────────────────────────

function DoneView({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.06),transparent_60%)]" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-xl text-center"
      >
        {/* Anchor mark */}
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mb-10 w-20 h-20 relative"
        >
          <div className="absolute inset-0 rounded-full bg-emerald-400/10" />
          <div className="absolute inset-2 rounded-full bg-emerald-400/15" />
          <div className="absolute inset-0 flex items-center justify-center">
            <CheckCircle2 className="h-9 w-9 text-emerald-400" strokeWidth={1.5} />
          </div>
        </motion.div>

        <p className="text-[11px] tracking-[0.2em] uppercase text-emerald-400/80 mb-4">
          Twin online
        </p>

        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05] mb-5">
          Anchor knows you a little better now.
        </h1>

        <p className="text-base text-muted-foreground leading-relaxed mb-12 max-w-md mx-auto">
          47 graph nodes added · 12 patterns surfaced · 3 tensions detected.
          Open Dashboard to see what matters today.
        </p>

        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          onClick={onContinue}
          className="group inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-colors"
        >
          <span>Open Dashboard</span>
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2.5} />
        </motion.button>

        {/* Tiny stat strip — calm, not loud */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 0.6 }}
          className="mt-16 grid grid-cols-3 gap-4 max-w-md mx-auto text-xs text-muted-foreground/70"
        >
          <div className="flex items-center justify-center gap-1.5">
            <Activity className="h-3 w-3" />
            <span>Energy 72</span>
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <Target className="h-3 w-3" />
            <span>Focus 85</span>
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <Zap className="h-3 w-3" />
            <span>Stress 34</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.0 }}
          className="flex items-center justify-center gap-2 mt-10 text-[11px] text-muted-foreground/50 tracking-wider"
        >
          <AnchorIcon className="h-3 w-3" />
          <span>All data stays local. Anchor never acts without you.</span>
        </motion.div>
      </motion.div>
    </div>
  );
}
