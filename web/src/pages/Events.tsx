import { AnimatePresence, motion } from "framer-motion";
import { BellOff, CheckCheck, CheckCircle2, Download, Eye, FileSearch, Filter, MessageSquare, RefreshCw, Search, Siren, Sparkles, UserCheck, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AiResultCard } from "../components/CameraTile";
import { EventItem } from "../components/EventItem";
import { useToast } from "../components/toasts";
import { Empty, ErrorNote, PageHeader, Panel, SeverityBadge, Spinner, StatusBadge, Toggle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CATEGORY_LABEL, fmtAgo, fmtDateTime, SEVERITY_LABEL, STATUS_LABEL, TYPE_LABEL } from "../lib/format";
import { useApi, useLocalStorage } from "../lib/hooks";
import { useTopic } from "../lib/realtime";
import type { AlertCategory, Camera, EventStatus, SecEvent, Severity } from "../lib/types";

const SEVS: Severity[] = ["critical", "high", "medium", "low", "info"];
const MEDIUM_UP: Severity[] = ["critical", "high", "medium"];
const OPEN_STATUSES: EventStatus[] = ["new", "ack", "investigating"];
type BulkStatus = "ack" | "resolved" | "false_positive";

const MUTE_OPTIONS: Array<{ label: string; minutes: number | null; forever?: boolean }> = [
  { label: "1 hora", minutes: 60 },
  { label: "8 horas", minutes: 480 },
  { label: "24 horas", minutes: 1440 },
  { label: "7 días", minutes: 10_080 },
  { label: "Siempre", minutes: null, forever: true },
];

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
  const [category, setCategory] = useState<AlertCategory | "">("");
  const [hideSilent, setHideSilent] = useLocalStorage("cia.events.hideSilent", true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const lastChecked = useRef<number | null>(null);
  const { data: cameras } = useApi<Camera[]>("/api/cameras");

  // Filtro común a la lista y a "reconocer todo lo filtrado" (bulk-status por filtro).
  const filter = useMemo(() => {
    const f: Record<string, string | number | boolean> = { since: Date.now() - hours * 3600_000 };
    if (status) f.status = status;
    if (sev.length) f.severity = sev.join(",");
    if (type) f.type = type;
    if (camera) f.camera = camera;
    if (q) f.q = q;
    if (category) f.category = category;
    if (hideSilent) f.silent = false;
    return f;
  }, [status, sev, type, camera, q, hours, category, hideSilent]);
  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: "300" });
    for (const [k, v] of Object.entries(filter)) p.set(k, k === "silent" ? (v ? "1" : "0") : String(v));
    return `/api/events?${p}`;
  }, [filter]);
  const { data: events, setData, loading, reload } = useApi<SecEvent[]>(query);
  const selectedId = params.get("id") ? Number(params.get("id")) : null;

  useEffect(() => {
    setSelected(new Set());
    setPending(0);
  }, [query]);

  const matches = (ev: SecEvent) =>
    (!sev.length || sev.includes(ev.severity)) &&
    (!camera || ev.cameraId === camera) &&
    (!type || ev.type === type) &&
    (!status || (status === "open" ? OPEN_STATUSES.includes(ev.status) : status === ev.status)) &&
    (!category || ev.category === category) &&
    (!hideSilent || !ev.silent) &&
    (!q || `${ev.title} ${ev.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  useTopic<SecEvent>("event.new", (ev) => {
    if (!matches(ev)) return;
    // Con filas seleccionadas no se mueve la lista: se ofrece actualizar.
    if (selected.size) setPending((n) => n + 1);
    else setData((cur) => (cur ? [ev, ...cur] : cur));
  });
  useTopic<SecEvent>("event.update", (ev) => setData((cur) => cur?.map((e) => (e.id === ev.id ? { ...e, ...ev } : e)) ?? cur));
  useTopic<{ ids: number[]; status: EventStatus; by: string; at: number }>("event.bulk", (b) => {
    const ids = new Set(b.ids);
    setData(
      (cur) =>
        cur?.map((e) =>
          ids.has(e.id)
            ? {
                ...e,
                status: b.status,
                ackBy: e.ackBy ?? b.by,
                ackAt: e.ackAt ?? b.at,
                ...(b.status === "ack" ? {} : { resolvedBy: b.by, resolvedAt: b.at }),
              }
            : e,
        ) ?? cur,
    );
  });

  const list = events ?? [];
  const openNew = list.filter((e) => e.status === "new");
  const selectedEvents = list.filter((e) => selected.has(e.id));
  const sharedCamera = selectedEvents.length && selectedEvents.every((e) => e.cameraId && e.cameraId === selectedEvents[0]!.cameraId) ? selectedEvents[0]!.cameraId : null;

  const toggle = (ev: SecEvent, checked: boolean, e: MouseEvent) => {
    setSelected((cur) => {
      const next = new Set(cur);
      // Shift+clic: selecciona el rango desde la última casilla tocada.
      if (e.shiftKey && lastChecked.current !== null) {
        const a = list.findIndex((x) => x.id === lastChecked.current);
        const b = list.findIndex((x) => x.id === ev.id);
        if (a >= 0 && b >= 0) for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) checked ? next.add(x.id) : next.delete(x.id);
      } else if (checked) next.add(ev.id);
      else next.delete(ev.id);
      return next;
    });
    lastChecked.current = ev.id;
  };

  const runBulk = async (status: BulkStatus, ids: number[]) => {
    setBusy(true);
    try {
      const r = await api.post<{ count: number }>("/api/events/bulk-status", { status, ids });
      toast({ tone: "ok", title: `${r.count} eventos marcados como "${STATUS_LABEL[status]}"` });
      setSelected(new Set());
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  const ackFiltered = async () => {
    const body = { status: "ack", filter: { ...filter, status: "new" } };
    try {
      const dry = await api.post<{ count: number }>("/api/events/bulk-status", { ...body, dryRun: true });
      if (!dry.count) return toast({ tone: "info", title: "No hay eventos nuevos con estos filtros" });
      if (!confirm(`¿Reconocer ${dry.count} eventos nuevos que coinciden con los filtros${dry.count >= 5000 ? " (máximo 5000 por vez)" : ""}?`)) return;
      const r = await api.post<{ count: number }>("/api/events/bulk-status", body);
      toast({ tone: "ok", title: `${r.count} eventos reconocidos` });
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    }
  };

  const muteCamera = async (cameraId: string, minutes: number) => {
    try {
      await api.post(`/api/cameras/${encodeURIComponent(cameraId)}/mute`, { minutes });
      toast({ tone: "ok", title: "Alertas de la cámara silenciadas", body: `Durante ${minutes / 60} h` });
      setSelected(new Set());
    } catch (e) {
      toast({ tone: "error", title: (e as ApiError).message });
    }
  };

  const exportCsv = () => {
    const rows = [["id", "fecha", "tipo", "severidad", "estado", "camara", "titulo", "descripcion", "ia_resumen", "atendido_por", "ocurrencias"]];
    for (const e of list)
      rows.push([
        String(e.id),
        fmtDateTime(e.ts),
        TYPE_LABEL[e.type] ?? e.type,
        SEVERITY_LABEL[e.severity],
        STATUS_LABEL[e.status],
        e.cameraName ?? "",
        e.title,
        e.description ?? "",
        e.ai?.summary ?? "",
        e.ackBy ?? "",
        String(e.occurrences ?? 1),
      ]);
    const blob = new Blob(["﻿" + rows.map((r) => r.map(csvEscape).join(";")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `eventos_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const operator = can("operator");
  const mediumUp = MEDIUM_UP.every((s) => sev.includes(s)) && sev.length === MEDIUM_UP.length;
  const chip = (active: boolean) => `rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-ink-2 hover:text-ink"}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Eventos y alertas"
        subtitle="Detecciones IA, alarmas de movimiento, caídas de equipos y VPN"
        icon={<Siren size={20} />}
        actions={
          <>
            {operator && openNew.length > 0 && (
              <button className="btn btn-sm" onClick={() => void ackFiltered()} title="Reconoce todos los eventos nuevos que coinciden con los filtros (no sólo los cargados)">
                <CheckCheck size={14} /> Reconocer todo lo filtrado
              </button>
            )}
            <button className="btn btn-sm" onClick={exportCsv} disabled={!list.length}>
              <Download size={14} /> CSV
            </button>
            <button className="btn btn-sm" onClick={() => void reload()}>
              <RefreshCw size={14} />
            </button>
          </>
        }
      />

      <Panel bodyClass="p-3 space-y-2">
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
        <div className="flex flex-wrap items-center gap-2">
          {(["security", "infra"] as AlertCategory[]).map((c) => (
            <button key={c} className={chip(category === c)} onClick={() => setCategory(category === c ? "" : c)}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
          <button className={chip(mediumUp)} onClick={() => setSev(mediumUp ? [] : MEDIUM_UP)}>
            ≥ Media
          </button>
          <div className="ml-auto">
            <Toggle checked={hideSilent} onChange={setHideSilent} label="Ocultar silenciados" />
          </div>
        </div>
      </Panel>

      {operator && selected.size > 0 && (
        <div className="sticky top-0 z-20 panel px-3 py-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold mr-2">{selected.size} seleccionados</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void runBulk("ack", [...selected])}>
            <Eye size={14} /> Reconocer ({selected.size})
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void runBulk("resolved", [...selected])}>
            <CheckCircle2 size={14} className="text-ok" /> Resolver ({selected.size})
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void runBulk("false_positive", [...selected])}>
            <XCircle size={14} className="text-muted" /> Falsa alarma ({selected.size})
          </button>
          {sharedCamera && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void muteCamera(sharedCamera, 60)}>
              <BellOff size={14} /> Silenciar cámara 1 h
            </button>
          )}
          <button className="btn btn-sm btn-ghost ml-auto" onClick={() => setSelected(new Set())}>
            Limpiar
          </button>
        </div>
      )}

      {pending > 0 && (
        <button className="w-full rounded-lg border border-accent/40 bg-accent/10 py-1.5 text-sm text-accent" onClick={() => (setPending(0), void reload())}>
          {pending} nuevos · actualizar
        </button>
      )}

      <div className="space-y-2">
        {loading && !events && (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        )}
        <AnimatePresence initial={false}>
          {list.map((ev) => (
            <EventItem
              key={ev.id}
              ev={ev}
              selectable={operator}
              checked={selected.has(ev.id)}
              onCheck={(checked, e) => toggle(ev, checked, e)}
              onClick={() => setParams({ ...Object.fromEntries(params), id: String(ev.id) })}
            />
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
  const group = ev?.meta?.group === true ? ((ev.meta.cameras as Array<{ id: string; name: string }>) ?? []) : null;
  const recoveredIds = new Set(((ev?.meta?.recovered as Array<{ id: string }> | undefined) ?? []).map((r) => r.id));
  const mute = (opt: (typeof MUTE_OPTIONS)[number] | null) =>
    ev?.cameraId &&
    act(
      () => api.post(`/api/cameras/${encodeURIComponent(ev.cameraId!)}/mute`, opt ? { minutes: opt.minutes, forever: opt.forever } : { minutes: null }),
      opt ? `Alertas de ${ev.cameraName ?? "la cámara"} silenciadas (${opt.label.toLowerCase()})` : "Alertas de la cámara reactivadas",
    );

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
              {((ev.occurrences ?? 1) > 1 || ev.silent || ev.meta?.flapping === true) && (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {(ev.occurrences ?? 1) > 1 && (
                    <span className="rounded-full border border-line px-2 py-0.5 text-ink-2">
                      Se repitió {ev.occurrences} veces · última {fmtAgo(ev.lastTs ?? ev.ts)}
                    </span>
                  )}
                  {ev.meta?.flapping === true && <span className="rounded-full border border-warn/50 px-2 py-0.5 text-warn">Inestable: se cae y vuelve</span>}
                  {ev.silent && (
                    <span className="rounded-full border border-line px-2 py-0.5 text-muted flex items-center gap-1">
                      <BellOff size={11} /> Silenciado (sin aviso)
                    </span>
                  )}
                </div>
              )}
            </div>

            {group && (
              <Panel title={`Cámaras afectadas (${group.length})`} bodyClass="p-3">
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">
                  {group.map((c) => (
                    <li key={c.id} className={`flex items-center gap-2 ${recoveredIds.has(c.id) ? "text-ok" : "text-ink-2"}`}>
                      {recoveredIds.has(c.id) ? <CheckCircle2 size={13} /> : <XCircle size={13} className="text-crit" />}
                      <span className="truncate">{c.name}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

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

            {ev.cameraId && can("operator") && (
              <div className="flex items-center gap-2">
                <BellOff size={14} className="text-muted" />
                <select
                  className="input !py-1.5"
                  value=""
                  disabled={busy}
                  aria-label="Silenciar cámara"
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "off") void mute(null);
                    else if (v) void mute(MUTE_OPTIONS[Number(v)]!);
                  }}
                >
                  <option value="">Silenciar cámara…</option>
                  {MUTE_OPTIONS.map((o, i) => (
                    <option key={o.label} value={i}>
                      {o.label}
                    </option>
                  ))}
                  <option value="off">Reactivar alertas</option>
                </select>
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
