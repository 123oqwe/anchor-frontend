import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Cpu, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Loader2, Zap, Eye, Image, Video, Mic, Volume2,
  Music, Box, Bot, Search, Trash2, Play, AlertCircle, X, type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

const CAPABILITY_META: Record<string, { icon: LucideIcon; label: string; color: string }> = {
  text:        { icon: Bot,      label: "Text LLM",        color: "text-blue-400" },
  reasoning:   { icon: Zap,      label: "Reasoning",       color: "text-amber-400" },
  vision:      { icon: Eye,      label: "Vision",          color: "text-purple-400" },
  image_gen:   { icon: Image,    label: "Image Gen",       color: "text-pink-400" },
  video_gen:   { icon: Video,    label: "Video Gen",       color: "text-rose-400" },
  stt:         { icon: Mic,      label: "Speech-to-Text",  color: "text-emerald-400" },
  tts:         { icon: Volume2,  label: "Text-to-Speech",  color: "text-teal-400" },
  music:       { icon: Music,    label: "Music",           color: "text-indigo-400" },
  sound_fx:    { icon: Volume2,  label: "Sound FX",        color: "text-cyan-400" },
  voice_clone: { icon: Mic,      label: "Voice Clone",     color: "text-orange-400" },
  embeddings:  { icon: Search,   label: "Embeddings",      color: "text-sky-400" },
  avatar:      { icon: Bot,      label: "Avatar",          color: "text-violet-400" },
  "3d_gen":    { icon: Box,      label: "3D Generation",   color: "text-lime-400" },
};

const TASK_LABELS: Record<string, string> = {
  decision: "Decision Agent", general_chat: "General Chat", react_execution: "Execution (ReAct)",
  twin_edit_learning: "Twin — Edit Learning", twin_result_learning: "Twin — Result Learning",
  morning_digest: "Morning Digest", weekly_reflection: "Weekly Reflection", deep_reasoning: "Deep Reasoning",
  image_generation: "Image Generation", video_generation: "Video Generation", speech_to_text: "Speech-to-Text",
  text_to_speech: "Text-to-Speech", music_generation: "Music Generation", sound_effects: "Sound Effects",
  voice_cloning: "Voice Cloning", avatar_generation: "Avatar Generation", three_d_generation: "3D Generation",
  embed: "Embeddings", vision_analysis: "Vision Analysis",
};

// ── Inline provider key editor ──────────────────────────────────────────────

function InlineKeyEditor({ provider, onChange }: { provider: any; onChange: () => void }) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const save = async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    setTestResult(null);
    try {
      await api.setProviderKey(provider.id, keyInput.trim());
      setKeyInput("");
      onChange();
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm(`Delete key for ${provider.name}?`)) return;
    await api.deleteProviderKey(provider.id);
    setTestResult(null);
    onChange();
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await api.testProvider(provider.id);
      setTestResult(r);
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
    } finally { setTesting(false); }
  };

  return (
    <div className="space-y-2 py-2">
      <div className="flex gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={e => setKeyInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && save()}
          placeholder={provider.active ? "Replace key…" : `Paste ${provider.envKey.toLowerCase().replace(/_/g, "-")}`}
          className="flex-1 bg-white/5 rounded-md px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 border border-border/50 focus:outline-none focus:border-amber-400/50 font-mono"
        />
        <button onClick={save} disabled={!keyInput.trim() || saving}
          className="bg-amber-500/20 text-amber-400 rounded-md px-3 py-1.5 text-[11px] font-medium hover:bg-amber-500/30 disabled:opacity-40 transition-colors">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </button>
      </div>

      {provider.active && (
        <div className="flex gap-1.5">
          <button onClick={test} disabled={testing}
            className="flex items-center gap-1 glass rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
            {testing ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
            Test
          </button>
          {provider.keySource === "db" && (
            <button onClick={remove}
              className="flex items-center gap-1 glass rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-red-400 transition-colors">
              <Trash2 className="h-2.5 w-2.5" /> Delete
            </button>
          )}
        </div>
      )}

      {testResult && (
        <div className={`rounded-md px-2 py-1.5 text-[10px] ${testResult.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
          {testResult.ok ? (
            <span>✓ {testResult.model} · {testResult.latencyMs}ms</span>
          ) : (
            <span className="flex items-start gap-1"><AlertCircle className="h-2.5 w-2.5 mt-0.5 shrink-0" />{testResult.error?.slice(0, 100)}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Capability Detail Panel (opens on capability card click) ─────────────────

function CapabilityPanel({ capability, onClose, onChange }: { capability: string; onClose: () => void; onChange: () => void }) {
  const [roster, setRoster] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const load = async () => {
    const r = await api.getCapabilityRoster(capability);
    setRoster(r);
    setLoading(false);
  };

  useEffect(() => { load(); }, [capability]);

  const meta = CAPABILITY_META[capability];
  const Icon = meta?.icon ?? Cpu;

  return (
    <motion.div initial={{ opacity: 0, x: 400 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 400 }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
      className="fixed top-0 right-0 bottom-0 w-[480px] glass-strong border-l border-border/50 z-50 flex flex-col">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 p-5 border-b border-border/30">
        <div className={`w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center`}>
          <Icon className={`h-4 w-4 ${meta?.color ?? "text-muted-foreground"}`} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">{meta?.label ?? capability}</h3>
          <p className="text-[10px] text-muted-foreground">All providers & models</p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-md transition-colors">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-amber-400" /></div>
        ) : roster ? (
          <>
            {/* Summary */}
            <div className="glass rounded-lg p-3">
              <div className="flex items-center gap-4 text-xs">
                <div>
                  <div className="text-lg font-bold text-foreground">{roster.providers.length}</div>
                  <div className="text-[10px] text-muted-foreground">providers</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-foreground">{roster.models.length}</div>
                  <div className="text-[10px] text-muted-foreground">models</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-emerald-400">{roster.providers.filter((p: any) => p.active).length}</div>
                  <div className="text-[10px] text-muted-foreground">active</div>
                </div>
              </div>
            </div>

            {/* Providers list */}
            <div>
              <h4 className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Providers</h4>
              <div className="space-y-1.5">
                {roster.providers
                  .sort((a: any, b: any) => Number(b.active) - Number(a.active))
                  .map((p: any) => {
                    const providerModels = roster.models.filter((m: any) => m.providerId === p.id);
                    const isExp = expandedProvider === p.id;
                    return (
                      <div key={p.id} className={`glass rounded-lg overflow-hidden ${p.active ? "border-emerald-400/20" : ""}`}>
                        <button onClick={() => setExpandedProvider(isExp ? null : p.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] transition-colors">
                          {p.active ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />}
                          <span className={`text-xs font-medium flex-1 text-left ${p.active ? "text-foreground" : "text-muted-foreground"}`}>{p.name}</span>
                          <span className="text-[9px] text-muted-foreground">{providerModels.length} model{providerModels.length > 1 ? "s" : ""}</span>
                          {p.keyMasked && <code className="text-[9px] font-mono text-emerald-400/70">{p.keyMasked}</code>}
                          {isExp ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                        </button>

                        {isExp && (
                          <div className="px-3 pb-3 border-t border-border/20 pt-2 space-y-2">
                            {/* Models */}
                            <div className="space-y-0.5">
                              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Models</span>
                              {providerModels.map((m: any) => (
                                <div key={m.modelId} className="flex items-center gap-2 py-0.5">
                                  <div className={`w-1 h-1 rounded-full ${m.active ? "bg-emerald-400" : "bg-muted-foreground/20"}`} />
                                  <span className="text-[11px] text-foreground flex-1">{m.modelName}</span>
                                  <Badge className="text-[8px] bg-white/5 text-muted-foreground">{m.tier}</Badge>
                                </div>
                              ))}
                            </div>
                            {/* Key editor */}
                            <InlineKeyEditor provider={p} onChange={() => { load(); onChange(); }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          </>
        ) : (
          <p className="text-center text-muted-foreground text-sm">Failed to load</p>
        )}
      </div>
    </motion.div>
  );
}

// ── Standalone provider row (for main list) ─────────────────────────────────

function ProviderRow({ provider, onChange }: { provider: any; onChange: () => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors">
        {provider.active
          ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          : <XCircle className="h-4 w-4 text-muted-foreground/30 shrink-0" />}
        <span className={`text-sm font-medium flex-1 text-left ${provider.active ? "text-foreground" : "text-muted-foreground"}`}>
          {provider.name}
        </span>
        <div className="flex items-center gap-2">
          {provider.active && provider.keyMasked && (
            <code className="text-[10px] font-mono text-emerald-400/70">{provider.keyMasked}</code>
          )}
          {provider.keySource === "env" && <Badge className="text-[9px] bg-blue-500/10 text-blue-400">from .env</Badge>}
          {provider.keySource === "db" && <Badge className="text-[9px] bg-emerald-500/10 text-emerald-400">saved</Badge>}
          {provider.keySource === "none" && <Badge className="text-[9px] bg-white/5 text-muted-foreground/40">no key</Badge>}
          {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 border-t border-border/20 pt-2">
          <InlineKeyEditor provider={provider} onChange={onChange} />
          <div className="text-[9px] text-muted-foreground/60 mt-2">
            env var: <code className="bg-white/5 px-1 rounded font-mono">{provider.envKey}</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Cortex() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [selectedCapability, setSelectedCapability] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const d = await api.getCortexStatus();
      setData(d);
    } catch {}
  };

  useEffect(() => {
    (async () => {
      await refresh();
      setLoading(false);
    })();
    // Auto-refresh every 10s to keep status live
    refreshTimer.current = window.setInterval(refresh, 10000);
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, []);

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-amber-400" /></div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Failed to load</div>;

  const { activeProviders, providerSlots, capabilities } = data;
  const totalProviders = providerSlots.length;
  const activeCount = activeProviders.length;
  const totalCapabilities = capabilities.length;
  const activeCapabilities = capabilities.filter((c: any) => c.active).length;

  const filteredProviders = providerSlots.filter((p: any) => {
    if (filter === "active") return p.active;
    if (filter === "inactive") return !p.active;
    return true;
  });

  // Group capabilities by type
  const capByType: Record<string, any[]> = {};
  for (const cap of capabilities) {
    const key = cap.capability;
    if (!capByType[key]) capByType[key] = [];
    capByType[key].push(cap);
  }

  return (
    <div className="min-h-screen dot-grid relative">
      <div className="px-8 pt-8 pb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-medium text-amber-400 tracking-wider uppercase">Cortex</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">AI Model Platform</h1>
          <p className="text-sm text-muted-foreground">Click any capability to see all providers. Add keys inline — routing updates live.</p>

          <div className="flex gap-6 mt-4">
            <div className="glass rounded-xl px-4 py-3">
              <div className="text-2xl font-bold text-foreground">{activeCount}</div>
              <div className="text-[10px] text-muted-foreground">Active Providers</div>
            </div>
            <div className="glass rounded-xl px-4 py-3">
              <div className="text-2xl font-bold text-foreground">{totalProviders}</div>
              <div className="text-[10px] text-muted-foreground">Total Providers</div>
            </div>
            <div className="glass rounded-xl px-4 py-3">
              <div className="text-2xl font-bold text-foreground">{activeCapabilities}/{totalCapabilities}</div>
              <div className="text-[10px] text-muted-foreground">Capabilities Online</div>
            </div>
          </div>
        </motion.div>
      </div>

      <div className="px-8 pb-8 space-y-6">
        {/* Capabilities — now CLICKABLE */}
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Capabilities <span className="text-[10px] text-muted-foreground font-normal">· click to add providers</span></h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {Object.entries(capByType).map(([capKey, tasks]) => {
              const meta = CAPABILITY_META[capKey] ?? { icon: Cpu, label: capKey, color: "text-muted-foreground" };
              const Icon = meta.icon;
              const anyActive = tasks.some((t: any) => t.active);
              return (
                <motion.button key={capKey}
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  whileHover={{ y: -2 }} transition={{ duration: 0.15 }}
                  onClick={() => setSelectedCapability(capKey)}
                  className={`glass rounded-xl p-3 text-left cursor-pointer hover:bg-white/[0.07] transition-colors ${anyActive ? "border-amber-400/20" : ""} ${selectedCapability === capKey ? "ring-1 ring-amber-400/50" : ""}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className={`h-4 w-4 ${anyActive ? meta.color : "text-muted-foreground/50"}`} />
                    <span className="text-xs font-medium text-foreground">{meta.label}</span>
                    {anyActive
                      ? <CheckCircle2 className="h-3 w-3 text-emerald-400 ml-auto" />
                      : <XCircle className="h-3 w-3 text-muted-foreground/30 ml-auto" />}
                  </div>
                  <div className="space-y-1">
                    {tasks.map((t: any) => (
                      <div key={t.task} className="flex items-center gap-1.5">
                        <div className={`w-1 h-1 rounded-full ${t.active ? "bg-emerald-400" : "bg-muted-foreground/20"}`} />
                        <span className="text-[10px] text-muted-foreground truncate">{TASK_LABELS[t.task] ?? t.task}</span>
                        {t.active && t.availableModels?.[0] && (
                          <span className="text-[9px] text-amber-400 font-mono ml-auto truncate max-w-[80px]">{t.availableModels[0].name}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Task Routing */}
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Task Routing</h2>
          <div className="glass rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_100px_100px_1fr] gap-0 text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-2 border-b border-border/30">
              <span>Task</span><span>Capability</span><span>Tier</span><span>Routed To</span>
            </div>
            {capabilities.map((cap: any, i: number) => {
              const meta = CAPABILITY_META[cap.capability];
              return (
                <div key={cap.task} className={`grid grid-cols-[1fr_100px_100px_1fr] gap-0 px-4 py-2.5 text-sm items-center ${i % 2 === 0 ? "" : "bg-white/[0.02]"}`}>
                  <span className="text-foreground text-xs">{TASK_LABELS[cap.task] ?? cap.task}</span>
                  <button onClick={() => setSelectedCapability(cap.capability)}
                    className={`text-[9px] w-fit px-2 py-0.5 rounded ${meta ? `${meta.color} bg-white/5 hover:bg-white/10` : "text-muted-foreground bg-white/5"} transition-colors`}>
                    {meta?.label ?? cap.capability}
                  </button>
                  <span className="text-[10px] text-muted-foreground font-mono">{cap.preferredTier}</span>
                  {cap.active ? (
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      <span className="text-xs text-foreground">{cap.availableModels[0]?.name}</span>
                      <span className="text-[9px] text-muted-foreground">({cap.availableModels[0]?.provider})</span>
                      {cap.availableModels.length > 1 && (
                        <span className="text-[9px] text-muted-foreground/50">+{cap.availableModels.length - 1} fallback</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-red-400/50" />
                      <span className="text-xs text-muted-foreground">No provider</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Providers */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">Providers — all {totalProviders}</h2>
            <div className="flex gap-1.5">
              {(["all", "active", "inactive"] as const).map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${filter === f ? "bg-amber-500/10 text-amber-400" : "text-muted-foreground hover:text-foreground"}`}>
                  {f === "all" ? `All (${totalProviders})` : f === "active" ? `Active (${activeCount})` : `Inactive (${totalProviders - activeCount})`}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            {filteredProviders.map((p: any) => (
              <ProviderRow key={p.id} provider={p} onChange={refresh} />
            ))}
          </div>
        </div>
      </div>

      {/* Capability Detail Slide-out Panel */}
      <AnimatePresence>
        {selectedCapability && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setSelectedCapability(null)}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
            <CapabilityPanel
              capability={selectedCapability}
              onClose={() => setSelectedCapability(null)}
              onChange={refresh}
            />
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
