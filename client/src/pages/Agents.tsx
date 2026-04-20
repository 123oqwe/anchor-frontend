/**
 * Agents — create, manage, run custom agents + automations + skills.
 * Not a settings form. A conversational workspace.
 */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Plus, Play, Pause, Trash2, Edit3, Send, Clock,
  Zap, Loader2, ChevronDown, ChevronRight, X,
  MessageSquare, ThumbsUp, ThumbsDown, Sparkles,
  Download, Upload, GitBranch, AlertTriangle, Check, FileText,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const TRIGGER_TYPES = [
  { value: "manual", label: "Manual (chat)" },
  { value: "schedule", label: "On schedule (cron)" },
  { value: "file_change", label: "On file change" },
  { value: "git_commit", label: "On git commit" },
  { value: "email_received", label: "On email received" },
  { value: "calendar_upcoming", label: "Before calendar event" },
  { value: "node_status", label: "On graph node status change" },
  { value: "app_focused", label: "On app focus" },
  { value: "idle", label: "On idle" },
];

function triggerConfigPlaceholder(type: string): string {
  switch (type) {
    case "file_change": return `{"pattern": "/path/or/substring"}`;
    case "git_commit": return `{"repo_pattern": "repo-name", "message_pattern": "fix"}`;
    case "email_received": return `{"from_pattern": "boss@", "subject_pattern": "urgent"}`;
    case "calendar_upcoming": return `{"minutes_before": 30}`;
    case "node_status": return `{"from": "active", "to": "blocked"}`;
    case "app_focused": return `{"app": "Slack"}`;
    case "idle": return `{"min_idle_minutes": 60}`;
    default: return `{}`;
  }
}

const AVAILABLE_TOOLS = [
  "web_search", "read_url", "send_email", "create_calendar_event", "create_reminder",
  "open_url", "execute_code", "write_task", "update_graph_node",
  "read_file", "diff_file", "search_codebase", "git_status", "git_diff", "git_log",
  "run_safe_shell", "run_tests", "read_logs",
  "agent_state_get", "agent_state_set", "delegate",
];

const fade = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } };

export default function Agents() {
  const [agents, setAgents] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [crons, setCrons] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [skillTemplates, setSkillTemplates] = useState<any[]>([]);
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [proposals, setProposals] = useState<any[]>([]);
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

  // Edit (extended with trigger + tools)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editTools, setEditTools] = useState<string[]>([]);
  const [editTriggerType, setEditTriggerType] = useState<string>("manual");
  const [editTriggerConfig, setEditTriggerConfig] = useState<string>("{}");

  // Pipeline creation
  const [newPipelineName, setNewPipelineName] = useState("");
  const [newPipelineSteps, setNewPipelineSteps] = useState<{ agent_id: string; input_template: string; output_key: string }[]>([]);
  const [pipelineInput, setPipelineInput] = useState<Record<string, string>>({});
  const [runningPipelineId, setRunningPipelineId] = useState<string | null>(null);

  // Import
  const importRef = useRef<HTMLInputElement>(null);

  const loadAll = async () => {
    const [ag, tpl, cr, sk, skTpl, pl, pr] = await Promise.all([
      api.getCustomAgents().catch(() => []),
      api.getAgentTemplates().catch(() => []),
      api.getCrons().catch(() => []),
      api.getSkills().catch(() => []),
      api.getSkillTemplates().catch(() => []),
      api.getPipelines().catch(() => []),
      api.getProposals().catch(() => []),
    ]);
    setAgents(ag); setTemplates(tpl); setCrons(cr);
    setSkills(Array.isArray(sk) ? sk : []); setSkillTemplates(Array.isArray(skTpl) ? skTpl : []);
    setPipelines(Array.isArray(pl) ? pl : []);
    setProposals(Array.isArray(pr) ? pr : []);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, []);

  // Auto-refresh proposals every 10s so user sees new pending items without reload
  useEffect(() => {
    const interval = setInterval(() => {
      api.getProposals().then(p => setProposals(Array.isArray(p) ? p : [])).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

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
    let parsedConfig = {};
    try { parsedConfig = JSON.parse(editTriggerConfig || "{}"); } catch {
      toast.error("Trigger config must be valid JSON"); return;
    }
    await api.updateCustomAgent(id, {
      name: editName,
      instructions: editInstructions,
      tools: editTools,
      trigger_type: editTriggerType,
      trigger_config: parsedConfig,
    });
    setEditingId(null);
    toast.success("Updated");
    loadAll();
  };

  const startEdit = (a: any) => {
    setEditingId(a.id);
    setEditName(a.name);
    setEditInstructions(a.instructions);
    setEditTools(Array.isArray(a.tools) ? a.tools : []);
    setEditTriggerType(a.trigger_type ?? "manual");
    setEditTriggerConfig(JSON.stringify(a.trigger_config ?? {}, null, 2));
  };

  // Export agent to JSON file
  const handleExport = async (agent: any) => {
    try {
      const data = await api.exportCustomAgent(agent.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${agent.name.replace(/\s+/g, "-").toLowerCase()}.anchor-agent.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Exported");
    } catch { toast.error("Export failed"); }
  };

  // Import agent from JSON
  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await api.importCustomAgent(data);
      toast.success(res.renamed ? `Imported as "${res.name}" (name collision)` : `Imported "${res.name}"`);
      loadAll();
    } catch (e: any) { toast.error(`Import failed: ${e.message}`); }
  };

  // Pipelines
  const handleCreatePipeline = async () => {
    if (!newPipelineName.trim() || newPipelineSteps.length === 0) {
      toast.error("Pipeline needs a name and at least one step"); return;
    }
    try {
      await api.createPipeline({ name: newPipelineName, steps: newPipelineSteps });
      toast.success("Pipeline created");
      setNewPipelineName(""); setNewPipelineSteps([]);
      loadAll();
    } catch (e: any) { toast.error(`Failed: ${e.message}`); }
  };

  const handleRunPipeline = async (id: string) => {
    const input = pipelineInput[id]?.trim();
    if (!input) { toast.error("Enter an input first"); return; }
    setRunningPipelineId(id);
    try {
      const res = await api.runPipeline(id, input);
      toast.success(`Pipeline completed (${res.stepResults?.length ?? 0} steps, $${res.totalCost?.toFixed(4) ?? "0"})`);
    } catch (e: any) { toast.error(`Pipeline failed: ${e.message}`); }
    setRunningPipelineId(null);
  };

  // Proposals
  const handleApproveProposal = async (id: string) => {
    try { await api.approveProposal(id); toast.success("Written to disk"); loadAll(); }
    catch (e: any) { toast.error(`Failed: ${e.message}`); }
  };
  const handleRejectProposal = async (id: string) => {
    try { await api.rejectProposal(id); toast.success("Rejected"); loadAll(); }
    catch (e: any) { toast.error(`Failed: ${e.message}`); }
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
            <h1 className="text-2xl font-bold flex-1">Agents</h1>
            <input ref={importRef} type="file" accept=".json" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); if (e.target) e.target.value = ""; }} />
            <button onClick={() => importRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Upload className="h-3 w-3" /> Import
            </button>
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

                    {/* Trigger type */}
                    <div>
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Trigger</label>
                      <select value={editTriggerType} onChange={e => setEditTriggerType(e.target.value)}
                        className="w-full glass rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none mt-1">
                        {TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>

                    {/* Trigger config (JSON) — only show for non-manual */}
                    {editTriggerType !== "manual" && editTriggerType !== "schedule" && (
                      <div>
                        <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Trigger Config (JSON)</label>
                        <textarea value={editTriggerConfig} onChange={e => setEditTriggerConfig(e.target.value)} rows={3}
                          placeholder={triggerConfigPlaceholder(editTriggerType)}
                          className="w-full glass rounded-lg px-3 py-1.5 text-[11px] text-foreground focus:outline-none resize-none font-mono mt-1" />
                      </div>
                    )}

                    {/* Tools whitelist */}
                    <div>
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Tools ({editTools.length} selected)</label>
                      <div className="grid grid-cols-2 gap-1 mt-1 max-h-32 overflow-y-auto">
                        {AVAILABLE_TOOLS.map(tool => (
                          <label key={tool} className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                            <input type="checkbox" checked={editTools.includes(tool)}
                              onChange={e => setEditTools(e.target.checked ? [...editTools, tool] : editTools.filter(t => t !== tool))}
                              className="h-3 w-3" />
                            <span className="font-mono">{tool}</span>
                          </label>
                        ))}
                      </div>
                    </div>

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
                      {a.trigger_type && a.trigger_type !== "manual" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-mono">{a.trigger_type}</span>
                      )}
                      <button onClick={() => handleExport(a)} className="text-muted-foreground/40 hover:text-foreground" title="Export"><Download className="h-3 w-3" /></button>
                      <button onClick={() => startEdit(a)} className="text-muted-foreground/40 hover:text-foreground" title="Edit"><Edit3 className="h-3 w-3" /></button>
                      <button onClick={async () => { await api.deleteCustomAgent(a.id); loadAll(); toast.success("Deleted"); }} className="text-muted-foreground/40 hover:text-red-400" title="Delete"><Trash2 className="h-3 w-3" /></button>
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-3 line-clamp-2">{a.instructions}</p>
                    {Array.isArray(a.tools) && a.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {a.tools.slice(0, 5).map((t: string) => <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono">{t}</span>)}
                        {a.tools.length > 5 && <span className="text-[9px] text-muted-foreground">+{a.tools.length - 5}</span>}
                      </div>
                    )}

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

        {/* -- PENDING PROPOSALS (human-in-loop file writes) ---- */}
        {proposals.filter((p: any) => p.status === "pending").length > 0 && (
          <motion.div {...fade} transition={{ delay: 0.16 }} className="mb-10">
            <h2 className="text-xs font-medium tracking-widest uppercase mb-4 text-amber-400 flex items-center gap-2">
              <AlertTriangle className="h-3 w-3" /> Pending Proposals
              <span className="text-[10px] text-muted-foreground normal-case tracking-normal">agents need your approval before writing</span>
            </h2>
            <div className="space-y-2">
              {proposals.filter((p: any) => p.status === "pending").map((p: any) => (
                <div key={p.id} className="glass rounded-xl p-4 border border-amber-500/20">
                  <div className="flex items-start gap-3">
                    <FileText className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-mono text-foreground truncate">{p.path}</span>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">{p.after_bytes}B</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        by <span className="text-primary">{p.agent_name ?? "agent"}</span> · {new Date(p.created_at).toLocaleTimeString()}
                      </p>
                    </div>
                    <button onClick={() => handleApproveProposal(p.id)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs hover:bg-emerald-500/20">
                      <Check className="h-3 w-3" /> Approve
                    </button>
                    <button onClick={() => handleRejectProposal(p.id)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-muted-foreground hover:text-red-400 text-xs">
                      <X className="h-3 w-3" /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* -- PIPELINES ---- */}
        <motion.div {...fade} transition={{ delay: 0.17 }} className="mb-10">
          <h2 className="text-xs font-medium text-muted-foreground/60 tracking-widest uppercase mb-4 flex items-center gap-2">
            <GitBranch className="h-3 w-3" /> Pipelines
            <span className="normal-case tracking-normal text-muted-foreground/40">chain agents into multi-step flows</span>
          </h2>
          <div className="glass rounded-xl p-5">

            {/* Existing pipelines */}
            {pipelines.length > 0 && (
              <div className="space-y-3 mb-4">
                {pipelines.map((p: any) => (
                  <div key={p.id} className="glass rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <GitBranch className="h-3.5 w-3.5 text-cyan-400" />
                      <span className="text-sm font-medium text-foreground flex-1">{p.name}</span>
                      <span className="text-[10px] text-muted-foreground">{p.steps.length} steps</span>
                      <button onClick={async () => { await api.deletePipeline(p.id); loadAll(); toast.success("Deleted"); }}
                        className="text-muted-foreground/30 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                    </div>
                    <div className="flex flex-wrap gap-1 mb-2">
                      {p.steps.map((s: any, i: number) => {
                        const stepAgent = agents.find((a: any) => a.id === s.agent_id);
                        return (
                          <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400">
                            {i + 1}. {stepAgent?.name ?? s.agent_id.slice(0, 6)} → {s.output_key}
                          </span>
                        );
                      })}
                    </div>
                    <div className="flex gap-2">
                      <input value={pipelineInput[p.id] ?? ""} onChange={e => setPipelineInput({ ...pipelineInput, [p.id]: e.target.value })}
                        onKeyDown={e => e.key === "Enter" && handleRunPipeline(p.id)}
                        placeholder="Pipeline input (feeds step 1 via {__input__})"
                        className="flex-1 glass rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none" />
                      <button onClick={() => handleRunPipeline(p.id)} disabled={runningPipelineId === p.id}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 text-xs disabled:opacity-50">
                        {runningPipelineId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Pipeline builder */}
            <div className="border-t border-white/5 pt-3">
              <input value={newPipelineName} onChange={e => setNewPipelineName(e.target.value)}
                placeholder="New pipeline name..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none mb-2" />

              {newPipelineSteps.map((step, i) => (
                <div key={i} className="flex gap-2 mb-2 items-center">
                  <span className="text-[10px] text-muted-foreground font-mono w-6">{i + 1}.</span>
                  <select value={step.agent_id} onChange={e => {
                    const next = [...newPipelineSteps]; next[i] = { ...step, agent_id: e.target.value }; setNewPipelineSteps(next);
                  }} className="glass rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none">
                    <option value="">— pick agent —</option>
                    {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <input value={step.input_template} onChange={e => {
                    const next = [...newPipelineSteps]; next[i] = { ...step, input_template: e.target.value }; setNewPipelineSteps(next);
                  }} placeholder="{__input__} or {step_0.output}"
                    className="flex-1 glass rounded-lg px-2 py-1 text-[11px] text-foreground font-mono focus:outline-none" />
                  <input value={step.output_key} onChange={e => {
                    const next = [...newPipelineSteps]; next[i] = { ...step, output_key: e.target.value }; setNewPipelineSteps(next);
                  }} placeholder="output_key"
                    className="w-24 glass rounded-lg px-2 py-1 text-[11px] text-foreground font-mono focus:outline-none" />
                  <button onClick={() => setNewPipelineSteps(newPipelineSteps.filter((_, idx) => idx !== i))}
                    className="text-muted-foreground/30 hover:text-red-400"><X className="h-3 w-3" /></button>
                </div>
              ))}

              <div className="flex gap-2">
                <button onClick={() => setNewPipelineSteps([...newPipelineSteps, { agent_id: "", input_template: "{__input__}", output_key: `step_${newPipelineSteps.length}` }])}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg glass text-xs text-muted-foreground hover:text-foreground">
                  <Plus className="h-3 w-3" /> Add step
                </button>
                {newPipelineSteps.length > 0 && newPipelineName.trim() && (
                  <button onClick={handleCreatePipeline}
                    className="px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 text-xs font-medium">
                    Save pipeline
                  </button>
                )}
              </div>
            </div>
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
