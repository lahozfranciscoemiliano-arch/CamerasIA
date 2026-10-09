import { AnimatePresence, motion } from "framer-motion";
import { CheckCheck, CheckCircle2, Download, Eye, FileSearch, Filter, MessageSquare, RefreshCw, Search, Siren, Sparkles, UserCheck, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AiResultCard } from "../components/CameraTile";
import { EventItem } from "../components/EventItem";
import { useToast } from "../components/toasts";
import { Empty, ErrorNote, PageHeader, Panel, SeverityBadge, Spinner, StatusBadge } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, SEVERITY_LABEL, STATUS_LABEL, TYPE_LABEL } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useTopic } from "../lib/realtime";
import type { Camera, EventStatus, SecEvent, Severity } from "../lib/types";

const SEVS: Severity[] = ["critical", "high", "medium", "low", "info"];

function csvEscape(v: unknown) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function Events() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [sev, setSev] = useState<Severity[]>([]);
  const [type, setType] = useState("");
  const [camera, setCamera] = useState("");
  const [q, setQ] = useState("");
  const [hours, setHours] = useState(24);
  const { data: cameras } = useApi<Camera[]>("/api/cameras");

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: "300", since: String(Date.now() - hours * 3600_000) });
    if (status) p.set("status", status);
    if (sev.length) p.set("severity", sev.join(","));
    if (type) p.set("type", type);
    if (camera) p.set("camera", camera);
    if (q) p.set("q", q);
    return `/api/events?${p}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sev, type, camera, q, hours]);
  const { data: events, setData, loading, reload } = useApi<SecEvent[]>(query);
  const selectedId = params.get("id") ? Number(params.get("id")) : null;

  useTopic<SecEvent>("event.new", (ev) => {
    if ((!sev.length || sev.includes(ev.severity)) && (!camera || ev.cameraId === camera) && (!type || ev.type === type) && (!status || status === "open" || status === ev.status))
      setData((cur) => (cur ? [ev, ...cur] : cur));
  });
  useTopic<SecEvent>("event.update", (ev) => setData((cur) => cur?.map((e) => (e.id === ev.id ? { ...e, ...ev } : e)) ?? cur));

  const openNew = (events ?? []).filter((e) => e.status === "new");

  const exportCsv = () => {
    const rows = [["id", "fecha", "tipo", "severidad", "estado", "camara", "titulo", "descripcion", "ia_resumen", "atendido_por"]];
    for (const e of events ?? [])
      rows.push([String(e.id), fmtDateTime(e.ts), TYPE_LABEL[e.type] ?? e.type, SEVERITY_LABEL[e.severity], STATUS_LABEL[e.status], e.cameraName ?? "", e.title, e.description ?? "", e.ai?.summary ?? "", e.ackBy ?? ""]);
    const blob = new Blob(["﻿" + rows.map((r) => r.map(csvEscape).join(";")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `eventos_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const ackAll = async () => {
    await api.post("/api/events/ack-all", { ids: openNew.map((e) => e.id) });
    toast({ tone: "ok", title: `${openNew.length} eventos reconocidos` });
    void reload();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Eventos y alertas"
        subtitle="Detecciones IA, alarmas de movimiento, caídas de equipos y VPN"
        icon={<Siren size={20} />}
        actions={
          <>
            {can("operator") && openNew.length > 0 && (
              <button className="btn btn-sm" onClick={() => void ackAll()}>
                <CheckCheck size={14} /> Reconocer {openNew.length} nuevos
              </button>
            )}
            <button className="btn btn-sm" onClick={exportCsv} disabled={!events?.length}>
              <Download size={14} /> CSV
            </button>
            <button className="btn btn-sm" onClick={() => void reload()}>
              <RefreshCw size={14} />
            </button>
          </>
        }
      />

      <Panel bodyClass="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Filter size={15} className="text-muted" />
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input !py-1.5 pl-8 w-52" placeholder="Buscar texto" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="input !w-auto !py-1.5" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos los estados</option>
            <option value="open">Abiertos</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select className="input !w-auto !py-1.5" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todos los tipos</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select className="input !w-auto !py-1.5" value={camera} onChange={(e) => setCamera(e.target.value)}>
            <option value="">Todas las cámaras</option>
            {cameras?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="input !w-auto !py-1.5" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 6, 12, 24, 72, 168, 720].map((h) => (
              <option key={h} value={h}>
                Últimas {h >= 24 ? `${h / 24} d` : `${h} h`}
              </option>
            ))}
          </select>
          <div className="flex gap-1">
            {SEVS.map((s) => (
              <button key={s} onClick={() => setSev((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))} className={`rounded-md transition-opacity ${sev.length && !sev.includes(s) ? "opacity-35" : ""}`}>
                <SeverityBadge severity={s} />
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <div className="space-y-2">
        {loading && !events && <div className="grid place-items-center py-10"><Spinner /></div>}
        <AnimatePresence initial={false}>
          {events?.map((ev) => (
            <EventItem key={ev.id} ev={ev} onClick={() => setParams({ ...Object.fromEntries(params), id: String(ev.id) })} />
          ))}
        </AnimatePresence>
        {events && !events.length && <Empty icon={<FileSearch size={28} />} title="Sin eventos para los filtros elegidos" />}
      </div>

      <AnimatePresence>
        {selectedId && (
          <EventDrawer
            id={selectedId}
            onClose={() => {
              const p = new URLSearchParams(params);
              p.delete("id");
              setParams(p);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function EventDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: ev, setData, reload } = useApi<SecEvent>(`/api/events/${id}`);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useTopic<SecEvent>("event.update", (u) => u.id === id && setData((cur) => (cur ? { ...cur, ...u } : cur)));
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (okMsg) toast({ tone: "ok", title: okMsg });
      await reload();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: EventStatus) => act(() => api.post(`/api/events/${id}/status`, { status }), `Evento marcado como "${STATUS_LABEL[status]}"`);
  const box = ev?.meta?.box as { x: number; y: number; w: number; h: number } | undefined;

  return (
    <>
      <motion.div className="fixed inset-0 z-40 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        className="fixed z-50 inset-y-0 right-0 w-full max-w-xl bg-bg-2 border-l border-line overflow-y-auto"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 40 }}
      >
        <header className="sticky top-0 z-10 flex items-center gap-2 px-5 py-3 border-b border-line-soft bg-bg-2/95 backdrop-blur">
          <span className="font-display text-lg tracking-wide">Evento #{id}</span>
          {ev && <SeverityBadge severity={ev.severity} />}
          {ev && <StatusBadge status={ev.status} />}
          <button className="ml-auto btn btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </header>
        {!ev ? (
          <div className="grid place-items-center py-20"><Spinner /></div>
        ) : (
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-lg font-semibold leading-snug">{ev.title}</h2>
              <div className="text-xs text-muted mt-1 flex flex-wrap gap-x-3">
                <span>{fmtDateTime(ev.ts)}</span>
                <span>{TYPE_LABEL[ev.type] ?? ev.type}</span>
                {ev.cameraName && <span>Cámara: {ev.cameraName}</span>}
                <span>Origen: {ev.source}</span>
              </div>
              {ev.description && <p className="text-sm text-ink-2 mt-2">{ev.description}</p>}
            </div>

            {ev.hasSnapshot && (
              <div className="relative rounded-lg overflow-hidden border border-line">
                <img src={`/api/events/${ev.id}/snapshot`} alt="Captura del evento" className="w-full" />
                {box && (
                  <div className="absolute border-2 border-warn shadow-[0_0_12px_#ffb020]" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}>
                    <span className="absolute -top-5 left-0 text-[10px] bg-warn text-black px-1 font-bold">MOVIMIENTO</span>
                  </div>
                )}
              </div>
            )}

            {ev.ai ? (
              <AiResultCard result={ev.ai} />
            ) : (
              ev.hasSnapshot &&
              can("operator") && (
                <button className="btn btn-ai w-full" disabled={busy} onClick={() => void act(() => api.post(`/api/events/${id}/analyze`), "Análisis IA completado")}>
                  {busy ? <Spinner size={14} /> : <Sparkles size={14} />} Analizar con IA
                </button>
              )
            )}

            <ErrorNote>{error}</ErrorNote>

            {can("operator") && (
              <div className="grid grid-cols-2 gap-2">
                <button className="btn" disabled={busy || ev.status === "ack"} onClick={() => void setStatus("ack")}>
                  <Eye size={14} /> Reconocer
                </button>
                <button className="btn" disabled={busy || ev.status === "investigating"} onClick={() => void setStatus("investigating")}>
                  <FileSearch size={14} /> Investigar
                </button>
                <button className="btn" disabled={busy || ev.status === "resolved"} onClick={() => void setStatus("resolved")}>
                  <CheckCircle2 size={14} className="text-ok" /> Resolver
                </button>
                <button className="btn" disabled={busy || ev.status === "false_positive"} onClick={() => void setStatus("false_positive")}>
                  <XCircle size={14} className="text-muted" /> Falsa alarma
                </button>
                <button className="btn col-span-2" disabled={busy} onClick={() => void act(() => api.post(`/api/events/${id}/assign`, { assignee: ev.assignedTo === me?.user.username ? null : me?.user.username }), "Asignación actualizada")}>
                  <UserCheck size={14} /> {ev.assignedTo === me?.user.username ? "Liberar asignación" : "Asignarme este evento"}
                </button>
              </div>
            )}

            {ev.cameraId && (
              <div className="flex gap-2">
                <button className="btn btn-sm flex-1" onClick={() => navigate(`/video?cam=${encodeURIComponent(ev.cameraId!)}`)}>
                  Ver en vivo
                </button>
                <button className="btn btn-sm flex-1" onClick={() => navigate(`/grabaciones`)}>
                  Ir a grabaciones
                </button>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-2 text-xs">
              {[
                ["Asignado a", ev.assignedTo ?? "—"],
                ["Reconocido por", ev.ackBy ? `${ev.ackBy} · ${fmtDateTime(ev.ackAt)}` : "—"],
                ["Cerrado por", ev.resolvedBy ? `${ev.resolvedBy} · ${fmtDateTime(ev.resolvedAt)}` : "—"],
                ["Fuente", ev.source],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-panel border border-line-soft p-2">
                  <dt className="label !text-[10px]">{k}</dt>
                  <dd className="mt-0.5 text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>

            <Panel title="Bitácora del evento" icon={<MessageSquare size={14} />} bodyClass="p-3 space-y-2">
              {(ev.notes ?? []).map((n) => (
                <div key={n.id} className="text-sm rounded-lg bg-bg/60 border border-line-soft p-2">
                  <div className="text-[11px] text-muted mb-0.5">
                    {n.username} · {fmtDateTime(n.ts)}
                  </div>
                  {n.text}
                </div>
              ))}
              {!ev.notes?.length && <div className="text-xs text-muted">Sin notas.</div>}
              {can("operator") && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!note.trim()) return;
                    void act(() => api.post(`/api/events/${id}/notes`, { text: note }).then(() => setNote("")));
                  }}
                >
                  <input className="input !py-1.5" placeholder="Agregar nota (acciones tomadas, contacto con guardia…)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="btn btn-sm" disabled={!note.trim() || busy}>
                    Agregar
                  </button>
                </form>
              )}
            </Panel>
          </div>
        )}
      </motion.aside>
    </>
  );
}
