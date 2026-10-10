import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface RtMessage {
  topic: string;
  data: unknown;
  ts: number;
}

type Listener = (msg: RtMessage) => void;

interface RtCtx {
  connected: boolean;
  subscribe: (topic: string, fn: Listener) => () => void;
}

const Ctx = createContext<RtCtx>({ connected: false, subscribe: () => () => undefined });

/** WebSocket autenticado por cookie con reconexión exponencial. */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Map<string, Set<Listener>>());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempts = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let ping: ReturnType<typeof setInterval>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as RtMessage;
          listeners.current.get(msg.topic)?.forEach((fn) => fn(msg));
          listeners.current.get("*")?.forEach((fn) => fn(msg));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        clearInterval(ping);
        if (stopped) return;
        const delay = Math.min(15_000, 800 * 2 ** attempts++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    };
  }, []);

  const subscribe = (topic: string, fn: Listener) => {
    const set = listeners.current.get(topic) ?? new Set();
    set.add(fn);
    listeners.current.set(topic, set);
    return () => set.delete(fn);
  };

  return <Ctx.Provider value={{ connected, subscribe }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);

export function useTopic<T = unknown>(topic: string, fn: (data: T, msg: RtMessage) => void) {
  const { subscribe } = useRealtime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe(topic, (m) => ref.current(m.data as T, m)), [topic, subscribe]);
}
