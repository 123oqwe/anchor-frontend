/**
 * Admin — Missions list.
 *
 * A mission = a multi-agent collaboration (handoffs/delegates) sharing a
 * mission_id. Each row summarizes agent count, blackboard key count, last
 * activity. Click → timeline view.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Share2, Loader2, Users, Database, Clock, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

export default function Missions() {
  const [, navigate] = useLocation();
  const [missions, setMissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const rows = await api.getMissions(50);
      setMissions(rows);
      setLoading(false);
    } catch {}
  };
  useEffect(() => { refresh(); }, []);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="h-5 w-5 animate-spin text-primary/50" /></div>;

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Share2 className="h-5 w-5 text-cyan-400" />
            Missions
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Multi-agent collaborations — handoffs, delegates, shared blackboard. Each row is one mission.
          </p>
        </div>
        <button onClick={refresh} className="glass rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {missions.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center">
          <Share2 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground/60">
            No missions yet. Missions form when agents write to anchor.blackboard.* or handoff to each other.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {missions.map((m: any) => (
            <button
              key={m.missionId}
              onClick={() => navigate(`/admin/missions/${m.missionId}`)}
              className="glass rounded-xl p-4 text-left hover:bg-white/[0.03] transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[200px]">{m.missionId}</span>
                <span className="text-[10px] text-muted-foreground">{fmtTime(m.lastActivity)}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="flex items-center justify-center gap-1 text-cyan-400">
                    <Users className="h-3 w-3" />
                    <span className="text-lg font-semibold">{m.agentCount}</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 uppercase">agents</div>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-1 text-amber-400">
                    <Database className="h-3 w-3" />
                    <span className="text-lg font-semibold">{m.blackboardKeys}</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 uppercase">blackboard</div>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-1 text-emerald-400">
                    <Clock className="h-3 w-3" />
                    <span className="text-lg font-semibold">{m.runCount}</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 uppercase">events</div>
                </div>
              </div>
              {m.agents.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/5 flex flex-wrap gap-1">
                  {m.agents.slice(0, 4).map((a: string) => (
                    <span key={a} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{a}</span>
                  ))}
                  {m.agents.length > 4 && <span className="text-[9px] text-muted-foreground/50">+{m.agents.length - 4}</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  } catch { return iso; }
}
