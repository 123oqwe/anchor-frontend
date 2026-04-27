import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Coins, Sparkles, History, ExternalLink, Loader2 } from "lucide-react";

interface Balance { credits: number; usdEquivalent: string; usdPerCredit: number }
interface LedgerRow { id: string; delta: number; balance_after: number; reason: string; ref: string | null; created_at: string }
interface Pack { id: string; name: string; credits: number; priceUsd: number; blurb?: string }

const REASON_LABEL: Record<string, string> = {
  signup_grant:    "Welcome bonus",
  admin_grant:     "Granted by admin",
  stripe_purchase: "Top-up",
  stripe_refund:   "Refund",
  llm_charge:      "AI usage",
  llm_refund:      "AI refund (failed call)",
  promo_grant:     "Promo",
};

function fmtCredits(n: number): string {
  return n.toLocaleString();
}

export default function Credits() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/billing/balance", { credentials: "include" }).then(r => r.json()),
      fetch("/api/billing/ledger?limit=30", { credentials: "include" }).then(r => r.json()),
      fetch("/api/billing/packs", { credentials: "include" }).then(r => r.json()),
    ])
      .then(([b, l, p]) => { setBalance(b); setLedger(l); setPacks(p); })
      .finally(() => setLoading(false));
  }, []);

  async function buy(packId: string) {
    setBuying(packId);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      if (res.status === 503) setBillingEnabled(false);
      alert(data.error ?? "Checkout failed");
    } finally {
      setBuying(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-xl font-semibold text-foreground">Credits</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Anchor charges per LLM call from this balance. 1 credit ≈ ${(balance?.usdPerCredit ?? 0).toFixed(5)}.
        </p>
      </motion.div>

      {/* Balance card */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="glass rounded-xl p-6 flex items-center gap-4"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Coins className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Balance</p>
          <p className="mt-0.5 text-2xl font-semibold text-foreground">{fmtCredits(balance?.credits ?? 0)}</p>
        </div>
        <p className="text-sm text-muted-foreground">{balance?.usdEquivalent}</p>
      </motion.div>

      {/* Packs */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" /> Top up
        </h2>
        {!billingEnabled || packs.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center text-xs text-muted-foreground">
            Billing isn't enabled yet. The operator hasn't connected Stripe — your free credits still work for now.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {packs.map((p) => (
              <button
                key={p.id}
                onClick={() => buy(p.id)}
                disabled={buying === p.id}
                className="glass rounded-xl p-5 text-left hover:bg-accent/30 transition-colors disabled:opacity-60 disabled:cursor-wait flex flex-col gap-2"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium text-foreground">{p.name}</span>
                  <span className="text-xs text-muted-foreground">${p.priceUsd}</span>
                </div>
                <p className="text-lg font-semibold text-foreground">{fmtCredits(p.credits)}</p>
                <p className="text-[11px] text-muted-foreground/80 leading-tight min-h-8">{p.blurb}</p>
                <div className="flex items-center gap-1 text-[11px] text-primary mt-auto">
                  {buying === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <>Buy <ExternalLink className="h-3 w-3" /></>}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Ledger */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <History className="h-3.5 w-3.5" /> Recent activity
        </h2>
        <div className="glass rounded-xl divide-y divide-border/40 overflow-hidden">
          {ledger.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">No activity yet.</p>
          ) : ledger.map((row) => (
            <div key={row.id} className="flex items-center justify-between px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground truncate">{REASON_LABEL[row.reason] ?? row.reason}</p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(row.created_at + "Z").toLocaleString()}
                </p>
              </div>
              <div className="text-right ml-3">
                <p className={`text-sm font-medium ${row.delta < 0 ? "text-amber-300" : "text-emerald-300"}`}>
                  {row.delta > 0 ? "+" : ""}{fmtCredits(row.delta)}
                </p>
                <p className="text-[11px] text-muted-foreground">balance {fmtCredits(row.balance_after)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
