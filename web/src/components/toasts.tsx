import { AnimatePresence, motion } from "framer-motion";
import { AlertOctagon, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "ok" | "error" | "info" | "alert";
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  onClick?: () => void;
}

const Ctx = createContext<(t: Omit<Toast, "id">) => void>(() => undefined);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq;
    setToasts((all) => [...all.slice(-4), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.tone === "alert" ? 9000 : 4500);
  }, []);
  const close = (id: number) => setToasts((all) => all.filter((x) => x.id !== id));
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(380px,calc(100vw-2rem))]" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
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
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
