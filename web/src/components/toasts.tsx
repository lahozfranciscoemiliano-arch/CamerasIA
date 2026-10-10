import { AnimatePresence, motion } from "framer-motion";
import { AlertOctagon, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

type Tone = "ok" | "error" | "info" | "alert";
export interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  onClick?: () => void;
  /** Un aviso con la misma clave reemplaza al anterior (y reinicia su tiempo) en vez de apilarse. */
  key?: string;
  /** No se cierra solo (alertas críticas). */
  sticky?: boolean;
}

type ToastInput = Omit<Toast, "id">;

interface Controls {
  closeAll: () => void;
  close: (key: string) => void;
  setMaxVisible: (n: number) => void;
}

const Ctx = createContext<(t: ToastInput) => void>(() => undefined);
const ControlsCtx = createContext<Controls>({ closeAll: () => undefined, close: () => undefined, setMaxVisible: () => undefined });
let seq = 0;

const DURATION: Record<Tone, number> = { ok: 4500, info: 4500, error: 6000, alert: 8000 };
const MAX_KEPT = 20;

export function ToastProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [maxVisible, setMaxVisible] = useState(3);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const close = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((all) => all.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback(
    (t: Toast) => {
      clearTimeout(timers.current.get(t.id));
      timers.current.delete(t.id);
      if (!t.sticky) timers.current.set(t.id, setTimeout(() => close(t.id), DURATION[t.tone]));
    },
    [close],
  );

  const push = useCallback(
    (input: ToastInput) => {
      setToasts((all) => {
        const prev = input.key ? all.find((x) => x.key === input.key) : undefined;
        const t: Toast = { ...input, id: prev?.id ?? ++seq };
        arm(t);
        const rest = all.filter((x) => x.id !== t.id);
        const next = [...rest, t];
        for (const dropped of next.slice(0, Math.max(0, next.length - MAX_KEPT))) clearTimeout(timers.current.get(dropped.id));
        return next.slice(-MAX_KEPT);
      });
    },
    [arm],
  );

  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const controls = useMemo<Controls>(
    () => ({
      closeAll: () => {
        timers.current.forEach((t) => clearTimeout(t));
        timers.current.clear();
        setToasts([]);
      },
      close: (key: string) => setToasts((all) => all.filter((x) => x.key !== key)),
      setMaxVisible: (n: number) => setMaxVisible(Math.min(8, Math.max(1, n))),
    }),
    [],
  );

  const visible = toasts.slice(-maxVisible);
  const hidden = toasts.length - visible.length;

  return (
    <Ctx.Provider value={push}>
      <ControlsCtx.Provider value={controls}>
        {children}
        <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(380px,calc(100vw-2rem))]" aria-live="polite">
          {(hidden > 0 || visible.length >= 2) && (
            <div className="flex justify-end gap-2 text-xs">
              {hidden > 0 && (
                <button className="rounded-full border border-line bg-panel px-2.5 py-1 text-ink-2 hover:text-ink" onClick={() => navigate("/eventos?status=open")}>
                  +{hidden} más
                </button>
              )}
              {visible.length >= 2 && (
                <button className="rounded-full border border-line bg-panel px-2.5 py-1 text-ink-2 hover:text-ink" onClick={controls.closeAll}>
                  Cerrar todas
                </button>
              )}
            </div>
          )}
          <AnimatePresence>
            {visible.map((t) => (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                // Pasar el mouse pausa el cierre automático.
                onMouseEnter={() => {
                  clearTimeout(timers.current.get(t.id));
                  timers.current.delete(t.id);
                }}
                onMouseLeave={() => arm(t)}
                onClick={() => {
                  t.onClick?.();
                  close(t.id);
                }}
                className={`panel px-3 py-2.5 flex gap-2.5 items-start ${t.onClick ? "cursor-pointer" : ""} ${t.tone === "alert" ? "border-crit/60 ring-alert" : ""}`}
                style={{ ["--ring-color" as string]: "#ff3b5c" }}
              >
                <span className="mt-0.5">
                  {t.tone === "ok" && <CheckCircle2 size={18} className="text-ok" />}
                  {t.tone === "error" && <AlertOctagon size={18} className="text-crit" />}
                  {t.tone === "info" && <Info size={18} className="text-info" />}
                  {t.tone === "alert" && <AlertOctagon size={18} className="text-crit animate-pulse" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm">{t.title}</div>
                  {t.body && <div className="text-xs text-ink-2 mt-0.5 line-clamp-3">{t.body}</div>}
                </div>
                <button
                  className="text-muted hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                  aria-label="Cerrar"
                >
                  <X size={14} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </ControlsCtx.Provider>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
export const useToastControls = () => useContext(ControlsCtx);
