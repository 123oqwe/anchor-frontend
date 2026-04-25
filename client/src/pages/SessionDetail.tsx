/**
 * Phase 4 of #2 — Session detail with takeover controls.
 *
 * Shows step-by-step progress + pause/resume/cancel/takeover. Step list
 * displays runtime/tool/status/output/observation/verify. Editable steps
 * (pending/retrying/awaiting_approval) get inline edit + skip buttons.
 */
import { useEffect, useState, useCallback } from "react";
import { useRoute, Link } from "wouter";
import {
  Loader2, ArrowLeft, Pause, Play, X, Hand,
  CheckCircle2, AlertCircle, Clock, PauseCircle, XCircle,
  ChevronRight, SkipForward, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const REFRESH_MS = 2000;
const EDITABLE = ["pending", "retrying", "awaiting_approval"];

const STEP_META: Record<string, { color: string; icon: any }> = {
  pending:            { color: "text-blue-400",         icon: Clock },
  running:            { color: "text-amber-400",        icon: Loader2 },
  awaiting_approval:  { color: "text-orange-400",       icon: Hand },
  succeeded:          { color: "text-emerald-400",      icon: CheckCircle2 },
  failed:             { color: "text-red-400",          icon: AlertCircle },
  skipped:            { color: "text-muted-foreground", icon: SkipForward },
  retrying:           { color: "text-orange-400",       icon: Loader2 },
};

const RUNTIME_BADGE: Record<string, string> = {
  llm:       "bg-purple-500/10 text-purple-400 border-purple-500/20",
  cli:       "bg-amber-500/10 text-amber-400 border-amber-500/20",
  browser:   "bg-blue-500/10 text-blue-400 border-blue-500/20",
  local_app: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  db:        "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  human:     "bg-pink-500/10 text-pink-400 border-pink-500/20",
};

export default function SessionDetail() {
  const [, params] = useRoute<{ id: string }>("/sessions/:id");
  const sessionId = params?.id ?? "";
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const d = await api.getSession(sessionId);
      setData(d);
      setLoading(false);
    } catch (err: any) {
      if (err?.message?.includes("404")) {
        setData(null);
        setLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const action = async (label: string, fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      refresh();
    } catch (err: any) {
      toast.error(err?.message ?? label + " failed");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (step: any) => {
    setEditingStepId(step.id);
    setEditName(step.name);
  };

  const saveEdit = async (stepId: string) => {
    setBusy(true);
    try {
      await api.editStep(sessionId, stepId, { name: editName });
      toast.success("Step updated");
      setEditingStepId(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message ?? "Edit failed");
    } finally {
      setBusy(false);
    }
  };

  const skip = (stepId: string) => action("Step skipped", () => api.skipStep(sessionId, stepId));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
        <p>Session not found.</p>
        <Link href="/sessions"><a className="text-sm text-primary hover:underline">← Back to sessions</a></Link>
      </div>
    );
  }

  const status = data.status as string;
  const canPause = status === "running";
  const canResume = status === "paused";
  const canCancel = ["pending", "running", "paused"].includes(status);
  const canTakeover = ["pending", "running", "paused"].includes(status);

  return (
    <div className="flex h-full flex-col p-6 gap-4">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/sessions">
            <a className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-2">
              <ArrowLeft className="h-3 w-3" /> Sessions
            </a>
          </Link>
          <h1 className="text-xl font-semibold tracking-tight line-clamp-2">{data.goal}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap text-xs">
            <span className={`uppercase tracking-wider ${STEP_META[status]?.color ?? "text-muted-foreground"}`}>{status}</span>
            <span className="text-muted-foreground/60 font-mono">{data.id.slice(0, 12)}</span>
            <span className="text-muted-foreground/60">{data.steps?.length ?? 0} steps</span>
          </div>
          {data.plan_summary && (
            <p className="text-sm text-muted-foreground mt-2">{data.plan_summary}</p>
          )}
          {data.compile_error && (
            <p className="text-sm text-red-400 mt-2">⚠ {data.compile_error}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canPause && (
            <button
              onClick={() => action("Paused", () => api.pauseSession(sessionId))}
              disabled={busy}
              className="rounded-md bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 px-3 py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Pause className="h-3 w-3" /> Pause
            </button>
          )}
          {canResume && (
            <button
              onClick={() => action("Resumed", () => api.resumeSession(sessionId))}
              disabled={busy}
              className="rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 px-3 py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Play className="h-3 w-3" /> Resume
            </button>
          )}
          {canTakeover && (
            <button
              onClick={() => action("Takeover — review in Approvals", () => api.takeoverSession(sessionId))}
              disabled={busy}
              className="rounded-md bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 px-3 py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-50"
            >
              <Hand className="h-3 w-3" /> Take over
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => action("Cancelled", () => api.cancelSession(sessionId))}
              disabled={busy}
              className="rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-50"
            >
              <X className="h-3 w-3" /> Cancel
            </button>
          )}
        </div>
      </header>

      {/* Steps */}
      <div className="flex-1 overflow-y-auto rounded-lg border border-border/50 bg-card/30">
        <ol className="divide-y divide-border/30">
          {data.steps?.map((s: any, i: number) => {
            const meta = STEP_META[s.status] ?? STEP_META.pending;
            const Icon = meta.icon;
            const editable = EDITABLE.includes(s.status);
            const isEditing = editingStepId === s.id;
            return (
              <li key={s.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col items-center gap-0.5 shrink-0 pt-0.5">
                    <span className="text-[10px] text-muted-foreground/50 font-mono">#{i + 1}</span>
                    <Icon className={`h-4 w-4 ${meta.color} ${s.status === "running" || s.status === "retrying" ? "animate-spin" : ""}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-[10px] uppercase tracking-wider ${meta.color}`}>{s.status}</span>
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${RUNTIME_BADGE[s.runtime] ?? "border-border/50"}`}>
                        {s.runtime}
                      </span>
                      {s.tool && <span className="text-[10px] font-mono text-muted-foreground">{s.tool}</span>}
                      {s.approval_required ? <span className="text-[10px] text-orange-400">approval</span> : null}
                      {s.verify_rule && (
                        <span className={`text-[10px] ${s.verify_status === "pass" ? "text-emerald-400" : s.verify_status === "fail" ? "text-red-400" : "text-muted-foreground"}`}>
                          verify:{s.verify_rule} {s.verify_status !== "unknown" ? `→${s.verify_status}` : ""}
                        </span>
                      )}
                    </div>
                    {isEditing ? (
                      <div className="flex gap-2 items-center">
                        <input
                          autoFocus
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          className="flex-1 rounded-md border border-border/50 bg-background px-2 py-1 text-sm"
                        />
                        <button
                          onClick={() => saveEdit(s.id)}
                          disabled={busy}
                          className="rounded-md bg-emerald-500/10 text-emerald-400 px-2 py-1 text-xs disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingStepId(null)}
                          className="rounded-md border border-border/50 px-2 py-1 text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="text-sm">{s.name}</div>
                    )}
                    {s.output_text && (
                      <details className="mt-1">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          output ({s.output_text.length}c)
                        </summary>
                        <pre className="text-[11px] bg-muted/30 rounded p-2 mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{s.output_text}</pre>
                      </details>
                    )}
                    {s.observation && Object.keys(s.observation).length > 0 && (
                      <details className="mt-1">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          observation ({s.observation.runtime})
                        </summary>
                        <pre className="text-[11px] bg-muted/30 rounded p-2 mt-1 max-h-32 overflow-auto">{JSON.stringify(s.observation, null, 2)}</pre>
                      </details>
                    )}
                    {s.verify_evidence && (
                      <div className={`text-[11px] mt-1 ${s.verify_status === "fail" ? "text-red-400" : "text-muted-foreground"}`}>
                        verify: {s.verify_evidence}
                      </div>
                    )}
                  </div>
                  {editable && !isEditing && (
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => startEdit(s)}
                        disabled={busy}
                        className="rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-muted/50 inline-flex items-center gap-1 disabled:opacity-50"
                        title="Edit step name"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => skip(s.id)}
                        disabled={busy}
                        className="rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-muted/50 inline-flex items-center gap-1 disabled:opacity-50"
                        title="Skip step"
                      >
                        <SkipForward className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
