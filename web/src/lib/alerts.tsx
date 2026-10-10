import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useToast, useToastControls } from "../components/toasts";
import { DEFAULT_PREFS, filterNotice, migrateLegacy, nextAt, normalizePrefs, summarize, type SoundTone } from "./alertPolicy";
import { SEVERITY_LABEL } from "./format";
import { useLocalStorage } from "./hooks";
import { useTopic } from "./realtime";
import type { AlertNotice, AlertPrefs, NoticeItem } from "./types";

const PREFS_KEY = "cia.alerts.prefs.v1";

interface AlertsCtx {
  prefs: AlertPrefs;
  setPrefs: (p: AlertPrefs) => void;
  dndUntil: number | null;
  /** Minutos de "no molestar", "morning" (hasta las 07:00) o null para desactivar. */
  setDnd: (minutes: number | "morning" | null) => void;
}

const Ctx = createContext<AlertsCtx>({ prefs: DEFAULT_PREFS, setPrefs: () => undefined, dndUntil: null, setDnd: () => undefined });

function initialPrefs(): AlertPrefs {
  try {
    if (localStorage.getItem(PREFS_KEY)) return DEFAULT_PREFS; // useLocalStorage lee lo guardado
    const legacy = localStorage.getItem("cia.alerts.sound");
    return migrateLegacy(legacy === null ? null : JSON.parse(legacy));
  } catch {
    return DEFAULT_PREFS;
  }
}

// ───────── Sonido: un único AudioContext compartido ─────────

let audioCtx: AudioContext | null = null;
function audio() {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

const TONES: Record<SoundTone, { freqs: number[]; type: OscillatorType; gain: number; step: number }> = {
  critical: { freqs: [880, 660, 880, 660], type: "square", gain: 0.08, step: 0.18 },
  security: { freqs: [740, 990], type: "square", gain: 0.07, step: 0.18 },
  infra: { freqs: [520], type: "sine", gain: 0.05, step: 0.3 },
};

function play(tone: SoundTone) {
  const ctx = audio();
  if (!ctx) return;
  const t = TONES[tone];
  t.freqs.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const at = ctx.currentTime + i * t.step;
    o.type = t.type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(t.gain, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + t.step - 0.02);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + t.step - 0.01);
  });
}

/**
 * Recibe los avisos del servidor (`alert.notify`) y aplica las preferencias de esta consola: umbrales por
 * categoría, "no molestar", pausa entre sonidos, agrupación de avisos y contador en el título de la pestaña.
 */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { setMaxVisible } = useToastControls();
  const navigate = useNavigate();
  const [initial] = useState(initialPrefs);
  const [stored, setStored] = useLocalStorage<AlertPrefs>(PREFS_KEY, initial);
  const prefs = useMemo(() => normalizePrefs(stored), [stored]);
  const lastSound = useRef(0);
  const digest = useRef<{ at: number; items: NoticeItem[] } | null>(null);
  const unseen = useRef(0);
  const baseTitle = useRef(document.title);

  useEffect(() => setMaxVisible(prefs.maxToasts), [prefs.maxToasts, setMaxVisible]);

  // Los navegadores sólo permiten audio tras una interacción: se habilita con el primer clic.
  useEffect(() => {
    const unlock = () => audio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        unseen.current = 0;
        document.title = baseTitle.current;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.title = baseTitle.current;
    };
  }, []);

  useTopic<AlertNotice>("alert.notify", (n) => {
    const now = Date.now();
    const f = filterNotice(n, prefs, now, lastSound.current);
    if (f.playSound && f.tone) {
      lastSound.current = now;
      play(f.tone);
    }
    if (!f.toastItems.length) return;
    if (document.visibilityState === "hidden" && n.kind !== "recovery") {
      unseen.current += f.toastItems.length;
      document.title = `(${unseen.current}) ${baseTitle.current}`;
    }
    if (n.kind === "recovery") {
      toast({
        tone: "ok",
        key: f.toastItems.length === 1 ? `ev:${f.toastItems[0]!.eventId}` : "recovery",
        title: f.toastItems.length === 1 ? `Normalizado: ${f.toastItems[0]!.title}` : `${f.toastItems.length} alertas normalizadas`,
        onClick: () => navigate(f.toastItems.length === 1 ? `/eventos?id=${f.toastItems[0]!.eventId}` : "/eventos"),
      });
      return;
    }
    const sticky = f.toastItems.some((i) => i.severity === "critical");
    if (f.toastItems.length === 1 && n.kind !== "digest") {
      const it = f.toastItems[0]!;
      toast({
        tone: "alert",
        key: `ev:${it.eventId}`,
        sticky,
        title: n.kind === "escalation" ? `Escaló a ${SEVERITY_LABEL[it.severity]} · ${it.title}` : `${SEVERITY_LABEL[it.severity]} · ${it.title}`,
        body: it.cameraName ? `Cámara: ${it.cameraName}` : (n.body ?? undefined),
        onClick: () => navigate(`/eventos?id=${it.eventId}`),
      });
      return;
    }
    // Varios a la vez: un único aviso agrupado que se va acumulando si siguen llegando en los próximos 10 s.
    const prev = digest.current && now - digest.current.at < 10_000 ? digest.current.items : [];
    const items = [...prev, ...f.toastItems];
    digest.current = { at: now, items };
    const more = n.count > n.items.length ? "+" : "";
    toast({
      tone: "alert",
      key: "digest",
      sticky,
      title: `${items.length}${more} nuevas alertas`,
      body: summarize(items),
      onClick: () => navigate("/eventos?status=open"),
    });
  });

  const setPrefs = useCallback((p: AlertPrefs) => setStored(normalizePrefs(p)), [setStored]);
  const setDnd = useCallback(
    (minutes: number | "morning" | null) => {
      const now = Date.now();
      const until = minutes === null ? null : minutes === "morning" ? nextAt(7, now) : now + minutes * 60_000;
      setStored({ ...prefs, dndUntil: until });
    },
    [prefs, setStored],
  );

  const value = useMemo<AlertsCtx>(
    () => ({ prefs, setPrefs, dndUntil: prefs.dndUntil && prefs.dndUntil > Date.now() ? prefs.dndUntil : null, setDnd }),
    [prefs, setPrefs, setDnd],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAlerts = () => useContext(Ctx);
