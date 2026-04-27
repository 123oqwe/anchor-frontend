/**
 * Auth context — single source of truth for "who is logged in".
 *
 * Loads on mount via /api/auth/me. Listens to the global unauthenticated
 * event from api.ts so a 401 anywhere in the app propagates here, clears
 * the user, and the router falls back to /login.
 *
 * Usage:
 *   const { user, loading } = useSession();
 *   if (loading) return <Spinner />;
 *   if (!user) return <Login />;
 *   ...
 *
 * Why context (not a per-page hook): every page would otherwise re-fetch
 * /me. One fetch on mount + one cached value across the tree.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { UNAUTHENTICATED_EVENT } from "./api";

export interface SessionUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

interface AuthCtx {
  user: SessionUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) { setUser(null); return; }
      const data = await res.json();
      setUser(data.user);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
    }
  };

  useEffect(() => {
    refresh();
    const onUnauthed = () => setUser(null);
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthed);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthed);
  }, []);

  return <Ctx.Provider value={{ user, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useSession(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside <AuthProvider>");
  return ctx;
}
