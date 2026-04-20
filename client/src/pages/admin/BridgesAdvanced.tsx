/**
 * Admin — Bridges Advanced (power-user view).
 *
 * The full provider matrix: every capability × every provider, with kind
 * badges, reorder controls, disable toggles, and 24h attempt stats.
 * Lives in Admin because most users should never see it. Settings → Integrations
 * shows the capability-level view (CapabilityCards); this is the vault.
 */
import { BridgesPanel } from "@/components/BridgesPanel";

export default function BridgesAdvanced() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Hand Bridge — Advanced</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Per-provider health, fallback order, and telemetry. For troubleshooting or forcing a specific provider.
        </p>
      </div>
      <BridgesPanel />
    </div>
  );
}
