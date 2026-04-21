/**
 * Admin — Hooks Editor.
 *
 * CRUD for user_hooks. Shell commands + agent invocations wired to Anchor
 * internal events. Claude Code-inspired matcher pattern but simplified: JSON
 * key/value equality instead of regex, since Anchor events have structured
 * payloads already.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Webhook, Plus, Trash2, Save, Edit3, Loader2, RefreshCw, X,
  Terminal, Bot, Zap, Check,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const EVENTS = [
  { value: "agent_run_start",    label: "agent_run_start",    blurb: "A Custom Agent ReAct loop begins" },
  { value: "agent_run_end",      label: "agent_run_end",      blurb: "Custom Agent finishes (success or not)" },
  { value: "tool_call_success",  label: "tool_call_success",  blurb: "Any L5 tool completed successfully" },
  { value: "tool_call_failure",  label: "tool_call_failure",  blurb: "Any L5 tool returned an error" },
  { value: "job_succeeded",      label: "job_succeeded",      blurb: "Task Brain job completed" },
  { value: "job_failed",         label: "job_failed",         blurb: "Task Brain job exhausted retries" },
  { value: "bridge_dispatch",    label: "bridge_dispatch",    blurb: "Any Hand Bridge capability called" },
];

const EMPTY = {
  name: "",
  event: "agent_run_end",
  matcher: "{}",
  actionType: "shell" as "shell" | "agent",
  actionConfig: `{"command": "osascript -e 'display notification \\"Agent finished\\"'"}`,
  enabled: true,
};

export default function Hooks() {
  const [hooks, setHooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    try {
      setHooks(await api.getHooks());
      setLoading(false);
    } catch {}
  };
  useEffect(() => { refresh(); }, []);

  const startEdit = (h: any) => {
    setEditing(h.id);
    setCreating(false);
    setForm({
      name: h.name ?? "",
      event: h.event,
      matcher: JSON.stringify(h.matcher ?? {}),
      actionType: h.action_type,
      actionConfig: JSON.stringify(h.action_config ?? {}, null, 2),
      enabled: !!h.enabled,
    });
  };

  const startCreate = () => {
    setCreating(true);
    setEditing(null);
    setForm(EMPTY);
  };

  const cancel = () => { setCreating(false); setEditing(null); setForm(EMPTY); };

  const parseJsonOrError = (s: string, field: string): any => {
    try { return JSON.parse(s || "{}"); }
    catch { throw new Error(`${field}: invalid JSON`); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const matcher = parseJsonOrError(form.matcher, "matcher");
      const actionConfig = parseJsonOrError(form.actionConfig, "actionConfig");
      if (!form.event) throw new Error("event required");
      const payload = {
        name: form.name,
        event: form.event,
        matcher,
        actionType: form.actionType,
        actionConfig,
        enabled: form.enabled,
      };
      if (editing) {
        await api.updateHook(editing, payload);
        toast.success("Hook updated");
      } else {
        await api.createHook(payload);
        toast.success("Hook created");
      }
      cancel();
      refresh();
    } catch (err: any) {
      toast.error(err.message);
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this hook?")) return;
    await api.deleteHook(id);
    toast.success("Deleted");
    refresh();
  };

  const toggleEnabled = async (h: any) => {
    try {
      await api.updateHook(h.id, { enabled: !h.enabled });
      refresh();
    } catch (err: any) { toast.error(err.message); }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;
  }

  const formOpen = creating || editing;

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Webhook className="h-5 w-5 text-violet-400" />
            Hooks
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Run shell commands or Custom Agents on Anchor events — agent runs, tool calls, Task Brain transitions, bridge dispatches.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="glass rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          {!formOpen && (
            <button onClick={startCreate} className="glass rounded-lg px-3 py-1.5 text-xs text-foreground hover:bg-white/[0.05] flex items-center gap-1.5">
              <Plus className="h-3 w-3" /> New hook
            </button>
          )}
        </div>
      </div>

      {/* Form */}
      {formOpen && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{editing ? "Edit hook" : "New hook"}</h2>
            <button onClick={cancel} className="text-muted-foreground/60 hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full mt-1 glass rounded-md px-3 py-1.5 text-xs bg-transparent"
                placeholder="e.g. Notify on agent finish"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Event</label>
              <select
                value={form.event}
                onChange={(e) => setForm({ ...form, event: e.target.value })}
                className="w-full mt-1 glass rounded-md px-3 py-1.5 text-xs bg-transparent"
              >
                {EVENTS.map(e => (
                  <option key={e.value} value={e.value} className="bg-background">{e.label}</option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground/60 mt-0.5">{EVENTS.find(e => e.value === form.event)?.blurb}</p>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Matcher <span className="text-muted-foreground/50 normal-case">(JSON — payload fields must equal these values; empty = always fires)</span>
            </label>
            <textarea
              value={form.matcher}
              onChange={(e) => setForm({ ...form, matcher: e.target.value })}
              rows={2}
              className="w-full mt-1 glass rounded-md px-3 py-1.5 text-[11px] font-mono bg-transparent resize-none"
              placeholder='{"tool_name": "send_email"}'
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Action type</label>
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => setForm({ ...form, actionType: "shell", actionConfig: `{"command": "osascript -e 'display notification \\"Anchor event\\"'"}`})}
                  className={`flex-1 glass rounded-md px-3 py-1.5 text-xs flex items-center justify-center gap-1 ${form.actionType === "shell" ? "bg-violet-500/10 text-violet-300" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Terminal className="h-3 w-3" /> Shell
                </button>
                <button
                  onClick={() => setForm({ ...form, actionType: "agent", actionConfig: `{"agent_name": "My Agent", "message_prefix": "Event fired:"}`})}
                  className={`flex-1 glass rounded-md px-3 py-1.5 text-xs flex items-center justify-center gap-1 ${form.actionType === "agent" ? "bg-violet-500/10 text-violet-300" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Bot className="h-3 w-3" /> Agent
                </button>
              </div>
            </div>
            <div className="flex items-end">
              <label className="text-xs flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Action config <span className="text-muted-foreground/50 normal-case">
                {form.actionType === "shell" ? '({"command": "..."} — event JSON piped to stdin, also ANCHOR_HOOK_PAYLOAD env)' : '({"agent_name": "...", "message_prefix": "..."} — enqueues Task Brain job)'}
              </span>
            </label>
            <textarea
              value={form.actionConfig}
              onChange={(e) => setForm({ ...form, actionConfig: e.target.value })}
              rows={4}
              className="w-full mt-1 glass rounded-md px-3 py-1.5 text-[11px] font-mono bg-transparent resize-none"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 glass rounded-lg px-3 py-1.5 text-xs text-violet-300 hover:bg-violet-500/10 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {editing ? "Update" : "Create"}
            </button>
            <button onClick={cancel} className="px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </motion.div>
      )}

      {/* List */}
      <div className="space-y-2">
        {hooks.length === 0 ? (
          <div className="glass rounded-xl p-8 text-center">
            <Webhook className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground/60">No hooks yet. Create one above to trigger shell commands or agents on Anchor events.</p>
          </div>
        ) : hooks.map((h: any) => (
          <div key={h.id} className="glass rounded-xl p-4 hover:bg-white/[0.02] transition-colors">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleEnabled(h)} className={`h-4 w-4 rounded flex items-center justify-center ${h.enabled ? "bg-emerald-500/20" : "bg-muted"}`}>
                    {h.enabled && <Check className="h-3 w-3 text-emerald-400" />}
                  </button>
                  <span className="text-sm font-medium text-foreground">{h.name || <span className="text-muted-foreground italic">unnamed</span>}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-mono">{h.event}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono flex items-center gap-1">
                    {h.action_type === "shell" ? <Terminal className="h-2.5 w-2.5" /> : <Bot className="h-2.5 w-2.5" />}
                    {h.action_type}
                  </span>
                </div>
                <div className="mt-1.5 space-y-0.5">
                  {h.action_type === "shell" && (
                    <div className="text-[11px] text-muted-foreground font-mono truncate">$ {h.action_config?.command}</div>
                  )}
                  {h.action_type === "agent" && (
                    <div className="text-[11px] text-muted-foreground">→ agent "{h.action_config?.agent_name}"</div>
                  )}
                  {h.matcher && Object.keys(h.matcher).length > 0 && (
                    <div className="text-[10px] text-muted-foreground/60">matcher: <code className="bg-muted px-1 rounded">{JSON.stringify(h.matcher)}</code></div>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/60">
                  <span className="flex items-center gap-1"><Zap className="h-2.5 w-2.5" /> fired {h.fire_count} times</span>
                  {h.last_fired_at && <span>last: {h.last_fired_at}</span>}
                </div>
              </div>
              <div className="flex gap-1 ml-2">
                <button onClick={() => startEdit(h)} className="p-1.5 text-muted-foreground/50 hover:text-foreground"><Edit3 className="h-3 w-3" /></button>
                <button onClick={() => remove(h.id)} className="p-1.5 text-muted-foreground/50 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
