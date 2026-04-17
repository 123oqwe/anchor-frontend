/**
 * L7 — Onboarding: Guided setup that actually creates the user's Human Graph.
 * 4 steps: Identity → Goals → People → Preferences
 * Each step writes real data to the backend. No fake scans.
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  Anchor, ArrowRight, ArrowLeft, User, Target, Users,
  Zap, CheckCircle2, Sparkles, Plus, X,
} from "lucide-react";
import { api } from "@/lib/api";

const STEPS = ["Welcome", "About You", "Your Goals", "Key People", "Preferences"];

export default function Onboarding() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 1: Identity
  const [name, setName] = useState("");
  const [role, setRole] = useState("");

  // Step 2: Goals (dynamic list)
  const [goals, setGoals] = useState<{ text: string; domain: string }[]>([]);
  const [goalInput, setGoalInput] = useState("");
  const [goalDomain, setGoalDomain] = useState("work");

  // Step 3: People
  const [people, setPeople] = useState<{ name: string; relationship: string }[]>([]);
  const [personName, setPersonName] = useState("");
  const [personRel, setPersonRel] = useState("");

  // Step 4: Preferences
  const [commPref, setCommPref] = useState("email");
  const [peakTime, setPeakTime] = useState("morning");
  const [values, setValues] = useState<string[]>([]);
  const [valueInput, setValueInput] = useState("");

  const addGoal = () => {
    if (!goalInput.trim()) return;
    setGoals([...goals, { text: goalInput.trim(), domain: goalDomain }]);
    setGoalInput("");
  };

  const addPerson = () => {
    if (!personName.trim()) return;
    setPeople([...people, { name: personName.trim(), relationship: personRel || "contact" }]);
    setPersonName(""); setPersonRel("");
  };

  const addValue = () => {
    if (!valueInput.trim()) return;
    setValues([...values, valueInput.trim()]);
    setValueInput("");
  };

  const finish = async () => {
    setSaving(true);
    try {
      // Save identity
      if (name) await api.updateProfile({ name, role });

      // Save goals as graph nodes
      for (const g of goals) {
        await api.createNode({ domain: g.domain, label: g.text, type: "goal", status: "active", captured: "Onboarding", detail: `Goal set during onboarding: ${g.text}` });
      }

      // Save people as graph nodes
      for (const p of people) {
        await api.createNode({ domain: "relationships", label: p.name, type: "person", status: "active", captured: "Onboarding", detail: `${p.relationship}` });
      }

      // Save preferences as graph nodes
      if (commPref) {
        await api.createNode({ domain: "growth", label: `Prefers ${commPref}`, type: "preference", status: "stable", captured: "Onboarding", detail: `Communication preference: ${commPref}` });
      }
      if (peakTime) {
        await api.createNode({ domain: "growth", label: `Peak: ${peakTime}`, type: "preference", status: "stable", captured: "Onboarding", detail: `Most productive time: ${peakTime}` });
      }
      for (const v of values) {
        await api.createNode({ domain: "growth", label: v, type: "value", status: "stable", captured: "Onboarding", detail: `Core value: ${v}` });
      }

      navigate("/dashboard");
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg">

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Anchor className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Anchor Setup</h1>
            <p className="text-xs text-muted-foreground">Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>
          </div>
        </div>

        {/* Progress */}
        <div className="flex gap-1 mb-8">
          {STEPS.map((_, i) => (
            <div key={i} className={`flex-1 h-1 rounded-full ${i <= step ? "bg-primary" : "bg-white/10"}`} />
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* Step 0: Welcome */}
          {step === 0 && (
            <motion.div key="welcome" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              className="space-y-6">
              <div className="glass rounded-xl p-8 text-center">
                <Sparkles className="h-12 w-12 text-primary mx-auto mb-4" />
                <h2 className="text-2xl font-bold mb-2">Welcome to Anchor</h2>
                <p className="text-muted-foreground">Your personal AI decision operating system. Let's build your Human Graph — a living model of who you are, what you're pursuing, and how you operate.</p>
                <p className="text-xs text-muted-foreground mt-4">This takes about 2 minutes. Everything you enter becomes your graph.</p>
              </div>
            </motion.div>
          )}

          {/* Step 1: About You */}
          {step === 1 && (
            <motion.div key="identity" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><User className="h-4 w-4 text-primary" /><span className="text-sm font-medium">About You</span></div>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name"
                className="w-full glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/30" />
              <input value={role} onChange={e => setRole(e.target.value)} placeholder="Your role (e.g. Founder, Engineer, Student)"
                className="w-full glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/30" />
            </motion.div>
          )}

          {/* Step 2: Goals */}
          {step === 2 && (
            <motion.div key="goals" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><Target className="h-4 w-4 text-primary" /><span className="text-sm font-medium">What are you working toward?</span></div>
              <div className="flex gap-2">
                <input value={goalInput} onChange={e => setGoalInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addGoal()} placeholder="e.g. Launch MVP by June"
                  className="flex-1 glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                <select value={goalDomain} onChange={e => setGoalDomain(e.target.value)}
                  className="glass rounded-lg px-3 py-3 text-xs text-foreground bg-transparent">
                  <option value="work">Work</option><option value="finance">Finance</option>
                  <option value="health">Health</option><option value="growth">Growth</option>
                  <option value="relationships">Relationships</option>
                </select>
                <button onClick={addGoal} className="glass rounded-lg px-3 py-3 text-primary hover:bg-primary/10"><Plus className="h-4 w-4" /></button>
              </div>
              <div className="space-y-1.5">
                {goals.map((g, i) => (
                  <div key={i} className="glass rounded-lg px-3 py-2 flex items-center justify-between text-sm">
                    <span className="text-foreground">{g.text} <span className="text-[10px] text-muted-foreground">({g.domain})</span></span>
                    <button onClick={() => setGoals(goals.filter((_, j) => j !== i))}><X className="h-3 w-3 text-muted-foreground" /></button>
                  </div>
                ))}
              </div>
              {goals.length === 0 && <p className="text-xs text-muted-foreground">Add at least one goal to get started.</p>}
            </motion.div>
          )}

          {/* Step 3: People */}
          {step === 3 && (
            <motion.div key="people" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><Users className="h-4 w-4 text-primary" /><span className="text-sm font-medium">Key people in your life</span></div>
              <div className="flex gap-2">
                <input value={personName} onChange={e => setPersonName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addPerson()} placeholder="Name"
                  className="flex-1 glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                <input value={personRel} onChange={e => setPersonRel(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addPerson()} placeholder="Relationship (co-founder, investor...)"
                  className="flex-1 glass rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                <button onClick={addPerson} className="glass rounded-lg px-3 py-3 text-primary hover:bg-primary/10"><Plus className="h-4 w-4" /></button>
              </div>
              <div className="space-y-1.5">
                {people.map((p, i) => (
                  <div key={i} className="glass rounded-lg px-3 py-2 flex items-center justify-between text-sm">
                    <span className="text-foreground">{p.name} <span className="text-[10px] text-muted-foreground">({p.relationship})</span></span>
                    <button onClick={() => setPeople(people.filter((_, j) => j !== i))}><X className="h-3 w-3 text-muted-foreground" /></button>
                  </div>
                ))}
              </div>
              {people.length === 0 && <p className="text-xs text-muted-foreground">Optional — you can add people later through conversations.</p>}
            </motion.div>
          )}

          {/* Step 4: Preferences */}
          {step === 4 && (
            <motion.div key="prefs" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              className="space-y-4">
              <div className="flex items-center gap-2 mb-2"><Zap className="h-4 w-4 text-primary" /><span className="text-sm font-medium">How do you operate?</span></div>

              <div>
                <label className="text-xs text-muted-foreground">Communication preference</label>
                <div className="flex gap-2 mt-1">
                  {["email", "slack", "phone", "in-person"].map(opt => (
                    <button key={opt} onClick={() => setCommPref(opt)}
                      className={`glass rounded-lg px-3 py-2 text-xs ${commPref === opt ? "bg-primary/10 text-primary border-primary/30" : "text-muted-foreground"}`}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground">Peak productivity time</label>
                <div className="flex gap-2 mt-1">
                  {["early morning", "morning", "afternoon", "evening", "night"].map(opt => (
                    <button key={opt} onClick={() => setPeakTime(opt)}
                      className={`glass rounded-lg px-3 py-2 text-xs ${peakTime === opt ? "bg-primary/10 text-primary border-primary/30" : "text-muted-foreground"}`}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground">What do you value most? (add as many as you want)</label>
                <div className="flex gap-2 mt-1">
                  <input value={valueInput} onChange={e => setValueInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addValue()} placeholder="e.g. Family, Honesty, Impact..."
                    className="flex-1 glass rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
                  <button onClick={addValue} className="glass rounded-lg px-3 py-2 text-primary hover:bg-primary/10"><Plus className="h-4 w-4" /></button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {values.map((v, i) => (
                    <span key={i} className="glass rounded-full px-3 py-1 text-xs text-foreground flex items-center gap-1">
                      {v} <button onClick={() => setValues(values.filter((_, j) => j !== i))}><X className="h-2.5 w-2.5 text-muted-foreground" /></button>
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Navigation */}
        <div className="flex justify-between mt-8">
          {step > 0 ? (
            <button onClick={() => setStep(step - 1)} className="flex items-center gap-1.5 glass rounded-lg px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
          ) : <div />}

          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(step + 1)} className="flex items-center gap-1.5 bg-primary/20 text-primary rounded-lg px-5 py-2.5 text-sm font-medium hover:bg-primary/30">
              Next <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button onClick={finish} disabled={saving}
              className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {saving ? "Setting up..." : <><CheckCircle2 className="h-3.5 w-3.5" /> Launch Anchor</>}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
