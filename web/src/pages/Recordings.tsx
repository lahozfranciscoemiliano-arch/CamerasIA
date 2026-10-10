import { CalendarClock, Download, Film, Play, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, ErrorNote, Field, PageHeader, Panel, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtBytes, fmtDateTime, fmtHM, fmtTime } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { Camera, Clip, ExportJob, SecEvent } from "../lib/types";

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Recordings() {
  const { can } = useAuth();
  const { data: cameras } = useApi<Camera[]>("/api/cameras");
  const [camera, setCamera] = useState("");
  const [start, setStart] = useState(toLocalInput(new Date(Date.now() - 6 * 3600_000)));
  const [end, setEnd] = useState(toLocalInput(new Date()));
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [events, setEvents] = useState<SecEvent[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [clipLen, setClipLen] = useState(5);
  const [job, setJob] = useState<ExportJob | null>(null);
  const { data: jobs, reload: reloadJobs } = useApi<ExportJob[]>("/api/recordings/exports");

  useEffect(() => {
    if (!camera && cameras?.length) setCamera(cameras[0]!.id);
  }, [cameras, camera]);

  const range = useMemo(() => ({ s: new Date(start).getTime(), e: new Date(end).getTime() }), [start, end]);

  const search = async () => {
    if (!camera) return;
    setSearching(true);
    setError("");
    setCursor(null);
    try {
      const q = `start=${new Date(range.s).toISOString()}&end=${new Date(range.e).toISOString()}`;
      const [c, ev] = await Promise.all([
        api.get<Clip[]>(`/api/cameras/${encodeURIComponent(camera)}/recordings?${q}`),
        api.get<SecEvent[]>(`/api/events?camera=${encodeURIComponent(camera)}&since=${range.s}&until=${range.e}&limit=200`),
      ]);
      setClips(c);
      setEvents(ev);
    } catch (e) {
      setError((e as ApiError).message);
      setClips(null);
    } finally {
      setSearching(false);
    }
  };

  // Seguimiento de la exportación en curso
  useEffect(() => {
    if (!job || job.status === "ready" || job.status === "error") return;
    const t = setInterval(async () => {
      try {
        const j = await api.get<ExportJob>(`/api/recordings/export/${job.id}`);
        setJob(j);
        if (j.status === "ready" || j.status === "error") void reloadJobs();
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [job, reloadJobs]);

  const exportClip = async (from: number) => {
    setError("");
    try {
      const j = await api.post<ExportJob>("/api/recordings/export", { camera, start: new Date(from).toISOString(), end: new Date(from + clipLen * 60_000).toISOString() });
      setJob(j);
      void reloadJobs();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  const cam = cameras?.find((c) => c.id === camera);
  const span = Math.max(1, range.e - range.s);
  const pct = (t: number) => ((t - range.s) / span) * 100;

  return (
    <div className="space-y-4">
      <PageHeader title="Grabaciones" subtitle="Búsqueda en el archivo de exacqVision, línea de tiempo y exportación de clips" icon={<Film size={20} />} />

      <Panel title="Búsqueda" icon={<Search size={16} />}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <Field label="Cámara">
            <select className="input" value={camera} onChange={(e) => setCamera(e.target.value)}>
              {cameras?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.serverName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Desde">
            <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            {[1, 6, 24].map((h) => (
              <button
                key={h}
                className="btn btn-sm"
                onClick={() => {
                  setStart(toLocalInput(new Date(Date.now() - h * 3600_000)));
                  setEnd(toLocalInput(new Date()));
                }}
              >
                {h} h
              </button>
            ))}
            <button className="btn btn-primary flex-1" onClick={() => void search()} disabled={searching || !camera}>
              {searching ? <Spinner size={14} /> : <Search size={14} />} Buscar
            </button>
          </div>
        </div>
        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      </Panel>

      {clips && (
        <Panel title={`Línea de tiempo · ${cam?.name ?? ""}`} icon={<CalendarClock size={16} />} bodyClass="p-4 space-y-4">
          <div className="text-xs text-ink-2">
            {clips.length} segmentos grabados · {events.length} eventos en el período. Haga clic en la barra para elegir el instante.
          </div>
          <div
            className="relative h-16 rounded-lg bg-bg border border-line cursor-crosshair select-none"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              setCursor(range.s + ((e.clientX - r.left) / r.width) * span);
            }}
          >
            {clips.map((c, i) => (
              <div
                key={i}
                className="absolute top-3 h-6 rounded-sm bg-accent/40 border-x border-accent/70"
                style={{ left: `${Math.max(0, pct(new Date(c.start).getTime()))}%`, width: `${Math.max(0.2, pct(new Date(c.end).getTime()) - pct(new Date(c.start).getTime()))}%` }}
                title={`${fmtTime(c.start)} – ${fmtTime(c.end)}`}
              />
            ))}
            {events.map((ev) => (
              <button
                key={ev.id}
                className="absolute bottom-1 w-1.5 h-4 -ml-[3px] rounded-sm"
                style={{ left: `${pct(ev.ts)}%`, background: ev.severity === "critical" || ev.severity === "high" ? "#e5486e" : ev.severity === "medium" ? "#c98500" : "#3987e5" }}
                title={`${fmtTime(ev.ts)} · ${ev.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setCursor(ev.ts - 15_000);
                }}
              />
            ))}
            {cursor && <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_#fff]" style={{ left: `${pct(cursor)}%` }} />}
            <div className="absolute -bottom-5 left-0 right-0 flex justify-between text-[10px] text-muted font-mono">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i}>{fmtHM(range.s + (span * i) / 6)}</span>
              ))}
            </div>
          </div>
          <div className="pt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm">
              Instante seleccionado: <b className="font-mono">{cursor ? fmtDateTime(cursor) : "—"}</b>
            </span>
            <select className="input !w-auto !py-1.5" value={clipLen} onChange={(e) => setClipLen(Number(e.target.value))}>
              {[1, 2, 5, 10, 15, 30].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            {can("operator") && (
              <button className="btn btn-primary btn-sm" disabled={!cursor} onClick={() => cursor && void exportClip(cursor)}>
                <Play size={14} /> Reproducir / exportar clip
              </button>
            )}
          </div>
          {!clips.length && <Empty title="Sin grabaciones en el rango" />}
        </Panel>
      )}

      {job && <Player job={job} />}

      <Panel title="Exportaciones recientes (24 h)" icon={<Download size={16} />} actions={<button className="btn btn-sm btn-ghost" onClick={() => void reloadJobs()}><RefreshCw size={14} /></button>}>
        {jobs?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left label">
                <tr>
                  <th className="py-2 pr-3">Cámara</th>
                  <th className="pr-3">Desde</th>
                  <th className="pr-3">Hasta</th>
                  <th className="pr-3">Estado</th>
                  <th className="pr-3">Tamaño</th>
                  <th className="pr-3">Usuario</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-line-soft">
                    <td className="py-2 pr-3">{j.cameraName}</td>
                    <td className="pr-3 font-mono text-xs">{fmtDateTime(j.start)}</td>
                    <td className="pr-3 font-mono text-xs">{fmtDateTime(j.end)}</td>
                    <td className="pr-3">{j.status === "ready" ? <span className="text-ok">Listo</span> : j.status === "error" ? <span className="text-crit" title={j.error}>Error</span> : `${j.progress}%`}</td>
                    <td className="pr-3">{fmtBytes(j.bytes)}</td>
                    <td className="pr-3 text-ink-2">{j.createdBy}</td>
                    <td className="text-right">
                      <button className="btn btn-sm" onClick={() => setJob(j)} disabled={j.status !== "ready"}>
                        <Play size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-sm text-muted">Sin exportaciones todavía.</div>
        )}
      </Panel>
    </div>
  );
}

function Player({ job }: { job: ExportJob }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <Panel title={`Reproducción · ${job.cameraName} · ${fmtDateTime(job.start)}`} icon={<Play size={16} />} glow>
      {job.status === "ready" ? (
        job.kind === "mp4" ? (
          <div className="space-y-2">
            <video ref={videoRef} controls autoPlay className="w-full max-h-[70vh] rounded-lg bg-black" src={`/api/recordings/export/${job.id}/file`} />
            <a className="btn btn-sm" href={`/api/recordings/export/${job.id}/file?download=1`}>
              <Download size={14} /> Descargar MP4
            </a>
          </div>
        ) : (
          <div className="space-y-2">
            <img className="w-full max-h-[70vh] object-contain rounded-lg bg-black" alt="Reproducción" src={`/api/cameras/${encodeURIComponent(job.cameraKey)}/replay?start=${encodeURIComponent(job.start)}&speed=1`} />
            <p className="text-xs text-muted">Reproducción simulada (modo DEMO). Con exacqVision real se genera un MP4 vía export.web descargable.</p>
          </div>
        )
      ) : job.status === "error" ? (
        <ErrorNote>{job.error}</ErrorNote>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-ink-2">{job.status === "downloading" ? "Descargando clip desde el servidor…" : "El servidor exacqVision está generando el clip…"}</div>
          <div className="h-2 rounded bg-line-soft overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${job.progress}%` }} />
          </div>
        </div>
      )}
    </Panel>
  );
}
