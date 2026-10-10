import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { liveClient, type LiveImageSource, type LiveMode, type LiveSubscription } from "./live";
import { FLAG_BUDGET_LIMITED, drawRect, tierFor, type FrameMeta, type Prio, type ServerState } from "./live-protocol";
import type { Camera } from "./types";

/** ¿El elemento está en pantalla (o cerca)? Sin IntersectionObserver se asume que sí. */
export function useInView(ref: RefObject<Element | null>, rootMargin = "200px") {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/** ¿La pestaña está visible? (en segundo plano no se pide video). */
export function usePageVisible() {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/** Modo del cliente de video: WebSocket o respaldo HTTP. */
export function useLiveMode(): LiveMode {
  return useSyncExternalStore(
    (cb) => liveClient.onModeChange(cb),
    () => liveClient.mode,
    () => "ws" as LiveMode,
  );
}

export interface LiveStats {
  fps: number;
  latencyMs: number | null;
  width: number;
  height: number;
  dropped: number;
  limited: boolean;
}

export type LiveViewState = "loading" | "live" | "stalled" | "nosignal";

/**
 * Video en vivo en un <canvas>: se suscribe sólo mientras la cámara está en pantalla, la pestaña
 * visible y la vista no está en pausa. Pinta sin estado de React por cuadro; el estado visible
 * (cargando / en vivo / reconectando / sin señal) y las estadísticas se publican como mucho 1 vez por segundo.
 */
export function useLiveCanvas(camera: Camera, opts: { fps: number; prio: Prio; paused?: boolean; fit?: "cover" | "contain" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inView = useInView(containerRef);
  const visible = usePageVisible();
  const mode = useLiveMode();
  const active = inView && visible && !opts.paused && camera.online;
  const [view, setView] = useState<LiveViewState>("loading");
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [subFallback, setSubFallback] = useState(false);
  const [maxW, setMaxW] = useState(640);
  const fit = opts.fit ?? "cover";

  // Estado mutable del lienzo (sin renders por cuadro).
  const s = useRef({
    last: null as LiveImageSource | null,
    lastAt: 0,
    server: null as ServerState | null,
    fpsEwma: 0,
    ages: [] as number[],
    dropped: 0,
    w: 0,
    h: 0,
    flags: 0,
    sub: null as LiveSubscription | null,
    subCam: "",
    subAt: 0,
    ctx: null as CanvasRenderingContext2D | null,
    fit,
    fps: opts.fps,
  });
  s.current.fit = fit;
  s.current.fps = opts.fps;

  const paintLast = () => {
    const st = s.current;
    const canvas = canvasRef.current;
    if (!canvas || !st.last) return;
    if (!st.ctx) st.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true }) as CanvasRenderingContext2D | null;
    const ctx = st.ctx;
    if (!ctx) return;
    const r = drawRect(st.last.width, st.last.height, canvas.width, canvas.height, st.fit);
    if (st.fit === "contain") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(st.last, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
  };

  // Tamaño del lienzo = tamaño CSS × devicePixelRatio (máx. 2) y ancho pedido según el escalón.
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas || typeof ResizeObserver === "undefined") return;
    let debounce: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        s.current.ctx = null;
        paintLast(); // cambiar el tamaño borra el lienzo: se repinta el último cuadro
      }
      clearTimeout(debounce);
      debounce = setTimeout(() => setMaxW(tierFor(rect.width * (window.devicePixelRatio || 1)) || 1920), 300);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(debounce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, subFallback]);

  // Suscripción: activa sólo cuando corresponde; se suelta 1,5 s después de quedar inactiva
  // (no se corta al desplazarse o al cambiar de página brevemente).
  const optsRef = useRef({ fps: opts.fps, prio: opts.prio, maxW });
  optsRef.current = { fps: opts.fps, prio: opts.prio, maxW };
  const cancelRelease = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!active || subFallback) return;
    const st = s.current;
    cancelRelease.current();
    if (st.sub && st.subCam !== camera.id) {
      st.sub.close();
      st.sub = null;
    }
    if (!st.sub) {
      st.subCam = camera.id;
      st.subAt = performance.now();
      st.sub = liveClient.subscribe(camera.id, { ...optsRef.current }, {
        draw: (img, meta: FrameMeta & { ageMs: number }) => {
          const prev = st.last;
          st.last = img;
          paintLast();
          if (prev && prev !== img && "close" in prev && typeof prev.close === "function") prev.close();
          const t = performance.now();
          if (st.lastAt) {
            const inst = 1000 / Math.max(1, t - st.lastAt);
            st.fpsEwma = st.fpsEwma ? 0.8 * st.fpsEwma + 0.2 * inst : inst;
          }
          st.lastAt = t;
          st.ages = [...st.ages.slice(-19), meta.ageMs];
          st.dropped += meta.dropped;
          st.w = meta.width;
          st.h = meta.height;
          st.flags = meta.flags;
          return true; // se conserva para repintar al cambiar de tamaño
        },
        onState: (state) => {
          st.server = state;
        },
        onError: (code) => {
          // Sin lugar en el WebSocket (tope de suscripciones): esta cámara sigue por HTTP.
          if (code === "too_many_subs") setSubFallback(true);
        },
        targetSize: () => {
          const c = canvasRef.current;
          return c ? { w: c.width, h: c.height } : null;
        },
      });
    }
    return () => {
      const sub = st.sub;
      const t = setTimeout(() => {
        if (st.sub === sub) {
          sub?.close();
          st.sub = null;
        }
      }, 1500);
      cancelRelease.current = () => clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, camera.id, subFallback]);

  // Cambios de fps / prioridad / ancho: actualización sobre la misma suscripción.
  useEffect(() => {
    s.current.sub?.update({ fps: opts.fps, prio: opts.prio, maxW });
  }, [opts.fps, opts.prio, maxW]);

  // Cierre definitivo al desmontar.
  useEffect(
    () => () => {
      cancelRelease.current();
      const st = s.current;
      st.sub?.close();
      st.sub = null;
      const last = st.last;
      if (last && "close" in last && typeof last.close === "function") last.close();
      st.last = null;
    },
    [],
  );

  // Estado visible y estadísticas: como mucho una vez por segundo.
  useEffect(() => {
    const tick = () => {
      const st = s.current;
      const age = st.lastAt ? performance.now() - st.lastAt : Infinity;
      const server = st.server?.st;
      let next: LiveViewState;
      if (server === "offline" || server === "disabled" || server === "error") next = "nosignal";
      else if (!st.lastAt) next = st.subAt && performance.now() - st.subAt > 15_000 ? "nosignal" : server === "stalled" ? "stalled" : "loading";
      else if (!active) next = "live";
      else if (age > 15_000) next = "nosignal";
      else if (age > Math.max(3000, 4000 / Math.max(0.1, st.fps))) next = "stalled";
      else next = "live";
      setView(next);
      if (st.lastAt) {
        const ages = [...st.ages].sort((a, b) => a - b);
        setStats({
          fps: age > 2000 ? 0 : Math.round(st.fpsEwma * 10) / 10,
          latencyMs: ages.length ? Math.round(ages[Math.floor(ages.length / 2)]!) : null,
          width: st.w,
          height: st.h,
          dropped: st.dropped,
          limited: Boolean(st.server?.limited || st.flags & FLAG_BUDGET_LIMITED),
        });
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [active]);

  return { containerRef, canvasRef, view, stats, active, mode: subFallback ? ("fallback" as LiveMode) : mode, maxW };
}
