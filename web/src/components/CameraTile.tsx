import { AnimatePresence, motion } from "framer-motion";
import { Camera as CameraIcon, Maximize2, ScanEye, Sparkles, VideoOff, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import type { Prio } from "../lib/live-protocol";
import type { Camera, Severity, VisionResult } from "../lib/types";
import { useLiveCanvas } from "../lib/useLive";
import { SeverityBadge, Spinner } from "./ui";

/**
 * Respaldo HTTP del video en vivo (cuando el WebSocket no está disponible): pide cuadros del ancho
 * del recuadro (?w=) de a uno, sólo mientras la vista está activa, con tiempo máximo de 4 s y una
 * espera corta ante errores. Un cuadro lento no muestra "SIN SEÑAL": hacen falta varios errores seguidos.
 */
export function LiveImage({ camera, fps, active = true, maxW = 640, className = "" }: { camera: Camera; fps: number; active?: boolean; maxW?: number; className?: string; mode?: "poll" | "stream" }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const prevUrl = useRef<string | null>(null);
  const base = `/api/cameras/${encodeURIComponent(camera.id)}`;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let errors = 0;
    let ac: AbortController | null = null;
    const loop = async () => {
      const t0 = performance.now();
      ac = new AbortController();
      const timeout = setTimeout(() => ac?.abort(), 4000);
      try {
        const res = await fetch(`${base}/snapshot?w=${maxW}&fps=${fps}`, { credentials: "same-origin", signal: ac.signal });
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        // Decodificar antes de reemplazar: el cambio de imagen no parpadea.
        const img = new Image();
        img.src = url;
        await img.decode().catch(() => undefined);
        if (stopped) return URL.revokeObjectURL(url);
        setSrc(url);
        setFailed(false);
        errors = 0;
        if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
        prevUrl.current = url;
        timer = setTimeout(loop, Math.max(80, 1000 / fps - (performance.now() - t0)));
      } catch {
        if (stopped) return;
        if (++errors >= 3) setFailed(true);
        timer = setTimeout(loop, Math.min(2000, 750 * errors));
      } finally {
        clearTimeout(timeout);
      }
    };
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ac?.abort();
    };
  }, [base, fps, active, maxW]);

  useEffect(
    () => () => {
      if (prevUrl.current) URL.revokeObjectURL(prevUrl.current);
    },
    [],
  );

  if (failed && !src) return <NoSignal />;
  return src ? <img src={src} alt={camera.name} className={`w-full h-full object-cover ${failed ? "grayscale opacity-40" : ""} ${className}`} /> : <div className="w-full h-full skeleton" />;
}

/** Reloj del recuadro: sólo este componente se vuelve a dibujar cada segundo. */
function TileClock() {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="ml-auto font-mono text-ink-2">{fmtTime(clock)}</span>;
}

/** Video en vivo sobre <canvas> (WebSocket /api/live) con respaldo HTTP. */
const LiveView = memo(function LiveView({
  camera,
  fps,
  prio,
  paused,
  fit,
  showStats,
}: {
  camera: Camera;
  fps: number;
  prio: Prio;
  paused: boolean;
  fit: "cover" | "contain";
  showStats: boolean;
}) {
  const live = useLiveCanvas(camera, { fps, prio, paused, fit });
  const st = live.stats;
  const warn = Boolean(st && ((st.latencyMs ?? 0) > 1500 || st.limited));
  return (
    <div ref={live.containerRef} className="relative w-full h-full">
      {live.mode === "fallback" ? (
        <LiveImage camera={camera} fps={Math.min(fps, 4)} active={live.active} maxW={live.maxW} />
      ) : (
        <>
          <canvas
            ref={live.canvasRef}
            aria-label={camera.name}
            className={`block w-full h-full transition-[filter] ${live.view === "stalled" ? "grayscale-[.6] brightness-75" : ""}`}
          />
          {live.view === "loading" && <div className="absolute inset-0 skeleton" />}
          {live.view === "stalled" && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <span className="flex items-center gap-2 rounded-md bg-black/70 px-3 py-1.5 text-xs text-ink-2">
                <Spinner size={13} /> Reconectando…
              </span>
            </div>
          )}
          {live.view === "nosignal" && (
            <div className="absolute inset-0">
              <NoSignal />
            </div>
          )}
        </>
      )}
      {showStats && st && live.mode !== "fallback" && (
        <span
          className={`absolute left-2 bottom-2 rounded px-1.5 py-0.5 font-mono text-[10px] pointer-events-none ${warn ? "bg-warn/25 text-warn" : "bg-black/70 text-ink-2"}`}
          title={`Descartados: ${st.dropped}${st.limited ? " · limitado por ancho de banda" : ""}`}
        >
          {st.fps.toFixed(1)} fps · {st.latencyMs ?? "-"} ms · {st.width}×{st.height}
        </span>
      )}
    </div>
  );
});

function NoSignal({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="w-full h-full grid place-items-center bg-[repeating-linear-gradient(45deg,#0b1426_0_10px,#0d1830_10px_20px)]">
      <div className="text-center">
        <VideoOff className="mx-auto text-crit mb-1" size={28} />
        <div className="font-display tracking-[0.25em] text-crit text-sm">SIN SEÑAL</div>
        {onRetry && (
          <button className="btn btn-sm mt-2" onClick={onRetry}>
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
}

export const THREAT_SEV: Record<VisionResult["threat_level"], Severity> = { none: "info", low: "low", medium: "medium", high: "high", critical: "critical" };

export function AiResultCard({ result, onClose, compact = false }: { result: VisionResult; onClose?: () => void; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-ai/40 bg-[#120f24]/90 backdrop-blur ${compact ? "p-2.5 text-xs" : "p-3 text-sm"} space-y-2`}>
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-ai" />
        <span className="font-semibold text-[#e4dcff]">Análisis IA</span>
        <SeverityBadge severity={THREAT_SEV[result.threat_level]} />
        {result.simulated && <span className="text-[10px] text-muted">(demo)</span>}
        {onClose && (
          <button className="ml-auto text-muted hover:text-ink" onClick={onClose} aria-label="Cerrar">
            <X size={14} />
          </button>
        )}
      </div>
      <p className="text-ink leading-snug">{result.summary}</p>
      <div className="flex flex-wrap gap-1.5">
        <span className="px-1.5 py-0.5 rounded bg-panel-3 text-ink-2">👤 {result.people_count}</span>
        <span className="px-1.5 py-0.5 rounded bg-panel-3 text-ink-2">🚗 {result.vehicles_count}</span>
        {result.detected.map((d) => (
          <span key={d} className="px-1.5 py-0.5 rounded bg-ai/15 text-[#d9ceff]">
            {d}
          </span>
        ))}
        <span className="px-1.5 py-0.5 rounded bg-panel-3 text-muted">conf. {Math.round(result.confidence * 100)}%</span>
      </div>
      {result.anomalies.length > 0 && <div className="text-warn">⚠ {result.anomalies.join(" · ")}</div>}
      {!compact && result.recommended_action && (
        <div className="text-ink-2">
          <span className="label !text-[10px] mr-1">Acción</span>
          {result.recommended_action}
        </div>
      )}
    </div>
  );
}

export default function CameraTile({
  camera,
  fps = 1,
  prio = "grid",
  paused = false,
  fit = "cover",
  showStats = false,
  onExpand,
  big = false,
}: {
  camera: Camera;
  fps?: number;
  /** @deprecated El video en vivo usa siempre el WebSocket /api/live (con respaldo HTTP). */
  mode?: "poll" | "stream";
  /** "focus": vista ampliada (más fps y prioridad ante el servidor de video). */
  prio?: Prio;
  /** Pausa el video (p. ej. la grilla mientras está abierta la vista ampliada). */
  paused?: boolean;
  fit?: "cover" | "contain";
  /** Muestra fps · latencia · resolución. */
  showStats?: boolean;
  onExpand?: () => void;
  big?: boolean;
}) {
  const { can } = useAuth();
  const [ai, setAi] = useState<VisionResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [flash, setFlash] = useState(false);

  const analyze = async () => {
    setAiBusy(true);
    setAiError("");
    try {
      const r = await api.post<{ result: VisionResult; eventId: number | null }>("/api/ai/analyze-camera", { camera: camera.id });
      setAi(r.result);
    } catch (e) {
      setAiError((e as ApiError).message);
      setTimeout(() => setAiError(""), 6000);
    } finally {
      setAiBusy(false);
    }
  };

  const snapshot = async () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 250);
    const res = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}/snapshot`, { credentials: "same-origin" });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${camera.name.replace(/\W+/g, "_")}_${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className={`group relative rounded-lg overflow-hidden border bg-black aspect-video ${camera.online ? "border-line" : "border-crit/50"}`}>
      {camera.online ? <LiveView camera={camera} fps={fps} prio={prio} paused={paused} fit={fit} showStats={showStats} /> : <NoSignal />}
      <div className="scanline absolute inset-0 pointer-events-none" />
      <div className="absolute inset-0 pointer-events-none hud-corners opacity-0 group-hover:opacity-100 transition-opacity" />
      {flash && <div className="absolute inset-0 bg-white/60" />}

      {/* Encabezado */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-2 px-2.5 py-1.5 bg-gradient-to-b from-black/80 to-transparent text-[11px]">
        {camera.online ? (
          <span className="flex items-center gap-1 font-bold text-crit">
            <span className="w-2 h-2 rounded-full bg-crit animate-blink" /> REC
          </span>
        ) : (
          <span className="font-bold text-muted">OFF</span>
        )}
        <span className={`font-display font-semibold tracking-wide truncate ${big ? "text-base" : ""}`}>{camera.name}</span>
        {camera.motionEnabled && (
          <span title="Detección de movimiento activa" className="text-accent">
            <ScanEye size={13} />
          </span>
        )}
        {camera.aiVerify && (
          <span title="Verificación IA activa" className="text-ai">
            <Sparkles size={13} />
          </span>
        )}
        <TileClock />
      </div>

      {/* Acciones */}
      <div className="absolute right-2 bottom-2 flex gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {can("operator") && camera.online && (
          <button className="btn btn-ai btn-sm !px-2" onClick={() => void analyze()} disabled={aiBusy} title="Analizar con IA">
            {aiBusy ? <Spinner size={14} /> : <Sparkles size={14} />}
            {big && "Analizar con IA"}
          </button>
        )}
        {camera.online && (
          <button className="btn btn-sm !px-2" onClick={() => void snapshot()} title="Capturar imagen">
            <CameraIcon size={14} />
          </button>
        )}
        {onExpand && (
          <button className="btn btn-sm !px-2" onClick={onExpand} title="Ampliar">
            <Maximize2 size={14} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {(ai || aiError) && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute left-2 right-2 bottom-10 max-h-[70%] overflow-y-auto">
            {ai ? (
              <AiResultCard result={ai} onClose={() => setAi(null)} compact={!big} />
            ) : (
              <div className="rounded-lg border border-crit/40 bg-black/80 p-2 text-xs text-[#ffd2da]">{aiError}</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

