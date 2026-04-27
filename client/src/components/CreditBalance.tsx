/**
 * Sidebar widget — current credit balance + a tap target to /credits.
 *
 * Polls /api/billing/balance every 30s so the sidebar stays roughly in sync
 * after the agent makes calls. The Credits page does its own freshly-loaded
 * fetch so an in-flight tab is always accurate.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Coins } from "lucide-react";

interface Balance { credits: number; usdEquivalent: string }

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function CreditBalance({ collapsed }: { collapsed: boolean }) {
  const [balance, setBalance] = useState<Balance | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/billing/balance", { credentials: "include" })
        .then(r => r.ok ? r.json() : null)
        .then(b => { if (!cancelled && b) setBalance(b); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <Link href="/credits">
      <div
        className="group flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
        title={balance ? `${balance.credits.toLocaleString()} credits (${balance.usdEquivalent})` : "Credits"}
      >
        <Coins className="h-3.5 w-3.5 shrink-0" />
        {!collapsed && (
          <span className="truncate">
            {balance ? fmt(balance.credits) : "—"}
            <span className="text-muted-foreground/50"> credits</span>
          </span>
        )}
      </div>
    </Link>
  );
}
