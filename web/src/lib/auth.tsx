import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { liveClient } from "./live";
import type { Me, Role } from "./types";

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (m: Me | null) => void;
  logout: () => Promise<void>;
  can: (role: Role) => boolean;
}

const Ctx = createContext<AuthCtx>(null!);
const RANK: Record<Role, number> = { viewer: 1, tester: 1, operator: 2, admin: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/api/auth/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => {
      liveClient.shutdown();
      setMe(null);
    });
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const logout = useCallback(async () => {
    liveClient.shutdown();
    await api.post("/api/auth/logout").catch(() => undefined);
    setMe(null);
  }, []);

  const can = useCallback((role: Role) => {
    if (!me) return false;
    if (role === "tester") return me.user.role === "tester" || me.user.role === "admin";
    return (RANK[me.user.role] ?? 0) >= (RANK[role] ?? Infinity);
  }, [me]);

  return <Ctx.Provider value={{ me, loading, refresh, setMe, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
