/**
 * Agent Inspector — the "what is this agent doing?" window.
 *
 * Three panels over the truth: skills that crystallized, files that exist in
 * the real ~/Documents folder, and recent runs. This is Anchor's equivalent
 * of Manus's "Computer" — except the computer really is yours. The "Open in
 * Finder" button is a reminder: this is your Mac, not a cloud sandbox.
 */
import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { motion } from "framer-motion";
import {
  FolderOpen, FileText, Sparkles, Play, ArrowLeft, Loader2,
  Clock, ExternalLink, RefreshCw, Terminal, Database,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const REFRESH_MS = 3000;

export default function AgentInspector() {
  const params = useParams() as { id: string };
  const [agent, setAgent] = useState<any>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState<string>("");
  const [workspaceExists, setWorkspaceExists] = useState(true);
  const [skills, setSkills] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<any>(null);
  const [openingFinder, setOpeningFinder] = useState(false);

  const refresh = async () => {
    try {
      const [ag, f, sk, r] = await Promise.all([
        api.getCustomAgents().then((arr: any[]) => arr.find((a) => a.id === params.id)).catch(() => null),
        api.getAgentWorkspaceFiles(params.id).catch(() => ({ path: "", exists: false, files: [] })),
        api.getAgentSkills(params.id).catch(() => []),
        api.getAgentRuns(params.id, 20).catch(() => []),
      ]);
      if (ag) setAgent(ag);
      setFiles(f.files ?? []);
      setWorkspaceDir(f.path ?? "");
      setWorkspaceExists(!!f.exists);
      setSkills(sk ?? []);
      setRuns(r ?? []);
      setLoading(false);
    } catch (err: any) {
      console.error("AgentInspector refresh failed", err);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [params.id]);

  const loadFile = async (name: string) => {
    setSelectedFile(name);
    setFileContent("Loading...");
    try {
      const r = await api.getAgentWorkspaceFile(params.id, name);
      setFileContent(r.content);
    } catch (err: any) {
      setFileContent(`Error: ${err.message || "could not read file"}`);
    }
  };

  const openInFinder = async () => {
    setOpeningFinder(true);
    try {
      await api.openAgentWorkspace(params.id);
      toast.success("Opened in Finder");
    } catch (err: any) {
      toast.error(err.message || "Could not open Finder");
    } finally {
      setOpeningFinder(false);
    }
  };

  if (loading || !agent) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/agents">
            <button className="p-2 glass rounded-lg hover:bg-white/[0.03]">
              <ArrowLeft className="h-4 w-4 text-muted-foreground" />
            </button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              {agent.name}
              <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                {agent.enabled ? "enabled" : "disabled"}
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">{agent.instructions?.slice(0, 120)}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="glass rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
          <button
            onClick={openInFinder}
            disabled={openingFinder || !workspaceExists}
            className="glass rounded-lg px-3 py-1.5 text-xs text-foreground hover:bg-white/[0.05] flex items-center gap-1.5 disabled:opacity-50"
          >
            {openingFinder ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
            Open in Finder
          </button>
        </div>
      </div>

      {/* Workspace path hint — tells the user "this is your real Mac" */}
      <div className="text-[10px] text-muted-foreground/60 font-mono flex items-center gap-1">
        <FolderOpen className="h-3 w-3" />
        {workspaceDir || "(workspace not created yet — run this agent once)"}
      </div>

      {/* 3-panel grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* LEFT: Skills */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="col-span-3 glass rounded-xl p-4 min-h-[500px]">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold">Skills</h2>
            <span className="text-[10px] text-muted-foreground ml-auto">{skills.length} crystallized</span>
          </div>
          {skills.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">
              None yet. Skills auto-crystallize after 3 successful runs of the same pattern.
            </p>
          ) : (
            <div className="space-y-1.5">
              {skills.map((s) => (
                <button
                  key={s.name}
                  onClick={() => setSelectedSkill(s)}
                  className={`w-full text-left p-2 rounded-md transition-colors ${
                    selectedSkill?.name === s.name ? "bg-amber-500/10 border border-amber-500/20" : "hover:bg-white/[0.03]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">{s.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{s.successCount}×</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{s.description}</p>
                </button>
              ))}
            </div>
          )}

          {selectedSkill && (
            <div className="mt-4 pt-3 border-t border-white/5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Template ({selectedSkill.lang})</span>
                <button onClick={() => setSelectedSkill(null)} className="text-[10px] text-muted-foreground hover:text-foreground">×</button>
              </div>
              <pre className="text-[10px] font-mono bg-black/30 rounded p-2 overflow-auto max-h-[280px] whitespace-pre-wrap text-foreground/80">
                {selectedSkill.template.slice(0, 2000)}
              </pre>
            </div>
          )}
        </motion.div>

        {/* MIDDLE: Workspace files */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="col-span-5 glass rounded-xl p-4 min-h-[500px]">
          <div className="flex items-center gap-2 mb-3">
            <Database className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-semibold">Workspace files</h2>
            <span className="text-[10px] text-muted-foreground ml-auto">{files.length} items</span>
          </div>

          <div className="grid grid-cols-2 gap-3 h-[440px]">
            {/* Left: file list */}
            <div className="space-y-0.5 overflow-y-auto custom-scrollbar">
              {files.length === 0 ? (
                <p className="text-xs text-muted-foreground/60 italic p-2">
                  {workspaceExists ? "Workspace empty" : "Run the agent once to create workspace"}
                </p>
              ) : (
                files.map((f) => (
                  <button
                    key={f.name}
                    onClick={() => !f.isDir && loadFile(f.name)}
                    disabled={f.isDir}
                    className={`w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 ${
                      selectedFile === f.name ? "bg-cyan-500/10" : "hover:bg-white/[0.03]"
                    } ${f.isDir ? "opacity-60" : ""}`}
                  >
                    {f.isDir ? <FolderOpen className="h-3 w-3 text-muted-foreground flex-shrink-0" /> : <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                    <span className="text-xs text-foreground truncate flex-1">{f.name}</span>
                    <span className="text-[9px] text-muted-foreground/50 font-mono flex-shrink-0">{fmtBytes(f.size)}</span>
                  </button>
                ))
              )}
            </div>
            {/* Right: file content preview */}
            <div className="bg-black/30 rounded overflow-hidden">
              {selectedFile ? (
                <pre className="p-2 text-[10px] font-mono text-foreground/80 overflow-auto h-full whitespace-pre-wrap">
                  {fileContent}
                </pre>
              ) : (
                <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground/40">
                  Select a file to preview
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* RIGHT: Recent runs */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="col-span-4 glass rounded-xl p-4 min-h-[500px]">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="h-4 w-4 text-emerald-400" />
            <h2 className="text-sm font-semibold">Recent runs</h2>
            <span className="text-[10px] text-muted-foreground ml-auto">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">No runs yet.</p>
          ) : (
            <div className="space-y-2 overflow-y-auto custom-scrollbar" style={{ maxHeight: 440 }}>
              {runs.map((r) => (
                <div key={r.runId} className="glass rounded-lg p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <Link href={`/admin/runs/${r.runId}`}>
                      <span className="text-[10px] font-mono text-muted-foreground hover:text-foreground cursor-pointer">
                        {r.runId.slice(0, 12)}…
                        <ExternalLink className="h-2 w-2 inline ml-0.5" />
                      </span>
                    </Link>
                    <span className="text-[10px] text-muted-foreground">{fmtTime(r.startedAt)}</span>
                  </div>
                  {r.llm.length > 0 && (
                    <div className="text-[10px] text-muted-foreground/80 mb-1">
                      <span className="text-emerald-400/80">{r.llm.length} LLM call{r.llm.length === 1 ? "" : "s"}</span>
                      {" · "}
                      {r.llm.reduce((sum: number, c: any) => sum + (c.latency ?? 0), 0)}ms
                    </div>
                  )}
                  {r.execs.slice(0, 5).map((e: any, i: number) => (
                    <div key={i} className="text-[10px] text-muted-foreground/70 truncate">
                      <span className={e.status === "failed" ? "text-red-400/70" : "text-foreground/70"}>
                        {e.status === "failed" ? "✗" : "✓"}
                      </span>
                      {" "}
                      {e.action?.slice(0, 100) ?? ""}
                    </div>
                  ))}
                  {r.execs.length > 5 && (
                    <div className="text-[10px] text-muted-foreground/50 mt-1">
                      +{r.execs.length - 5} more
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString();
  } catch { return iso; }
}
