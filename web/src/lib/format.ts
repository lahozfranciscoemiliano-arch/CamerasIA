import type { EventStatus, Severity } from "./types";

const dtf = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium", hour12: false });
const tf = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const hm = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });

export const fmtDateTime = (ts: number | string | null | undefined) => (ts ? dtf.format(new Date(ts)) : "—");
export const fmtTime = (ts: number | string | null | undefined) => (ts ? tf.format(new Date(ts)) : "—");
export const fmtHM = (ts: number | string) => hm.format(new Date(ts));

export function fmtAgo(ts: number | null | undefined) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "ahora";
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export const fmtNum = (n: number) => new Intl.NumberFormat("es-AR").format(n);

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: "Info",
  low: "Baja",
  medium: "Media",
  high: "Alta",
  critical: "Crítica",
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  info: "var(--color-muted)",
  low: "var(--color-info)",
  medium: "var(--color-warn)",
  high: "var(--color-serious)",
  critical: "var(--color-crit)",
};

export const STATUS_LABEL: Record<EventStatus, string> = {
  new: "Nuevo",
  ack: "Reconocido",
  investigating: "Investigando",
  resolved: "Resuelto",
  false_positive: "Falsa alarma",
};

export const TYPE_LABEL: Record<string, string> = {
  motion: "Movimiento",
  person: "Persona",
  vehicle: "Vehículo",
  intrusion: "Intrusión",
  loitering: "Merodeo",
  tamper: "Sabotaje",
  camera_offline: "Cámara sin señal",
  camera_online: "Cámara restablecida",
  host_down: "Equipo caído",
  host_up: "Equipo restablecido",
  vpn_up: "VPN conectada",
  vpn_down: "VPN caída",
  source_down: "Servidor de video sin conexión",
  ai_alert: "Alerta IA",
  external: "Detección externa",
  system: "Sistema",
};

export const CATEGORY_LABEL: Record<"security" | "infra", string> = {
  security: "Seguridad",
  infra: "Infraestructura",
};

export const ROLE_LABEL = { admin: "Administrador", operator: "Operador", viewer: "Observador", tester: "Tester (ChatGPT)" } as const;
