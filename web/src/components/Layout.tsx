import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  BellOff,
  Bot,
  ChevronsLeft,
  Film,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorPlay,
  MoonStar,
  Network,
  Radar,
  Settings,
  ShieldHalf,
  Siren,
  UserCog,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAlerts } from "../lib/alerts";
import { fmtDuration, ROLE_LABEL } from "../lib/format";
import { useLocalStorage, useNow } from "../lib/hooks";
import { useRealtime, useTopic } from "../lib/realtime";
import type { EventStats, Threat, VpnStatus } from "../lib/types";
import { Dot } from "./ui";

const THREAT_COLORS = ["", "var(--color-ok)", "var(--color-info)", "var(--color-warn)", "var(--color-serious)", "var(--color-crit)"];

/** Campana: sonido, "no molestar" y acceso a las preferencias de alertas de esta consola. */
function AlertBell() {
  const { prefs, setPrefs, dndUntil, setDnd } = useAlerts();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", h);
    return () => window.removeEventListener("pointerdown", h);
  }, [open]);
  const dnd = dndUntil !== null && dndUntil > now;
  const item = "w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-panel-3";
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} title="Alertas de esta consola" aria-haspopup="menu" aria-expanded={open}>
        {dnd ? <MoonStar size={16} className="text-info" /> : prefs.muted ? <BellOff size={16} className="text-muted" /> : <Bell size={16} />}
        {dnd && <span className="hidden md:inline text-[11px] text-info">No molestar · {fmtDuration(dndUntil! - now)}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-2 z-50 w-64 rounded-xl border border-line bg-panel p-2 space-y-1 shadow-2xl">
          <button className={item} onClick={() => setPrefs({ ...prefs, muted: !prefs.muted })}>
            {prefs.muted ? "Activar sonidos" : "Silenciar sonidos"}
          </button>
          <div className="label !text-[10px] px-3 pt-2">No molestar</div>
          {[
            ["15 minutos", 15],
            ["1 hora", 60],
            ["4 horas", 240],
          ].map(([label, min]) => (
            <button key={label} className={item} onClick={() => (setDnd(min as number), setOpen(false))}>
              {label}
            </button>
          ))}
          <button className={item} onClick={() => (setDnd("morning"), setOpen(false))}>
            Hasta las 07:00
          </button>
          {dnd && (
            <button className={`${item} text-warn`} onClick={() => (setDnd(null), setOpen(false))}>
              Desactivar
            </button>
          )}
          <div className="border-t border-line-soft my-1" />
          <button className={item} onClick={() => (setOpen(false), navigate("/perfil#alertas"))}>
            Preferencias de alertas…
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { me, logout, can } = useAuth();
  const { connected } = useRealtime();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow();
  const [collapsed, setCollapsed] = useLocalStorage("cia.sidebar.collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [threat, setThreat] = useState<Threat | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [vpn, setVpn] = useState<VpnStatus | null>(null);

  const loadStats = () =>
    api
      .get<EventStats>("/api/events/stats?hours=24")
      .then((s) => {
        setThreat(s.threat);
        // El badge cuenta sólo lo que requiere atención (no silenciados, severidad media o más).
        setOpenCount(s.openAlerting ?? s.open);
      })
      .catch(() => undefined);
  // Ante ráfagas de eventos se recalcula una sola vez (1 s después del último).
  const statsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleStats = () => {
    clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => void loadStats(), 1000);
  };
  useEffect(() => () => clearTimeout(statsTimer.current), []);

  useEffect(() => {
    void loadStats();
    void api.get<VpnStatus>("/api/vpn/status").then(setVpn).catch(() => undefined);
    const t = setInterval(() => void loadStats(), 20_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  useTopic<VpnStatus>("vpn.status", setVpn);
  // Los avisos (toasts y sonido) los decide AlertsProvider a partir de alert.notify; aquí sólo se refrescan contadores.
  useTopic("event.new", scheduleStats);
  useTopic("event.update", scheduleStats);
  useTopic("event.bulk", scheduleStats);

  const nav = [
    { to: "/", label: "Tablero", icon: <LayoutDashboard size={18} />, end: true },
    { to: "/video", label: "Video en vivo", icon: <MonitorPlay size={18} /> },
    { to: "/grabaciones", label: "Grabaciones", icon: <Film size={18} /> },
    { to: "/eventos", label: "Eventos", icon: <Siren size={18} />, badge: openCount },
    { to: "/ia", label: "Asistente IA", icon: <Bot size={18} />, min: "operator" as const },
    { to: "/conectividad", label: "Conectividad", icon: <Network size={18} /> },
    { to: "/boveda", label: "Bóveda", icon: <KeyRound size={18} />, min: "tester" as const },
    { to: "/admin", label: "Administración", icon: <Settings size={18} />, min: "tester" as const },
  ].filter((n) => !n.min || can(n.min));

  const tColor = threat ? THREAT_COLORS[threat.level] : "var(--color-muted)";
  const vpnTone = vpn?.state === "connected" ? "ok" : vpn?.state === "connecting" || vpn?.state === "disconnecting" ? "warn" : vpn?.state === "error" ? "crit" : "muted";

  const sidebar = (
    <nav className="flex flex-col h-full">
      <div className="flex items-center gap-2.5 px-4 h-16 border-b border-line-soft shrink-0">
        <div className="relative w-9 h-9 rounded-lg grid place-items-center bg-accent/10 border border-accent/40 overflow-hidden">
          <Radar size={20} className="text-accent" />
          <span className="absolute inset-0 origin-center animate-sweep" style={{ background: "conic-gradient(from 0deg, rgba(34,211,238,.35), transparent 30%)" }} />
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="font-display font-bold tracking-[0.16em] text-[15px]">CAMERAS·IA</div>
            <div className="text-[10px] text-muted tracking-[0.2em] uppercase">Security Ops Center</div>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            title={collapsed ? n.label : undefined}
            className={({ isActive }) =>
              `group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-panel-3 hover:text-ink"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="nav-active" className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-accent shadow-[0_0_10px_#22d3ee]" />}
                {n.icon}
                {!collapsed && <span className="flex-1">{n.label}</span>}
                {!!n.badge && (
                  <span className={`${collapsed ? "absolute top-1 right-1" : ""} min-w-5 h-5 px-1.5 rounded-full bg-crit text-white text-[11px] font-bold grid place-items-center`}>
                    {n.badge > 99 ? "99+" : n.badge}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>
      <div className="border-t border-line-soft p-2 space-y-1">
        <NavLink to="/perfil" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink-2 hover:bg-panel-3 hover:text-ink">
          <UserCog size={18} />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-ink">{me?.user.displayName}</span>
              <span className="block text-[11px] text-muted">{me ? ROLE_LABEL[me.user.role] : ""}</span>
            </span>
          )}
        </NavLink>
        <button onClick={() => void logout()} className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink-2 hover:bg-crit/10 hover:text-crit">
          <LogOut size={18} />
          {!collapsed && "Cerrar sesión"}
        </button>
        <button onClick={() => setCollapsed(!collapsed)} className="hidden lg:flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-muted hover:text-ink">
          <ChevronsLeft size={16} className={`transition-transform ${collapsed ? "rotate-180" : ""}`} />
          {!collapsed && "Contraer"}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="h-full flex bg-radial">
      <aside className={`hidden lg:block shrink-0 border-r border-line-soft bg-bg-2/80 backdrop-blur transition-[width] duration-200 ${collapsed ? "w-[72px]" : "w-60"}`}>{sidebar}</aside>
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div className="fixed inset-0 z-40 bg-black/60 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileOpen(false)} />
            <motion.aside
              className="fixed z-50 inset-y-0 left-0 w-64 bg-bg-2 border-r border-line lg:hidden"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 400, damping: 40 }}
            >
              {sidebar}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="relative z-30 h-16 shrink-0 flex items-center gap-3 px-4 border-b border-line-soft bg-bg-2/60 backdrop-blur">
          <button className="lg:hidden btn btn-ghost btn-sm" onClick={() => setMobileOpen(true)} aria-label="Menú">
            <Menu size={18} />
          </button>
          {threat && (
            <button
              onClick={() => navigate("/eventos?status=open")}
              className="flex items-center gap-2.5 rounded-lg border px-3 py-1.5"
              style={{ borderColor: `color-mix(in oklab, ${tColor} 45%, transparent)`, background: `color-mix(in oklab, ${tColor} 10%, transparent)` }}
              title={`Puntaje ${threat.score} (eventos abiertos últimas 2 h)`}
            >
              <ShieldHalf size={18} style={{ color: tColor }} />
              <span className="hidden sm:block label !text-[10px]">Amenaza</span>
              <span className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((l) => (
                  <span key={l} className="w-1.5 h-4 rounded-sm transition-colors" style={{ background: l <= threat.level ? tColor : "var(--color-line)" }} />
                ))}
              </span>
              <span className="font-display font-bold tracking-wider text-sm" style={{ color: tColor }}>
                {threat.label}
              </span>
            </button>
          )}
          <button onClick={() => navigate("/conectividad")} className="hidden md:flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-xs hover:border-accent-dim">
            <Dot tone={vpnTone} pulse={vpn?.state === "connecting"} />
            <span className="font-semibold">FortiVPN</span>
            <span className="text-ink-2">
              {vpn?.state === "connected"
                ? `${vpn.assignedIp ?? ""} · ${fmtDuration(Date.now() - (vpn.since ?? Date.now()))}`
                : vpn?.state === "connecting"
                  ? "conectando…"
                  : vpn?.state === "error"
                    ? "error"
                    : "desconectada"}
            </span>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <AlertBell />
            <div className="hidden sm:flex items-center gap-2 text-xs">
              <Dot tone={connected ? "ok" : "crit"} pulse={connected} />
              <span className={`font-display font-bold tracking-[0.2em] ${connected ? "text-ok" : "text-crit"}`}>{connected ? "EN VIVO" : "SIN ENLACE"}</span>
            </div>
            <div className="text-right leading-tight">
              <div className="font-mono text-lg text-ink tabular-nums">{new Date(now).toLocaleTimeString("es-AR", { hour12: false })}</div>
              <div className="text-[10px] text-muted uppercase tracking-wider hidden sm:block">
                {new Date(now).toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "short" })}
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-y-auto bg-grid">
          <motion.div key={location.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="p-4 lg:p-6 max-w-[1800px] mx-auto">
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  );
}
