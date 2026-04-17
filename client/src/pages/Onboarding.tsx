/**
 * L7 — Onboarding: Guided setup → Scan → First Insight → Dashboard.
 *
 * Better than Hermes: doesn't just wait for you to figure it out.
 * 5 steps of input + 1 scanning step + 1 insight reveal.
 * User enters → system processes → "Wow it understands me" → Dashboard.
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  Anchor, ArrowRight, ArrowLeft, User, Target, Users,
  Zap, CheckCircle2, Sparkles, Plus, X, Brain,
  Scan, Activity, Eye, Shield, Loader2,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";

const STEPS = ["Welcome", "About You", "Your Goals", "Key People", "Preferences", "Scanning", "Your Insight"];

const SCAN_PHASES = [
  { label: "Building your Human Graph...", icon: Brain, duration: 2000 },
  { label: "Mapping relationships...", icon: Users, duration: 1500 },
  { label: "Analyzing priorities...", icon: Target, duration: 2000 },
  { label: "Detecting patterns...", icon: Eye, duration: 1500 },
  { label: "Generating your first insight...", icon: Sparkles, duration: 2500 },
];

export default function Onboarding() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Input state
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [goals, setGoals] = useState<{ text: string; domain: string }[]>([]);
  const [goalInput, setGoalInput] = useState("");
  const [goalDomain, setGoalDomain] = useState("work");
  const [people, setPeople] = useState<{ name: string; relationship: string }[]>([]);
  const [personName, setPersonName] = useState("");
  const [personRel, setPersonRel] = useState("");
  const [commPref, setCommPref] = useState("email");
  const [peakTime, setPeakTime] = useState("morning");
  const [values, setValues] = useState<string[]>([]);
  const [valueInput, setValueInput] = useState("");

  // Scan state
  const [scanPhase, setScanPhase] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);
  const [firstInsight, setFirstInsight] = useState<string | null>(null);
  const [insightConfidence, setInsightConfidence] = useState(0);

  const addGoal = () => { if (goalInput.trim()) { setGoals([...goals, { text: goalInput.trim(), domain: goalDomain }]); setGoalInput(""); } };
  const addPerson = () => { if (personName.trim()) { setPeople([...people, { name: personName.trim(), relationship: personRel || "contact" }]); setPersonName(""); setPersonRel(""); } };
  const addValue = () => { if (valueInput.trim()) { setValues([...values, valueInput.trim()]); setValueInput(""); } };

  // Save data + start scan
  const startScan = async () => {
    setSaving(true);
    setStep(5); // go to scanning step

    try {
      // Save all data to backend
      if (name) await api.updateProfile({ name, role });
      for (const g of goals) await api.createNode({ domain: g.domain, label: g.text, type: "goal", status: "active", captured: "Onboarding", detail: `Goal: ${g.text}` });
      for (const p of people) await api.createNode({ domain: "relationships", label: p.name, type: "person", status: "active", captured: "Onboarding", detail: p.relationship });
      if (commPref) await api.createNode({ domain: "growth", label: `Prefers ${commPref}`, type: "preference", status: "stable", captured: "Onboarding", detail: `Communication: ${commPref}` });
      if (peakTime) await api.createNode({ domain: "growth", label: `Peak: ${peakTime}`, type: "preference", status: "stable", captured: "Onboarding", detail: `Productivity: ${peakTime}` });
      for (const v of values) await api.createNode({ domain: "growth", label: v, type: "value", status: "stable", captured: "Onboarding", detail: `Core value: ${v}` });

      // Animate scan phases
      for (let i = 0; i < SCAN_PHASES.length; i++) {
        setScanPhase(i);
        const phase = SCAN_PHASES[i];
        const startProg = (i / SCAN_PHASES.length) * 100;
        const endProg = ((i + 1) / SCAN_PHASES.length) * 100;

        // Animate progress within this phase
        const steps = 20;
        for (let s = 0; s < steps; s++) {
          await new Promise(r => setTimeout(r, phase.duration / steps));
          setScanProgress(startProg + ((s + 1) / steps) * (endProg - startProg));
        }
      }

      setScanProgress(100);

      // Generate first insight (the magic moment)
      try {
        const insight = await api.getFirstInsight();
        setFirstInsight(insight.content?.slice(0, 400) ?? "Anchor is ready to help you make better decisions.");
        setInsightConfidence(insight.packet?.confidenceScore ?? 0.85);
      } catch {
        setFirstInsight("Your Human Graph is ready. Head to Dashboard to start making better decisions.");
        setInsightConfidence(0.8);
      }

      setStep(6); // show insight
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-lg">

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Anchor className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Anchor</h1>
            <p className="text-xs text-muted-foreground">
              {step <= 4 ? `Step ${step + 1} of 5: ${STEPS[step]}` : step === 5 ? "Analyzing your world..." : "Ready"}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="flex gap-1 mb-8">
          {[0,1,2,3,4].map(i => (
            <div key={i} className={`flex-1 h-1 rounded-full transition-all duration-300 ${i <= Math.min(step, 4) ? "bg-primary" : "bg-white/10"}`} />
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* Step 0: Welcome */}
          {step === 0 && (
            <motion.div key="welcome" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
              <div className="glass rounded-xl p-8 text-center">
                <Sparkles className="h-12 w-12 text-primary mx-auto mb-4" />
                <h2 className="text-2xl font-bold mb-2">Your Personal AI Decision OS</h2>
                <p className="text-muted-foreground">Anchor builds a living model of who you are — your goals, relationships, patterns, and preferences. Then it helps you make better decisions.</p>
                <div className="flex items-center justify-center gap-6 mt-6 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Eye className="h-3 w-3 text-primary" /> Observes</span>
                  <span className="flex items-center gap-1"><Brain className="h-3 w-3 text-primary" /> Thinks</span>
                  <span className="flex items-center gap-1"><Shield className="h-3 w-3 text-primary" /> Protects</span>
                  <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-primary" /> Acts</span>
                </div>
              </div>
            </motion.div>
          )}

          {/* Step 1: Identity */}
          {step === 1 && (
            <motion.div key="identity" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><User className="h-4 w-4 text-primary" /><span className="text-sm font-medium">About You</span></div>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="w-full glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
              <input value={role} onChange={e => setRole(e.target.value)} placeholder="Your role (Founder, Engineer, Student...)" className="w-full glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
            </motion.div>
          )}

          {/* Step 2: Goals */}
          {step === 2 && (
            <motion.div key="goals" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><Target className="h-4 w-4 text-primary" /><span className="text-sm font-medium">What are you working toward?</span></div>
              <div className="flex gap-2">
                <input value={goalInput} onChange={e => setGoalInput(e.target.value)} onKeyDown={e => e.key === "Enter" && addGoal()} placeholder="e.g. Launch MVP by June"
                  className="flex-1 glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                <select value={goalDomain} onChange={e => setGoalDomain(e.target.value)} className="glass rounded-lg px-3 py-3 text-xs text-foreground bg-transparent">
                  <option value="work">Work</option><option value="finance">Finance</option><option value="health">Health</option><option value="growth">Growth</option><option value="relationships">Relationships</option>
                </select>
                <button onClick={addGoal} className="glass rounded-lg px-3 py-3 text-primary hover:bg-primary/10"><Plus className="h-4 w-4" /></button>
              </div>
              {goals.map((g, i) => (
                <div key={i} className="glass rounded-lg px-3 py-2 flex items-center justify-between text-sm">
                  <span>{g.text} <span className="text-[10px] text-muted-foreground">({g.domain})</span></span>
                  <button onClick={() => setGoals(goals.filter((_, j) => j !== i))}><X className="h-3 w-3 text-muted-foreground" /></button>
                </div>
              ))}
              {goals.length === 0 && <p className="text-xs text-muted-foreground">Add at least one goal.</p>}
            </motion.div>
          )}

          {/* Step 3: People */}
          {step === 3 && (
            <motion.div key="people" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><Users className="h-4 w-4 text-primary" /><span className="text-sm font-medium">Key people in your life</span></div>
              <div className="flex gap-2">
                <input value={personName} onChange={e => setPersonName(e.target.value)} onKeyDown={e => e.key === "Enter" && addPerson()} placeholder="Name" className="flex-1 glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                <input value={personRel} onChange={e => setPersonRel(e.target.value)} onKeyDown={e => e.key === "Enter" && addPerson()} placeholder="Relationship" className="flex-1 glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                <button onClick={addPerson} className="glass rounded-lg px-3 py-3 text-primary hover:bg-primary/10"><Plus className="h-4 w-4" /></button>
              </div>
              {people.map((p, i) => (
                <div key={i} className="glass rounded-lg px-3 py-2 flex items-center justify-between text-sm">
                  <span>{p.name} <span className="text-[10px] text-muted-foreground">({p.relationship})</span></span>
                  <button onClick={() => setPeople(people.filter((_, j) => j !== i))}><X className="h-3 w-3 text-muted-foreground" /></button>
                </div>
              ))}
              {people.length === 0 && <p className="text-xs text-muted-foreground">Optional — add people later through conversations.</p>}
            </motion.div>
          )}

          {/* Step 4: Preferences */}
          {step === 4 && (
            <motion.div key="prefs" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><Zap className="h-4 w-4 text-primary" /><span className="text-sm font-medium">How do you operate?</span></div>
              <div>
                <label className="text-xs text-muted-foreground">Communication</label>
                <div className="flex gap-2 mt-1">
                  {["email", "slack", "phone", "in-person"].map(o => (
                    <button key={o} onClick={() => setCommPref(o)} className={`glass rounded-lg px-3 py-2 text-xs ${commPref === o ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}>{o}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Peak time</label>
                <div className="flex gap-2 mt-1">
                  {["early morning", "morning", "afternoon", "evening", "night"].map(o => (
                    <button key={o} onClick={() => setPeakTime(o)} className={`glass rounded-lg px-3 py-2 text-xs ${peakTime === o ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}>{o}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Core values</label>
                <div className="flex gap-2 mt-1">
                  <input value={valueInput} onChange={e => setValueInput(e.target.value)} onKeyDown={e => e.key === "Enter" && addValue()} placeholder="Family, Honesty, Impact..."
                    className="flex-1 glass rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                  <button onClick={addValue} className="glass rounded-lg px-3 py-2 text-primary hover:bg-primary/10"><Plus className="h-4 w-4" /></button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {values.map((v, i) => (
                    <span key={i} className="glass rounded-full px-3 py-1 text-xs text-foreground flex items-center gap-1">
                      {v} <button onClick={() => setValues(values.filter((_, j) => j !== i))}><X className="h-2.5 w-2.5" /></button>
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {/* Step 5: SCANNING — the magic bridge */}
          {step === 5 && (
            <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              <div className="glass rounded-xl p-8 text-center">
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }} className="inline-block mb-4">
                  <Scan className="h-12 w-12 text-primary" />
                </motion.div>
                <h2 className="text-xl font-bold mb-4">Building Your World</h2>

                <Progress value={scanProgress} className="mb-4" />

                <AnimatePresence mode="wait">
                  <motion.div key={scanPhase} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center justify-center gap-2">
                    {(() => { const Icon = SCAN_PHASES[scanPhase]?.icon ?? Sparkles; return <Icon className="h-4 w-4 text-primary" />; })()}
                    <span className="text-sm text-muted-foreground">{SCAN_PHASES[scanPhase]?.label ?? "Finalizing..."}</span>
                  </motion.div>
                </AnimatePresence>

                <div className="mt-6 grid grid-cols-2 gap-3 text-left">
                  <div className="glass rounded-lg p-3">
                    <div className="text-lg font-bold text-foreground">{goals.length + people.length + values.length + 2}</div>
                    <div className="text-[10px] text-muted-foreground">Graph nodes created</div>
                  </div>
                  <div className="glass rounded-lg p-3">
                    <div className="text-lg font-bold text-foreground">{goals.length}</div>
                    <div className="text-[10px] text-muted-foreground">Goals tracked</div>
                  </div>
                  <div className="glass rounded-lg p-3">
                    <div className="text-lg font-bold text-foreground">{people.length}</div>
                    <div className="text-[10px] text-muted-foreground">Relationships mapped</div>
                  </div>
                  <div className="glass rounded-lg p-3">
                    <div className="text-lg font-bold text-foreground">{values.length}</div>
                    <div className="text-[10px] text-muted-foreground">Values defined</div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Step 6: FIRST INSIGHT — the "wow" moment */}
          {step === 6 && firstInsight && (
            <motion.div key="insight" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="space-y-6">
              <div className="glass rounded-xl p-8 border border-primary/20">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <span className="text-xs font-medium text-primary tracking-wider uppercase">Your First Insight</span>
                  <span className="ml-auto text-[10px] text-muted-foreground font-mono">{Math.round(insightConfidence * 100)}% confidence</span>
                </div>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{firstInsight}</p>
              </div>

              <div className="text-center">
                <p className="text-xs text-muted-foreground mb-4">This is just the beginning. Anchor gets smarter every time you use it.</p>
                <button onClick={() => navigate("/dashboard")}
                  className="bg-primary text-primary-foreground rounded-xl px-8 py-3 text-sm font-medium hover:bg-primary/90 inline-flex items-center gap-2">
                  <ArrowRight className="h-4 w-4" /> Go to Dashboard
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Navigation (steps 0-4 only) */}
        {step <= 4 && (
          <div className="flex justify-between mt-8">
            {step > 0 ? (
              <button onClick={() => setStep(step - 1)} className="flex items-center gap-1.5 glass rounded-lg px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
            ) : <div />}

            {step < 4 ? (
              <button onClick={() => setStep(step + 1)} className="flex items-center gap-1.5 bg-primary/20 text-primary rounded-lg px-5 py-2.5 text-sm font-medium hover:bg-primary/30">
                Next <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button onClick={startScan} disabled={saving}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...</> : <><Scan className="h-3.5 w-3.5" /> Scan & Launch</>}
              </button>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
