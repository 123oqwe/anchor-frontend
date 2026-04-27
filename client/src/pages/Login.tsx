import { useState } from "react";
import { motion } from "framer-motion";
import { Anchor, Mail, ArrowRight, Loader2 } from "lucide-react";

type Phase = "form" | "submitting" | "sent" | "error";

export default function Login() {
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setPhase("submitting");
    setMessage(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), invite: invite.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase("error");
        setMessage(data.error ?? `Login failed (${res.status})`);
        return;
      }
      setPhase("sent");
      // Dev affordance: when RESEND_API_KEY isn't configured the backend
      // doesn't actually email — show the hint so the user knows to check
      // the server console for the magic link.
      if (data.sent === false && data.hint) setMessage(data.hint);
    } catch (err: any) {
      setPhase("error");
      setMessage(err?.message ?? "Network error");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
            <Anchor className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Sign in to Anchor</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            We'll email you a one-time link. No password.
          </p>
        </div>

        {phase === "sent" ? (
          <div className="glass rounded-xl p-6 text-center">
            <Mail className="mx-auto mb-3 h-6 w-6 text-primary" />
            <p className="text-sm font-medium text-foreground">Check your inbox</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A sign-in link was sent to <span className="text-foreground">{email}</span>. Valid for 15 minutes.
            </p>
            {message && (
              <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                Dev hint: {message}
              </p>
            )}
            <button
              onClick={() => { setPhase("form"); setMessage(null); }}
              className="mt-4 text-xs text-muted-foreground hover:text-foreground"
            >
              ← use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="glass rounded-xl p-6 space-y-4">
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@anchor.app"
                autoComplete="email"
                autoFocus
                required
                className="mt-1 w-full rounded-lg bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Invite code <span className="text-muted-foreground/50 normal-case">(new accounts only)</span>
              </label>
              <input
                type="text"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder="ABC123"
                className="mt-1 w-full rounded-lg bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <button
              type="submit"
              disabled={phase === "submitting" || !email}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {phase === "submitting"
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <>Send link <ArrowRight className="h-4 w-4" /></>
              }
            </button>
            {phase === "error" && message && (
              <p className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{message}</p>
            )}
          </form>
        )}
      </motion.div>
    </div>
  );
}
