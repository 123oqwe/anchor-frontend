/**
 * Bridges Panel — surfaces the L8-Hand capability/provider bridge in Settings.
 *
 * Per capability: list providers with live health, kind badge (CLI/MCP),
 * reorder buttons, and disable toggle. All state persisted via
 * /api/bridges/preferences.
 */
import { useState, useEffect } from "react";
import { Terminal, Zap, CircleCheck, CircleAlert, CircleX, ChevronUp, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface Capability {
  name: string;
  description: string;
  actionClass: string;
  providers: {
    id: string;
    kind: "cli" | "mcp";
    displayName: string;
    platforms: string[];
    requires: Record<string, any>;
  }[];
}

interface ProviderStatus {
  id: string;
  kind: "cli" | "mcp";
  capability: string;
  displayName: string;
  platforms: string[];
  health: { healthy: boolean; reason?: string; checkedAt: number };
  attemptStats24h: Record<string, number>;
}

export function BridgesPanel() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [providers, setProviders] = useState<Map<string, ProviderStatus>>(new Map());
  const [prefs, setPrefs] = useState<Record<string, { order: string[]; disabled: string[] }>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [caps, provs, prefs] = await Promise.all([
      api.getBridgeCapabilities().catch(() => []),
      api.getBridgeProviders().catch(() => []),
      api.getBridgePreferences().catch(() => ({})),
    ]);
    setCapabilities(caps);
    const m = new Map<string, ProviderStatus>();
    for (const p of provs) m.set(p.id, p);
    setProviders(m);
    setPrefs(prefs);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const refreshHealth = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
    toast.success("Provider health refreshed");
  };

  const orderedProviders = (cap: Capability): Capability["providers"] => {
    const pref = prefs[cap.name]?.order ?? [];
    const byId = new Map(cap.providers.map(p => [p.id, p]));
    const out: Capability["providers"] = [];
    const seen = new Set<string>();
    for (const id of pref) {
      const p = byId.get(id);
      if (p) { out.push(p); seen.add(id); }
    }
    for (const p of cap.providers) {
      if (!seen.has(p.id)) out.push(p);
    }
    return out;
  };

  const move = async (capName: string, providerId: string, dir: -1 | 1) => {
    const cap = capabilities.find(c => c.name === capName);
    if (!cap) return;
    const current = orderedProviders(cap).map(p => p.id);
    const idx = current.indexOf(providerId);
    if (idx < 0) return;
    const next = [...current];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    const disabled = prefs[capName]?.disabled ?? [];
    await api.setBridgePreference(capName, next, disabled);
    setPrefs({ ...prefs, [capName]: { order: next, disabled } });
  };

  const toggleDisabled = async (capName: string, providerId: string) => {
    const disabled = new Set(prefs[capName]?.disabled ?? []);
    if (disabled.has(providerId)) disabled.delete(providerId);
    else disabled.add(providerId);
    const order = prefs[capName]?.order ?? [];
    const arr = Array.from(disabled);
    await api.setBridgePreference(capName, order, arr);
    setPrefs({ ...prefs, [capName]: { order, disabled: arr } });
  };

  if (loading) return <div className="flex items-center justify-center p-8"><Loader2 className="h-4 w-4 animate-spin text-primary/50" /></div>;

  const cliCount = Array.from(providers.values()).filter(p => p.kind === "cli").length;
  const mcpCount = Array.from(providers.values()).filter(p => p.kind === "mcp").length;
  const healthyCount = Array.from(providers.values()).filter(p => p.health?.healthy).length;

  return (
    <div className="glass rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold mb-1">Hand Bridge</h2>
          <p className="text-xs text-muted-foreground">
            Action providers for every capability. Drag order sets fallback chain; disable to skip a provider.
          </p>
          <div className="flex gap-3 mt-2 text-[10px] text-muted-foreground">
            <span><span className="text-primary font-mono">{capabilities.length}</span> capabilities</span>
            <span><span className="text-emerald-400 font-mono">{cliCount}</span> CLI</span>
            <span><span className="text-cyan-400 font-mono">{mcpCount}</span> MCP</span>
            <span><span className="text-emerald-400 font-mono">{healthyCount}</span>/{providers.size} healthy</span>
          </div>
        </div>
        <button onClick={refreshHealth} disabled={refreshing}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg glass text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Probe
        </button>
      </div>

      <div className="space-y-3">
        {capabilities.map((cap) => {
          const disabled = new Set(prefs[cap.name]?.disabled ?? []);
          const ordered = orderedProviders(cap);
          return (
            <div key={cap.name} className="glass rounded-lg p-3">
              <div className="flex items-baseline justify-between mb-2">
                <div>
                  <span className="text-sm font-mono text-foreground">{cap.name}</span>
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">{cap.actionClass}</span>
                </div>
                <span className="text-[10px] text-muted-foreground">{ordered.length} providers</span>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2 line-clamp-1">{cap.description}</p>

              <div className="space-y-1">
                {ordered.map((p, i) => {
                  const status = providers.get(p.id);
                  const isDisabled = disabled.has(p.id);
                  const healthy = status?.health?.healthy;
                  return (
                    <div key={p.id} className={`flex items-center gap-2 py-1.5 px-2 rounded ${isDisabled ? "opacity-40" : ""}`}>
                      {healthy === true && <CircleCheck className="h-3 w-3 text-emerald-400 shrink-0" />}
                      {healthy === false && <CircleX className="h-3 w-3 text-red-400 shrink-0" />}
                      {healthy === undefined && <CircleAlert className="h-3 w-3 text-muted-foreground/40 shrink-0" />}

                      <span className="text-[10px] text-muted-foreground w-4 font-mono">{i + 1}.</span>

                      {p.kind === "cli"
                        ? <Terminal className="h-3 w-3 text-emerald-400 shrink-0" />
                        : <Zap className="h-3 w-3 text-cyan-400 shrink-0" />}

                      <span className="text-xs text-foreground flex-1 truncate">{p.displayName}</span>

                      <span className={`text-[9px] font-mono px-1 rounded ${p.kind === "cli" ? "bg-emerald-500/10 text-emerald-400" : "bg-cyan-500/10 text-cyan-400"}`}>
                        {p.kind}
                      </span>

                      {status?.attemptStats24h && Object.keys(status.attemptStats24h).length > 0 && (
                        <span className="text-[9px] text-muted-foreground font-mono" title="24h attempts">
                          {status.attemptStats24h.success ?? 0}✓ {status.attemptStats24h.failed ?? 0}✗
                        </span>
                      )}

                      <div className="flex items-center gap-0.5">
                        <button onClick={() => move(cap.name, p.id, -1)} disabled={i === 0}
                          className="p-0.5 rounded hover:bg-white/5 disabled:opacity-20 disabled:cursor-default"
                          title="Move up">
                          <ChevronUp className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button onClick={() => move(cap.name, p.id, 1)} disabled={i === ordered.length - 1}
                          className="p-0.5 rounded hover:bg-white/5 disabled:opacity-20 disabled:cursor-default"
                          title="Move down">
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button onClick={() => toggleDisabled(cap.name, p.id)}
                          className={`ml-1 text-[9px] px-1.5 py-0.5 rounded font-mono ${isDisabled ? "bg-red-500/10 text-red-400" : "text-muted-foreground hover:text-foreground"}`}
                          title={isDisabled ? "Enable" : "Disable"}>
                          {isDisabled ? "off" : "on"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Surface unhealthy reasons inline */}
              {ordered.some(p => {
                const s = providers.get(p.id);
                return s && !s.health?.healthy && !disabled.has(p.id);
              }) && (
                <div className="mt-2 pt-2 border-t border-white/5 space-y-0.5">
                  {ordered.filter(p => {
                    const s = providers.get(p.id);
                    return s && !s.health?.healthy && !disabled.has(p.id);
                  }).map(p => {
                    const s = providers.get(p.id);
                    return (
                      <p key={p.id} className="text-[10px] text-amber-400/80">
                        <span className="font-mono">{p.id}</span>: {s?.health?.reason ?? "unhealthy"}
                      </p>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
