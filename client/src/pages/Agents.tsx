/**
 * Agents — create, manage, run custom agents + automations + skills.
 * Not a settings form. A conversational workspace.
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Plus, Play, Pause, Trash2, Edit3, Send, Clock,
  Zap, Loader2, ChevronDown, ChevronRight, X,
  MessageSquare, ThumbsUp, ThumbsDown, Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const fade = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } };

export default function Agents() {
  const [agents, setAgents] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [crons, setCrons] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [skillTemplates, setSkillTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Agent creation
  const [createInput, setCreateInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<any>(null);

  // Cron creation
  const [cronInput, setCronInput] = useState("");
  const [creatingCron, setCreatingCron] = useState(false);
  const [cronPreview, setCronPreview] = useState<any>(null);

  // Agent chat
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatResult, setChatResult] = useState<string | null>(null);
  const [chatting, setChatting] = useState(false);

  // Edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editInstructions, setEditInstructions] = useState("");

  const loadAll = async () => {
    const [ag, tpl, cr, sk, skTpl] = await Promise.all([
      api.getCustomAgents().catch(() => []),
      api.getAgentTemplates().catch(() => []),
      api.getCrons().catch(() => []),
      api.getSkills().catch(() => []),
      api.getSkillTemplates().catch(() => []),
    ]);
    setAgents(ag); setTemplates(tpl); setCrons(cr);
    setSkills(Array.isArray(sk) ? sk : []); setSkillTemplates(Array.isArray(skTpl) ? skTpl : []);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, []);

  // Natural language -> agent config
  const handleGenerate = async () => {
    if (!createInput.trim()) return;
    setCreating(true);
    try {
      const config = await api.generateAgentFromDescription(createInput);
      setPreview(config);
    } catch { toast.error("Failed to generate agent config"); }
    setCreating(false);
  };

  const handleConfirmCreate = async () => {
    if (!preview) return;
    await api.createCustomAgent({
      name: preview.name,
      instructions: preview.instructions,
      tools: preview.tools ?? [],
    });
    // If schedule suggested, create cron too
    if (preview.suggestedSchedule?.pattern) {
      await api.createCron({
        name: `Auto: ${preview.name}`,
        cron_pattern: preview.suggestedSchedule.pattern,
        action_type: "run_agent",
        action_config: { agent_name: preview.name },
      });
    }
    toast.success(`Agent "${preview.name}" created`);
    setPreview(null); setCreateInput("");
    loadAll();
  };

  // Natural language -> cron config
  const handleGenerateCron = async () => {
    if (!cronInput.trim()) return;
    setCreatingCron(true);
    try {
      const config = await api.generateCronFromDescription(cronInput);
      setCronPreview(config);
    } catch { toast.error("Failed to generate automation"); }
    setCreatingCron(false);
  };

  const handleConfirmCron = async () => {
    if (!cronPreview) return;
    await api.createCron({
      name: cronPreview.name,
      cron_pattern: cronPreview.cron_pattern,
      action_type: cronPreview.action_type ?? "remind",
      action_config: cronPreview.action_config ?? {},
    });
    toast.success(`Automation "${cronPreview.name}" created`);
    setCronPreview(null); setCronInput("");
    loadAll();
  };

  // Chat with agent
  const handleChat = async (agentId: string) => {
    if (!chatInput.trim() || chatting) return;
    setChatting(true); setChatResult(null);
    try {
      const res = await api.runCustomAgent(agentId, chatInput);
      setChatResult(res.content);
      setChatInput("");
    } catch { toast.error("Agent failed"); }
    setChatting(false);
  };

  // Save edit
  const handleSaveEdit = async (id: string) => {
    await api.updateCustomAgent(id, { name: editName, instructions: editInstructions, tools: [] });
    setEditingId(null);
    toast.success("Updated");
    loadAll();
  };

  const installedAgentNames = new Set(agents.map((a: any) => a.name));
  const installedSkillNames = new Set(skills.map((s: any) => s.name));

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;

  return (
    <div className="min-h-screen dot-grid">
      <div className="max-w-3xl mx-auto px-6 pt-10 pb-20">

        <motion.div {...fade}>
          <div className="flex items-center gap-2 mb-1">
            <Bot className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold">Agents</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-8">Create specialized AI agents, automations, and skills. Describe what you need in plain language.</p>
        </motion.div>

        {/* -- MY AGENTS ---- */}
        <motion.div {...fade} transition={{ delay: 0.05 }} className="mb-10">
          <h2 className="text-xs font-medium text-muted-foreground/60 tracking-widest uppercase mb-4">My Agents</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            {agents.map((a: any) => (
              <div key={a.id} className="glass rounded-xl p-4">
                {editingId === a.id ? (
                  <div className="space-y-2">
                    <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full glass rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none" />
                    <textarea value={editInstructions} onChange={e => setEditInstructions(e.target.value)} rows={3} className="w-full glass rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none resize-none" />
                    <div className="flex gap-2">
                      <button onClick={() => handleSaveEdit(a.id)} className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-xs">Save</button>
                      <button onClick={() => setEditingId(null)} className="px-3 py-1 rounded-lg text-muted-foreground text-xs">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <Bot className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold text-foreground flex-1">{a.name}</span>
                      <button onClick={() => { setEditingId(a.id); setEditName(a.name); setEditInstructions(a.instructions); }} className="text-muted-foreground/40 hover:text-foreground"><Edit3 className="h-3 w-3" /></button>
                      <button onClick={async () => { await api.deleteCustomAgent(a.id); loadAll(); toast.success("Deleted"); }} className="text-muted-foreground/40 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-3 line-clamp-2">{a.instructions}</p>

                    {/* Chat toggle */}
                    {chatAgentId === a.id ? (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleChat(a.id)}
                            placeholder="Ask this agent..." autoFocus
                            className="flex-1 glass rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none" />
                          <button onClick={() => handleChat(a.id)} disabled={chatting}
                            className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50">
                            {chatting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                          </button>
                          <button onClick={() => { setChatAgentId(null); setChatResult(null); }} className="text-muted-foreground"><X className="h-3 w-3" /></button>
                        </div>
                        {chatResult && (
                          <div className="p-3 bg-primary/5 rounded-lg">
                            <p className="text-xs text-muted-foreground whitespace-pre-line">{chatResult}</p>
                            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
                              <span className="text-[10px] text-muted-foreground/40">Helpful?</span>
                              <button onClick={() => { api.feedbackCustomAgent(a.id, "good", chatResult.slice(0, 100)); toast.success("Thanks!"); }}
                                className="p-1 rounded hover:bg-emerald-500/10 text-muted-foreground/40 hover:text-emerald-400"><ThumbsUp className="h-3 w-3" /></button>
                              <button onClick={() => { api.feedbackCustomAgent(a.id, "bad", chatResult.slice(0, 100)); toast.success("Noted"); }}
                                className="p-1 rounded hover:bg-red-500/10 text-muted-foreground/40 hover:text-red-400"><ThumbsDown className="h-3 w-3" /></button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <button onClick={() => { setChatAgentId(a.id); setChatResult(null); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors">
                        <MessageSquare className="h-3 w-3" /> Chat
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}

            {agents.length === 0 && (
              <div className="glass rounded-xl p-6 col-span-2 text-center">
                <Bot className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No agents yet. Create one below or install a template.</p>
              </div>
            )}
          </div>

          {/* Templates */}
          {templates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {templates.map((t: any, i: number) => (
                <button key={t.name} disabled={installedAgentNames.has(t.name)}
                  onClick={async () => { await api.installAgentTemplate(i); loadAll(); toast.success(`${t.name} installed`); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    installedAgentNames.has(t.name) ? "glass text-emerald-400/60 cursor-default" : "glass text-primary hover:bg-primary/10"
                  }`}>
                  <Bot className="h-3 w-3" />
                  {t.name}
                  {installedAgentNames.has(t.name) && <span className="text-[9px]">installed</span>}
                </button>
              ))}
            </div>
          )}
        </motion.div>

        {/* -- CREATE AGENT (natural language) ---- */}
        <motion.div {...fade} transition={{ delay: 0.1 }} className="mb-10">
          <h2 className="text-xs font-medium text-muted-foreground/60 tracking-widest uppercase mb-4">Create Agent</h2>
          <div className="glass rounded-xl p-5">
            <div className="flex gap-2 mb-3">
              <input value={createInput} onChange={e => setCreateInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleGenerate()}
                placeholder="Describe what you need... e.g. &quot;Someone to analyze my competitors every week&quot;"
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none" />
              <button onClick={handleGenerate} disabled={creating || !createInput.trim()}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Sparkles className="h-3 w-3 inline mr-1" />Generate</>}
              </button>
            </div>

            {/* Preview */}
            <AnimatePresence>
              {preview && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  className="border-t border-white/5 pt-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold text-foreground">{preview.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{preview.instructions}</p>
                  {preview.tools?.length > 0 && (
                    <div className="flex gap-1">
                      {preview.tools.map((t: string) => <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono">{t}</span>)}
                    </div>
                  )}
                  {preview.suggestedSchedule && (
                    <div className="flex items-center gap-2 text-xs text-amber-400">
                      <Clock className="h-3 w-3" />
                      <span>Suggested: {preview.suggestedSchedule.description}</span>
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button onClick={handleConfirmCreate} className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium">Create Agent</button>
                    <button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-lg text-muted-foreground text-xs">Cancel</button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* -- AUTOMATIONS ---- */}
        <motion.div {...fade} transition={{ delay: 0.15 }} className="mb-10">
          <h2 className="text-xs font-medium text-muted-foreground/60 tracking-widest uppercase mb-4">Automations</h2>
          <div className="glass rounded-xl p-5">
            {crons.length > 0 && (
              <div className="space-y-2 mb-4">
                {crons.map((c: any) => (
                  <div key={c.id} className="flex items-center gap-3 py-1.5">
                    <Clock className={`h-3.5 w-3.5 ${c.enabled ? "text-amber-400" : "text-muted-foreground/30"}`} />
                    <span className="text-sm text-foreground flex-1">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{c.cron_pattern}</span>
                    <button onClick={async () => { await api.toggleCron(c.id); loadAll(); }}
                      className={`text-[10px] ${c.enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {c.enabled ? "Pause" : "Enable"}
                    </button>
                    <button onClick={async () => { await api.deleteCron(c.id); loadAll(); toast.success("Deleted"); }}
                      className="text-muted-foreground/30 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input value={cronInput} onChange={e => setCronInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleGenerateCron()}
                placeholder="Describe automation... e.g. &quot;Remind me to review goals every Friday at 6pm&quot;"
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none" />
              <button onClick={handleGenerateCron} disabled={creatingCron || !cronInput.trim()}
                className="px-4 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium hover:bg-amber-500/20 disabled:opacity-50">
                {creatingCron ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Clock className="h-3 w-3 inline mr-1" />Add</>}
              </button>
            </div>

            <AnimatePresence>
              {cronPreview && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  className="border-t border-white/5 pt-3 mt-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 text-amber-400" />
                    <span className="text-sm font-medium text-foreground">{cronPreview.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono ml-auto">{cronPreview.human_schedule}</span>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={handleConfirmCron} className="px-4 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium">Confirm</button>
                    <button onClick={() => setCronPreview(null)} className="px-3 py-1.5 rounded-lg text-muted-foreground text-xs">Cancel</button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* -- SKILLS ---- */}
        <motion.div {...fade} transition={{ delay: 0.2 }}>
          <h2 className="text-xs font-medium text-muted-foreground/60 tracking-widest uppercase mb-4">Skills</h2>
          <div className="glass rounded-xl p-5">
            {skills.length > 0 && (
              <div className="space-y-2 mb-4">
                {skills.map((s: any) => (
                  <div key={s.id} className="flex items-center gap-2 py-1">
                    <Zap className="h-3.5 w-3.5 text-cyan-400" />
                    <span className="text-sm text-foreground flex-1">{s.name}</span>
                    <span className="text-[10px] text-muted-foreground">{s.source ?? "template"}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">used {s.use_count ?? 0}x</span>
                  </div>
                ))}
              </div>
            )}
            {skills.length === 0 && (
              <p className="text-xs text-muted-foreground/40 mb-4">No skills yet. Install templates below or confirm 3+ similar plans to auto-learn.</p>
            )}

            {/* Skill templates */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
              {skillTemplates.map((t: any, i: number) => (
                <button key={t.name} disabled={installedSkillNames.has(t.name)}
                  onClick={async () => { await api.installSkillTemplate(i); loadAll(); toast.success(`${t.name} installed`); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    installedSkillNames.has(t.name) ? "glass text-emerald-400/60 cursor-default" : "glass text-cyan-400 hover:bg-cyan-500/10"
                  }`}>
                  <Zap className="h-3 w-3" />
                  {t.name}
                  {installedSkillNames.has(t.name) && <span className="text-[9px]">installed</span>}
                </button>
              ))}
            </div>
          </div>
        </motion.div>

      </div>
    </div>
  );
}
