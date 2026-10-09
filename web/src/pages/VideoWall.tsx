import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Expand, Grid2x2, Grid3x3, LayoutGrid, MonitorPlay, Pause, Play, Search, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import CameraTile from "../components/CameraTile";
import { Empty, PageHeader, Spinner } from "../components/ui";
import { useApi, useLocalStorage } from "../lib/hooks";
import { useTopic } from "../lib/realtime";
import type { Camera } from "../lib/types";

const LAYOUTS = [
  { n: 1, cols: "grid-cols-1", icon: <Square size={15} />, fps: 4 },
  { n: 4, cols: "grid-cols-1 sm:grid-cols-2", icon: <Grid2x2 size={15} />, fps: 2 },
  { n: 9, cols: "grid-cols-2 md:grid-cols-3", icon: <Grid3x3 size={15} />, fps: 1 },
  { n: 16, cols: "grid-cols-2 md:grid-cols-4", icon: <LayoutGrid size={15} />, fps: 1 },
];

export default function VideoWall() {
  const [params, setParams] = useSearchParams();
  const { data: cameras, setData } = useApi<Camera[]>("/api/cameras", { interval: 30_000 });
  const [layoutN, setLayoutN] = useLocalStorage("cia.wall.layout", 9);
  const [filter, setFilter] = useState("");
  const [onlyOnline, setOnlyOnline] = useLocalStorage("cia.wall.online", false);
  const [page, setPage] = useState(0);
  const [tour, setTour] = useState(false);
  const wallRef = useRef<HTMLDivElement>(null);
  const focused = params.get("cam");

  useTopic<Camera>("camera.status", (c) => setData((all) => all?.map((x) => (x.id === c.id ? { ...x, online: c.online } : x)) ?? all));

  const list = useMemo(
    () =>
      (cameras ?? []).filter(
        (c) => c.enabled && (!onlyOnline || c.online) && (!filter || `${c.name} ${c.zone ?? ""} ${c.serverName}`.toLowerCase().includes(filter.toLowerCase())),
      ),
    [cameras, filter, onlyOnline],
  );
  const layout = LAYOUTS.find((l) => l.n === layoutN) ?? LAYOUTS[2]!;
  const pages = Math.max(1, Math.ceil(list.length / layout.n));
  const current = list.slice(page * layout.n, page * layout.n + layout.n);

  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages]);

  // Ronda automática ("guard tour"): rota páginas cada 15 s.
  useEffect(() => {
    if (!tour) return;
    const t = setInterval(() => setPage((p) => (p + 1) % pages), 15_000);
    return () => clearInterval(t);
  }, [tour, pages]);

  const focusCam = focused ? (cameras ?? []).find((c) => c.id === focused) : undefined;

  if (!cameras) return <div className="grid place-items-center h-[60vh]"><Spinner size={28} /></div>;

  return (
    <div>
      <PageHeader
        title="Video en vivo"
        subtitle={`${list.length} cámaras · ${cameras.filter((c) => c.online).length} en línea`}
        icon={<MonitorPlay size={20} />}
        actions={
          <>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input className="input !py-1.5 pl-8 w-48" placeholder="Buscar cámara / zona" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={onlyOnline} onChange={(e) => setOnlyOnline(e.target.checked)} /> Sólo en línea
            </label>
            <div className="flex rounded-lg border border-line overflow-hidden">
              {LAYOUTS.map((l) => (
                <button key={l.n} className={`px-2.5 py-1.5 ${layoutN === l.n ? "bg-accent/15 text-accent" : "text-ink-2 hover:bg-panel-3"}`} onClick={() => setLayoutN(l.n)} title={`${l.n} cámaras`}>
                  {l.icon}
                </button>
              ))}
            </div>
            <button className={`btn btn-sm ${tour ? "btn-primary" : ""}`} onClick={() => setTour(!tour)} title="Ronda automática">
              {tour ? <Pause size={14} /> : <Play size={14} />} Ronda
            </button>
            <button className="btn btn-sm" onClick={() => void wallRef.current?.requestFullscreen?.()} title="Pantalla completa">
              <Expand size={14} />
            </button>
          </>
        }
      />

      <div ref={wallRef} className="bg-bg rounded-xl p-2 border border-line-soft">
        {current.length ? (
          <AnimatePresence mode="wait">
            <motion.div key={`${page}-${layoutN}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={`grid ${layout.cols} gap-2`}>
              {current.map((c) => (
                <CameraTile key={c.id} camera={c} fps={layout.fps} mode={layout.n === 1 ? "stream" : "poll"} big={layout.n <= 4} onExpand={() => setParams({ cam: c.id })} />
              ))}
            </motion.div>
          </AnimatePresence>
        ) : (
          <Empty title="Sin cámaras" icon={<MonitorPlay size={28} />}>
            Configure un servidor exacqVision en Administración o active el modo demo.
          </Empty>
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-3">
          <button className="btn btn-sm" onClick={() => setPage((p) => (p - 1 + pages) % pages)}>
            <ChevronLeft size={14} />
          </button>
          <div className="flex gap-1.5">
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} onClick={() => setPage(i)} className={`h-2 rounded-full transition-all ${i === page ? "w-6 bg-accent" : "w-2 bg-line"}`} aria-label={`Página ${i + 1}`} />
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => setPage((p) => (p + 1) % pages)}>
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      <AnimatePresence>
        {focusCam && (
          <motion.div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm p-4 lg:p-10 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setParams({})}>
            <motion.div className="w-full max-w-6xl" initial={{ scale: 0.96 }} animate={{ scale: 1 }} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center mb-2">
                <span className="font-display text-xl tracking-wide">{focusCam.name}</span>
                <span className="ml-2 text-xs text-muted">{focusCam.serverName}</span>
                <button className="ml-auto btn btn-sm" onClick={() => setParams({})}>
                  Cerrar (Esc)
                </button>
              </div>
              <CameraTile camera={focusCam} fps={4} mode="stream" big />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <EscCloser onEsc={() => setParams({})} active={Boolean(focusCam)} />
    </div>
  );
}

function EscCloser({ onEsc, active }: { onEsc: () => void; active: boolean }) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onEsc();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active, onEsc]);
  return null;
}
