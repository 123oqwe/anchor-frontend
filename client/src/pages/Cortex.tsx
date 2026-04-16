import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Cpu, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Loader2, Zap, Eye, Image, Video, Mic, Volume2,
  Music, Box, Bot, Search, Trash2, Play, AlertCircle, type LucideIcon,
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
  decision: "Decision Agent",
  general_chat: "General Chat",
  react_execution: "Execution (ReAct)",
  twin_edit_learning: "Twin — Edit Learning",
  twin_result_learning: "Twin — Result Learning",
  morning_digest: "Morning Digest",
  weekly_reflection: "Weekly Reflection",
  deep_reasoning: "Deep Reasoning",
  image_generation: "Image Generation",
  video_generation: "Video Generation",
  speech_to_text: "Speech-to-Text",
  text_to_speech: "Text-to-Speech",
  music_generation: "Music Generation",
  sound_effects: "Sound Effects",
  voice_cloning: "Voice Cloning",
  avatar_generation: "Avatar Generation",
  three_d_generation: "3D Generation",
  embed: "Embeddings",
  vision_analysis: "Vision Analysis",
};

function ProviderRow({ provider, onChange }: { provider: any; onChange: () => void }) {
  const [expanded, setExpanded] = useState(false);
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
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete key for ${provider.name}?`)) return;
    await api.deleteProviderKey(provider.id);
    setTestResult(null);
    onChange();
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProvider(provider.id);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

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
        <div className="px-4 pb-4 border-t border-border/20 pt-3 space-y-3">
          {/* Key input */}
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 block">
              API Key {provider.keySource === "env" && <span className="text-blue-400">(currently from .env — UI entry will override)</span>}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && save()}
                placeholder={provider.active ? "Enter new key to replace…" : `${provider.envKey.toLowerCase().replace(/_/g, "-")}…`}
                className="flex-1 bg-white/5 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 border border-border/50 focus:outline-none focus:border-amber-400/50 font-mono"
              />
              <button
                onClick={save}
                disabled={!keyInput.trim() || saving}
                className="bg-amber-500/20 text-amber-400 rounded-lg px-4 py-2 text-xs font-medium hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
              </button>
            </div>
          </div>

          {/* Actions */}
          {provider.active && (
            <div className="flex gap-2">
              <button
                onClick={test}
                disabled={testing}
                className="flex items-center gap-1.5 glass rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
                {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                Test connection
              </button>
              {provider.keySource === "db" && (
                <button
                  onClick={remove}
                  className="flex items-center gap-1.5 glass rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-red-400 transition-colors">
                  <Trash2 className="h-3 w-3" />
                  Delete key
                </button>
              )}
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`rounded-lg px-3 py-2 text-xs ${testResult.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
              {testResult.ok ? (
                <>
                  <div className="flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="h-3 w-3" />
                    <span className="font-medium">Connection OK</span>
                    <span className="text-[10px] text-muted-foreground ml-auto font-mono">{testResult.latencyMs}ms</span>
                  </div>
                  <div className="text-[10px] font-mono opacity-70">Model: {testResult.model} → "{testResult.response}"</div>
                </>
              ) : (
                <div className="flex items-start gap-1.5">
                  <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span className="break-all">{testResult.error}</span>
                </div>
              )}
            </div>
          )}

          {/* Env key hint */}
          <div className="text-[10px] text-muted-foreground/60">
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

  const refresh = () => api.getCortexStatus().then(d => setData(d)).catch(() => {});

  useEffect(() => {
    api.getCortexStatus().then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
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

  // Group capabilities
  const capByType: Record<string, any[]> = {};
  for (const cap of capabilities) {
    const key = cap.capability;
    if (!capByType[key]) capByType[key] = [];
    capByType[key].push(cap);
  }

  return (
    <div className="min-h-screen dot-grid">
      <div className="px-8 pt-8 pb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-medium text-amber-400 tracking-wider uppercase">Cortex</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">AI Model Platform</h1>
          <p className="text-sm text-muted-foreground">Enter an API key → provider activates → routing updates automatically.</p>

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
        {/* Capabilities */}
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Capabilities</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {Object.entries(capByType).map(([capKey, tasks]) => {
              const meta = CAPABILITY_META[capKey] ?? { icon: Cpu, label: capKey, color: "text-muted-foreground" };
              const Icon = meta.icon;
              const anyActive = tasks.some((t: any) => t.active);
              return (
                <div key={capKey} className={`glass rounded-xl p-3 ${anyActive ? "border-amber-400/20" : "opacity-50"}`}>
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
                          <span className="text-[9px] text-amber-400 font-mono ml-auto truncate max-w-[80px]">
                            {t.availableModels[0].name}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
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
                  <Badge className={`text-[9px] w-fit ${meta ? `${meta.color} bg-white/5` : "text-muted-foreground bg-white/5"}`}>
                    {meta?.label ?? cap.capability}
                  </Badge>
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

        {/* Providers — interactive */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">Providers — click to add API key</h2>
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
    </div>
  );
}
