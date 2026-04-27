import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Anchor, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useSession } from "@/lib/auth";

export default function Verify() {
  const [, setLocation] = useLocation();
  const { refresh } = useSession();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const invite = params.get("invite");
    if (!token) {
      setState("error");
      setMessage("Missing token in link");
      return;
    }

    (async () => {
      try {
        const url = `/api/auth/verify?token=${encodeURIComponent(token)}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`;
        const res = await fetch(url, { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setState("error");
          setMessage(data.error ?? `Verification failed (${res.status})`);
          return;
        }
        await refresh();
        setState("ok");
        // Brief success flash, then to dashboard. Onboarding gate still
        // applies inside the router for first-time users.
        setTimeout(() => setLocation("/dashboard"), 600);
      } catch (err: any) {
        setState("error");
        setMessage(err?.message ?? "Network error");
      }
    })();
  }, [refresh, setLocation]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex flex-col items-center text-center max-w-sm"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
          <Anchor className="h-6 w-6 text-primary" />
        </div>

        {state === "working" && (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Signing you in…</p>
          </>
        )}

        {state === "ok" && (
          <>
            <CheckCircle2 className="h-6 w-6 text-emerald-400" />
            <p className="mt-2 text-sm text-foreground">Signed in. Redirecting…</p>
          </>
        )}

        {state === "error" && (
          <>
            <AlertTriangle className="h-6 w-6 text-amber-400" />
            <p className="mt-2 text-sm text-foreground">Couldn't sign you in</p>
            {message && <p className="mt-1 text-xs text-muted-foreground">{message}</p>}
            <button
              onClick={() => setLocation("/login")}
              className="mt-4 text-xs text-primary hover:text-primary/80"
            >
              ← Back to sign in
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}
