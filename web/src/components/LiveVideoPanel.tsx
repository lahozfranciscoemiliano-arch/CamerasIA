import { Gauge, MonitorPlay, Wand2 } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtAgo } from "../lib/format";
import { useApi } from "../lib/hooks";
import { Dot, ErrorNote, Panel, Spinner } from "./ui";

interface LiveProfileSummary {
  source: "auto" | "probe" | "manual";
  probedAt: number;
  resize: { kind: "param" | "fixed"; extra: string } | null;
  quality: { extra: string } | null;
  pipeline: { ok: boolean; speedup: number };
  recommendedConcurrency: number;
  baseline: { w: number; h: number; bytes: number; rttMs: number; quality: number | null } | null;
}

interface LiveStatsResponse {
  enabled: boolean;
  eventLoopMs: { p50: number; p99: number; max: number };
  servers: Array<{
    id: string;
    name: string;
    loops: number;
    inFlight: number;
    capacity: number;
    queued: number;
    upFps: number;
    upMbps: number;
    rttP50: number | null;
    rttP95: number | null;
    gridScale: number;
    breaker: "closed" | "open" | "half-open";
    dup: number;
    stale: number;
    errors: number;
  }>;
  cameras: Array<{ key: string; name: string; subs: number; pull: boolean; state: string; prio: string | null; targetFps: number; effFps: number; tierW: number | null; w: number | null; h: number | null; avgBytes: number; rttMs: number }>;
  connections: Array<{ user: string; subs: number; focus: number; droppedBackpressure: number; unacked: number }>;
  profiles: Array<{ id: string; name: string; enabled: boolean; profile: LiveProfileSummary | null }>;
}

interface ProbeResult {
  saved: boolean;
  profile: LiveProfileSummary;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

const SOURCE: Record<LiveProfileSummary["source"], string> = { auto: "automático", probe: "optimizado", manual: "manual" };

/**
 * Panel "Video en vivo" (Administrador y Tester): carga del hub por servidor y cámara, conexiones
 * y perfil de tamaño/calidad de cada exacqVision. El Administrador puede ejecutar y guardar la
 * optimización (con 2FA reciente); Tester la ejecuta sin guardar.
 */
export default function LiveVideoPanel() {
  const { can } = useAuth();
  const { data, reload } = useApi<LiveStatsResponse>("/api/live/stats", { interval: 5000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ server: string; r: ProbeResult } | null>(null);
  const [error, setError] = useState("");

  const probe = async (id: string, name: string) => {
    setBusy(id);
    setError("");
    setResult(null);
    try {
      const r = await api.post<ProbeResult>(`/api/exacq/servers/${id}/live-probe`);
      setResult({ server: name, r });
      void reload();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const fmtProfile = (p: LiveProfileSummary | null) => {
    if (!p) return "Sin perfil todavía: cuadros a resolución nativa (se prueba solo al primer uso).";
    const parts = [
      p.resize ? `tamaño: ${p.resize.extra}` : "sin cambio de tamaño",
      p.quality ? `calidad: ${p.quality.extra}` : "calidad fija",
      `${p.recommendedConcurrency} pedidos simultáneos`,
      p.pipeline.ok ? "pipelining OK" : "sin pipelining",
    ];
    return `${SOURCE[p.source]} · ${parts.join(" · ")}`;
  };

  return (
    <Panel
      title="Video en vivo"
      icon={<MonitorPlay size={16} />}
      bodyClass="p-3 space-y-3"
      actions={data && <span className={`text-[11px] ${data.enabled ? "text-ok" : "text-muted"}`}>{data.enabled ? "WebSocket activo" : "Deshabilitado (LIVE_ENABLED)"}</span>}
    >
      {!data ? (
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 text-xs text-ink-2">
            <span className="flex items-center gap-1.5">
              <Gauge size={13} className="text-accent" /> Demora del proceso p99: <b className={data.eventLoopMs.p99 > 100 ? "text-warn" : ""}>{data.eventLoopMs.p99} ms</b>
            </span>
            <span>Cámaras activas: <b>{data.cameras.length}</b></span>
            <span>Conexiones: <b>{data.connections.length}</b> ({data.connections.reduce((n, c) => n + c.subs, 0)} vistas)</span>
            <span>Descartes por contrapresión: <b>{data.connections.reduce((n, c) => n + c.droppedBackpressure, 0)}</b></span>
          </div>

          {data.servers.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="label text-left">
                  <tr>
                    <th className="py-1.5 pr-3">Servidor</th>
                    <th className="pr-3">Cámaras</th>
                    <th className="pr-3">En vuelo</th>
                    <th className="pr-3">Pedidos/s</th>
                    <th className="pr-3">Mbit/s</th>
                    <th className="pr-3">RTT p50/p95</th>
                    <th className="pr-3">Escala grilla</th>
                    <th className="pr-3">Disyuntor</th>
                    <th className="pr-3">Rep./tard./err.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.servers.map((s) => (
                    <tr key={s.id} className="border-t border-line-soft font-mono">
                      <td className="py-1.5 pr-3 font-sans">{s.name}</td>
                      <td className="pr-3">{s.loops}</td>
                      <td className="pr-3">
                        {s.inFlight}/{s.capacity}
                        {s.queued ? ` (+${s.queued})` : ""}
                      </td>
                      <td className="pr-3">{s.upFps}</td>
                      <td className="pr-3">{s.upMbps}</td>
                      <td className="pr-3">
                        {s.rttP50 ?? "-"}/{s.rttP95 ?? "-"} ms
                      </td>
                      <td className={`pr-3 ${s.gridScale < 1 ? "text-warn" : ""}`}>{Math.round(s.gridScale * 100)}%</td>
                      <td className="pr-3">
                        <Dot tone={s.breaker === "closed" ? "ok" : "crit"} /> {s.breaker === "closed" ? "normal" : s.breaker === "open" ? "abierto" : "probando"}
                      </td>
                      <td className="pr-3">
                        {s.dup}/{s.stale}/{s.errors}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.cameras.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-ink-2">Cámaras con video activo ({data.cameras.length})</summary>
              <ul className="mt-2 space-y-1 font-mono">
                {data.cameras.map((c) => (
                  <li key={c.key} className="flex flex-wrap gap-x-3">
                    <span className="font-sans text-ink">{c.name}</span>
                    <span>{c.state}</span>
                    <span>
                      {c.effFps}/{c.targetFps} fps
                    </span>
                    <span>{c.w && c.h ? `${c.w}×${c.h}` : "-"}</span>
                    <span>{Math.round(c.avgBytes / 1024)} KB</span>
                    <span>{c.rttMs} ms</span>
                    <span className="text-muted">
                      {c.subs} visor(es){c.pull ? " + HTTP" : ""} · {c.prio === "focus" ? "ampliada" : "grilla"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="space-y-2">
            <div className="label">Perfil de video por servidor exacqVision</div>
            {data.profiles.length === 0 && <div className="text-xs text-muted">No hay servidores exacqVision configurados.</div>}
            {data.profiles.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-muted">
                    {fmtProfile(p.profile)}
                    {p.profile?.baseline && ` · nativo ${p.profile.baseline.w}×${p.profile.baseline.h} (${Math.round(p.profile.baseline.bytes / 1024)} KB, ${p.profile.baseline.rttMs} ms)`}
                    {p.profile && ` · ${fmtAgo(p.profile.probedAt)}`}
                  </div>
                </div>
                {can("tester") && p.enabled && (
                  <button className="btn btn-sm" disabled={busy !== null} onClick={() => void probe(p.id, p.name)} title="Prueba qué tamaño y calidad de imagen acepta el servidor y cuántos pedidos simultáneos soporta">
                    {busy === p.id ? <Spinner size={14} /> : <Wand2 size={14} />}
                    {can("admin") ? "Optimizar video en vivo" : "Probar (sin guardar)"}
                  </button>
                )}
              </div>
            ))}
          </div>

          <ErrorNote>{error}</ErrorNote>
          {result && (
            <div className="rounded-lg border border-line-soft p-2.5 text-xs space-y-1">
              <div className="font-medium text-sm">
                {result.server}: {result.r.saved ? "perfil guardado" : "resultado (no guardado)"}
              </div>
              <ul className="space-y-0.5">
                {result.r.steps.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <Dot tone={s.ok ? "ok" : "muted"} />
                    <span className="text-ink-2">{s.step}</span>
                    <span className="text-muted">{s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
