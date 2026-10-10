import { AnimatePresence } from "framer-motion";
import { Activity, BarChart3, BrainCircuit, Cctv, Clock, Cpu, Gauge, LayoutGrid, Network, Radio, Server, ShieldAlert, Siren, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import CameraTile from "../components/CameraTile";
import { EventItem } from "../components/EventItem";
import { Meter, RankBars, SERIES, ThreatGauge, TimelineChart, typeItems } from "../components/charts";
import { Dot, Empty, Panel, Spinner, StatTile } from "../components/ui";
import { fmtAgo, fmtBytes, fmtDuration } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useTopic } from "../lib/realtime";
import type { Camera, Dashboard as Dash, Host, SecEvent, VpnStatus } from "../lib/types";

const KIND_LABEL: Record<string, string> = { exacq: "exacqVision", fortigate: "FortiGate", nvr: "NVR", camera: "Cámara", switch: "Switch", server: "Servidor", other: "Equipo" };

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, setData, loading, reload } = useApi<Dash>("/api/dashboard", { interval: 15_000 });
  // Refresco agrupado ante cambios de eventos, para que KPIs y nivel de amenaza coincidan con la barra superior.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleReload = () => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void reload(), 1200);
  };
  useEffect(() => () => clearTimeout(reloadTimer.current), []);
  const { data: cameras } = useApi<Camera[]>("/api/cameras", { interval: 60_000 });
  const [recent, setRecent] = useState<SecEvent[] | null>(null);

  const events = recent ?? data?.recent ?? [];

  useTopic<SecEvent>("event.new", (ev) => {
    // Actualización funcional: en una ráfaga no se pierde ningún evento. Los silenciados no van al feed.
    if (!ev.silent) setRecent((cur) => [ev, ...(cur ?? data?.recent ?? [])].slice(0, 14));
    scheduleReload();
  });
  useTopic<SecEvent>("event.update", (ev) => {
    setRecent((cur) => (cur ?? data?.recent ?? []).map((e) => (e.id === ev.id ? ev : e)));
    scheduleReload();
  });
  useTopic<{ ids: number[]; status: SecEvent["status"] }>("event.bulk", (b) => {
    const ids = new Set(b.ids);
    setRecent((cur) => (cur ?? data?.recent ?? []).map((e) => (ids.has(e.id) ? { ...e, status: b.status } : e)));
    scheduleReload();
  });
  useTopic<VpnStatus>("vpn.status", (vpn) => setData((d) => (d ? { ...d, vpn } : d)));
  useTopic<{ hosts: Host[] }>("health.update", (h) => setData((d) => (d ? { ...d, hosts: h.hosts } : d)));

  // Cámaras destacadas: las que tuvieron más eventos en 24 h (o las primeras).
  const featured = useMemo(() => {
    if (!cameras || !data) return [];
    const ranked = data.stats.byCamera.map((c) => cameras.find((x) => x.id === c.cameraId)).filter((c): c is Camera => Boolean(c?.online));
    const rest = cameras.filter((c) => c.online && !ranked.includes(c));
    return [...ranked, ...rest].slice(0, 4);
  }, [cameras, data]);

  if (loading && !data) return <div className="grid place-items-center h-[60vh]"><Spinner size={28} /></div>;
  if (!data) return <Empty title="No se pudo cargar el tablero" />;

  const s = data.stats;
  const vpn = data.vpn;
  const hostsDown = data.hosts.filter((h) => h.status === "down").length;
  const mem = data.system.memTotal - data.system.memFree;

  return (
    <div className="space-y-4">
      {data.demo && (
        <div className="flex items-center gap-2 rounded-lg border border-ai/30 bg-ai/10 px-3 py-2 text-xs text-[#e4dcff]">
          <Sparkles size={14} className="text-ai" />
          <span>
            <b>Modo DEMO</b>: cámaras, eventos y equipos simulados. Configure sus servidores exacqVision y el perfil FortiVPN en Administración / Conectividad y
            luego desactive <code className="font-mono">DEMO_MODE</code>.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile
          label="Cámaras en línea"
          value={data.cameras.online}
          suffix={`/ ${data.cameras.total}`}
          icon={<Cctv size={18} />}
          tone={data.cameras.offline.length ? "warn" : "ok"}
          hint={
            [data.cameras.offline.length ? `${data.cameras.offline.length} sin señal` : "Todas operativas", data.cameras.vmsDisabled ? `${data.cameras.vmsDisabled} deshabilitadas en exacq` : ""]
              .filter(Boolean)
              .join(" · ")
          }
        />
        <StatTile
          label="Eventos abiertos"
          value={s.openAlerting ?? s.open}
          icon={<Siren size={18} />}
          tone={s.openCritical ? "crit" : (s.openAlerting ?? s.open) ? "warn" : "ok"}
          hint={`${s.openCritical} de severidad alta/crítica`}
        />
        <StatTile label="Eventos 24 h" value={s.total} icon={<Activity size={18} />} tone="info" hint={`${s.bySeverity.critical ?? 0} críticos · ${s.bySeverity.high ?? 0} altos`} />
        <StatTile label="Verificados por IA" value={s.aiVerified} icon={<BrainCircuit size={18} />} tone="ai" hint={`${data.ai.engine.aiDismissed} falsas alarmas descartadas`} />
        <StatTile label="Tiempo de reconocimiento" value={(s.mttaMs ?? 0) / 60000} format={(n) => n.toFixed(1)} suffix="min" icon={<Clock size={18} />} tone="accent" hint="Promedio (MTTA) 24 h" />
        <StatTile
          label="FortiVPN"
          value={vpn.state === "connected" ? (Date.now() - (vpn.since ?? Date.now())) / 60000 : 0}
          format={(n) => (vpn.state === "connected" ? fmtDuration(n * 60000) : vpn.state === "connecting" ? "…" : "OFF")}
          icon={<Radio size={18} />}
          tone={vpn.state === "connected" ? "ok" : vpn.state === "error" ? "crit" : "warn"}
          hint={vpn.state === "connected" ? `${vpn.profileName} · ${vpn.assignedIp}` : vpn.error ?? "Túnel inactivo"}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel title="Actividad de eventos · 24 h" icon={<BarChart3 size={16} />} className="xl:col-span-2" bodyClass="p-3 h-[260px]">
          <TimelineChart stats={s} />
        </Panel>
        <Panel title="Nivel de amenaza" icon={<ShieldAlert size={16} />} glow bodyClass="p-4 flex flex-col justify-center gap-4">
          <ThreatGauge {...data.threat} />
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Críticos", v: s.bySeverity.critical ?? 0, c: "var(--color-crit)" },
              { label: "Altos", v: s.bySeverity.high ?? 0, c: "var(--color-serious)" },
              { label: "Medios", v: s.bySeverity.medium ?? 0, c: "var(--color-warn)" },
            ].map((x) => (
              <div key={x.label} className="rounded-lg bg-bg/50 border border-line-soft py-2">
                <div className="font-display text-xl font-bold text-ink">{x.v}</div>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: x.c }}>
                  {x.label}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <Panel
          title="Feed de eventos en vivo"
          icon={<Siren size={16} />}
          className="xl:col-span-4"
          bodyClass="p-3 h-[420px] overflow-y-auto"
          actions={
            <button className="btn btn-sm btn-ghost text-accent" onClick={() => navigate("/eventos")}>
              Ver todos
            </button>
          }
        >
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {events.map((ev) => (
                <EventItem key={ev.id} ev={ev} dense onClick={() => navigate(`/eventos?id=${ev.id}`)} />
              ))}
            </AnimatePresence>
            {!events.length && <Empty title="Sin eventos" />}
          </div>
        </Panel>

        <Panel
          title="Cámaras destacadas"
          icon={<LayoutGrid size={16} />}
          className="xl:col-span-5"
          bodyClass="p-3"
          actions={
            <button className="btn btn-sm btn-ghost text-accent" onClick={() => navigate("/video")}>
              Video wall
            </button>
          }
        >
          <div className="grid grid-cols-2 gap-2">
            {featured.map((c) => (
              <CameraTile key={c.id} camera={c} fps={1} onExpand={() => navigate(`/video?cam=${encodeURIComponent(c.id)}`)} />
            ))}
            {!featured.length && <Empty icon={<Cctv />} title="Sin cámaras en línea" />}
          </div>
        </Panel>

        <Panel title="Infraestructura" icon={<Network size={16} />} className="xl:col-span-3" bodyClass="p-3 space-y-3 h-[420px] overflow-y-auto">
          <div>
            <div className="label mb-2">Servidores de video</div>
            <ul className="space-y-1.5">
              {data.sources.map((src) => (
                <li key={src.id} className="flex items-center gap-2 text-sm">
                  <Dot tone={src.ok ? "ok" : "crit"} pulse={!src.ok} />
                  <span className="truncate flex-1">{src.name}</span>
                  <span className="text-[11px] text-muted font-mono">{src.ok ? `${src.latencyMs ?? "-"} ms` : "error"}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="label mb-2 flex items-center gap-2">
              Equipos monitoreados {hostsDown > 0 && <span className="text-crit normal-case tracking-normal">({hostsDown} caídos)</span>}
            </div>
            <ul className="space-y-1.5">
              {data.hosts.map((h) => (
                <li key={h.id} className="flex items-center gap-2 text-sm" title={`${h.host}:${h.port}`}>
                  <Dot tone={h.status === "up" ? "ok" : h.status === "down" ? "crit" : "muted"} pulse={h.status === "down"} />
                  <span className="truncate flex-1">{h.name}</span>
                  <span className="text-[10px] text-muted">{KIND_LABEL[h.kind] ?? h.kind}</span>
                  <span className="w-14 text-right text-[11px] font-mono text-ink-2">{h.status === "up" ? `${h.latencyMs} ms` : h.status === "down" ? "DOWN" : "—"}</span>
                </li>
              ))}
              {!data.hosts.length && <li className="text-xs text-muted">Agregue equipos en Conectividad.</li>}
            </ul>
          </div>
          <div className="space-y-2.5">
            <div className="label">Servidor del SOC · {data.system.hostname}</div>
            <Meter label={`CPU (${data.system.cores} núcleos)`} value={data.system.cpuPct} max={100} format={(v) => `${Math.round(v)}%`} />
            <Meter label="Memoria" value={mem} max={data.system.memTotal} format={(v) => fmtBytes(v)} />
            {data.system.disk && <Meter label="Disco (datos)" value={data.system.disk.total - data.system.disk.free} max={data.system.disk.total} format={(v) => fmtBytes(v)} />}
            <div className="text-[11px] text-muted">Proceso activo hace {fmtDuration(data.system.processUptimeSec * 1000)}</div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Panel title="Eventos por tipo · 24 h" icon={<BarChart3 size={16} />}>
          <RankBars items={typeItems(s)} />
        </Panel>
        <Panel title="Cámaras con más actividad" icon={<Cctv size={16} />}>
          <RankBars items={s.byCamera.map((c) => ({ label: c.cameraName, value: c.count }))} color={SERIES.low} />
        </Panel>
        <Panel title="Motor de detección e IA" icon={<Cpu size={16} />} bodyClass="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Dot tone={data.ai.available ? "ai" : "muted"} pulse={data.ai.available} />
            <span>{data.ai.available ? `Claude conectado · ${data.ai.model}` : "IA no configurada (cargue la API key en la Bóveda)"}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center">
            {[
              { l: "Cuadros analizados", v: data.ai.engine.framesAnalyzed },
              { l: "Alertas de movimiento", v: data.ai.engine.motionEvents },
              { l: "Verificaciones IA", v: data.ai.engine.aiVerified },
              { l: "Falsas alarmas filtradas", v: data.ai.engine.aiDismissed },
            ].map((x) => (
              <div key={x.l} className="rounded-lg bg-bg/50 border border-line-soft py-2">
                <div className="font-display text-xl font-bold">{x.v}</div>
                <div className="text-[10px] text-muted uppercase tracking-wider">{x.l}</div>
              </div>
            ))}
          </div>
          <Meter label="Presupuesto IA (última hora)" value={data.ai.budget.usedLastHour} max={data.ai.budget.maxPerHour} format={(v) => `${v} / ${data.ai.budget.maxPerHour}`} />
          <div className="text-[11px] text-muted flex items-center gap-1">
            <Gauge size={12} /> {data.cameras.detection} cámaras con detección · {data.cameras.aiVerify} con verificación IA
          </div>
          <div className="text-[11px] text-muted flex items-center gap-1">
            <Server size={12} /> Actualizado {fmtAgo(data.now)}
          </div>
        </Panel>
      </div>
    </div>
  );
}
