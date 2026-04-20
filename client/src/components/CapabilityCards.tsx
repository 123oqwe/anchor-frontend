/**
 * CapabilityCards — Jobs-style front-facing status for the Hand bridge.
 *
 * One row per capability. One status light. One action button.
 * Provider internals (CLI/MCP/Vision, fallback chain, 24h stats) live behind
 * an "Advanced" disclosure — 99% of users never open it.
 *
 * Design principle: the user cares whether "Email works", not which of the
 * nine providers responded. If any provider for a capability is healthy,
 * the capability is green. The best-available provider is named under the
 * title as "via Apple Mail" / "via Gmail" etc.
 */
import { useState, useEffect, type ReactNode } from "react";
import {
  Mail, Calendar, Globe, Terminal, MonitorSmartphone, Sparkles,
  CircleCheck, CircleAlert, Loader2, ChevronDown, ChevronRight, RefreshCw, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface Capability {
  name: string;
  description: string;
  actionClass: string;
  providers: {
    id: string; kind: string; displayName: string; platforms: string[];
    requires: { oauth?: string; shortcuts?: string[]; binary?: string };
  }[];
}

interface ProviderStatus {
  id: string; kind: string; capability: string; displayName: string;
  platforms: string[]; requires: any;
  health: { healthy: boolean; reason?: string };
  attemptStats24h: Record<string, number>;
}

interface CardSpec {
  capability: string;
  title: string;
  icon: ReactNode;
  description: string;
}

const CAPABILITY_CARDS: CardSpec[] = [
  { capability: "email.send", title: "Email", icon: <Mail className="h-4 w-4" />, description: "Let agents draft and send emails on your behalf" },
  { capability: "calendar.create_event", title: "Calendar", icon: <Calendar className="h-4 w-4" />, description: "Create events, block time, schedule meetings" },
  { capability: "browser.navigate", title: "Web actions", icon: <Globe className="h-4 w-4" />, description: "Open pages and read content from the web" },
  { capability: "browser.session", title: "Web sessions", icon: <Globe className="h-4 w-4" />, description: "Multi-step flows that need to stay logged in" },
  { capability: "desktop.automate", title: "Mac app control", icon: <MonitorSmartphone className="h-4 w-4" />, description: "Automate any desktop app via screenshot + vision" },
  { capability: "dev.delegate", title: "Coding tasks", icon: <Terminal className="h-4 w-4" />, description: "Hand off code work to Claude Code" },
];

export function CapabilityCards() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [providers, setProviders] = useState<Map<string, ProviderStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async () => {
    const [caps, provs] = await Promise.all([
      api.getBridgeCapabilities().catch(() => []),
      api.getBridgeProviders().catch(() => []),
    ]);
    setCapabilities(caps as any);
    const m = new Map<string, ProviderStatus>();
    for (const p of provs as any) m.set(p.id, p);
    setProviders(m);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const probe = async () => {
    setProbing(true);
    await load();
    setProbing(false);
    toast.success("Refreshed");
  };

  const toggle = (name: string) => {
    const next = new Set(expanded);
    next.has(name) ? next.delete(name) : next.add(name);
    setExpanded(next);
  };

  if (loading) return (
    <div className="glass rounded-xl p-6 flex items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-primary/50" />
    </div>
  );

  return (
    <div className="glass rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold mb-1">What Anchor can do for you</h2>
          <p className="text-xs text-muted-foreground">
            Anchor uses your Mac's existing apps and accounts — no separate logins required.
          </p>
        </div>
        <button onClick={probe} disabled={probing}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg glass text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
          {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </button>
      </div>

      <div className="space-y-2">
        {CAPABILITY_CARDS.map(spec => {
          const cap = capabilities.find(c => c.name === spec.capability);
          const provs = cap?.providers.map(p => providers.get(p.id)).filter(Boolean) as ProviderStatus[] | undefined;
          const first = provs?.find(p => p.health.healthy);
          const healthy = !!first;
          const anyUnhealthy = provs?.find(p => !p.health.healthy);
          const isExpanded = expanded.has(spec.capability);

          return (
            <div key={spec.capability} className={`glass rounded-lg p-4 transition-colors ${healthy ? "" : "opacity-80"}`}>
              <div className="flex items-center gap-3">
                <div className={`h-7 w-7 rounded-md flex items-center justify-center ${healthy ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                  {spec.icon}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{spec.title}</span>
                    {healthy
                      ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" />
                      : <CircleAlert className="h-3.5 w-3.5 text-amber-400" />
                    }
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {healthy
                      ? <>Ready {first && <span className="text-muted-foreground/60">· via {first.displayName}</span>}</>
                      : anyUnhealthy
                        ? <span className="text-amber-400/80">{anyUnhealthy.health.reason}</span>
                        : "No provider registered"}
                  </p>
                </div>

                <button onClick={() => toggle(spec.capability)}
                  className="text-[10px] text-muted-foreground/60 hover:text-foreground font-mono flex items-center gap-0.5">
                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  details
                </button>
              </div>

              {/* Expanded: all providers in tier order, quick hint if a fix exists */}
              {isExpanded && provs && (
                <div className="mt-3 pt-3 border-t border-white/5 space-y-1">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">Providers (in fallback order)</p>
                  {provs.map(p => (
                    <div key={p.id} className="flex items-center gap-2 text-[11px]">
                      {p.health.healthy
                        ? <CircleCheck className="h-3 w-3 text-emerald-400 shrink-0" />
                        : <CircleAlert className="h-3 w-3 text-amber-400/60 shrink-0" />}
                      <span className="text-foreground">{p.displayName}</span>
                      <span className={`text-[9px] px-1 rounded font-mono ${
                        p.kind === "cli" ? "bg-emerald-500/10 text-emerald-400" :
                        p.kind === "mcp" ? "bg-cyan-500/10 text-cyan-400" :
                        "bg-purple-500/10 text-purple-400"
                      }`}>{p.kind}</span>
                      {!p.health.healthy && p.health.reason && (
                        <span className="text-muted-foreground/60 truncate">— {p.health.reason}</span>
                      )}
                    </div>
                  ))}
                  <div className="pt-2">
                    <a href="/admin/bridges-advanced" className="text-[10px] text-muted-foreground/60 hover:text-foreground inline-flex items-center gap-1">
                      Advanced: reorder, disable, diagnose <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="pt-3 border-t border-white/5">
        <p className="text-[10px] text-muted-foreground/60">
          <Sparkles className="h-3 w-3 inline mr-1" />
          Prefer OAuth/API for background automation while you sleep?{" "}
          <a href="/settings?section=api" className="text-primary hover:underline">Connect Google</a>
          {" "}— optional.
        </p>
      </div>
    </div>
  );
}
