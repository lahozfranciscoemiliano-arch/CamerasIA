import { motion } from "framer-motion";
import { BellOff, Car, CheckCircle2, CircleDot, Cloud, Eye, Footprints, Network, Repeat, ScanEye, ServerOff, ShieldAlert, Sparkles, Unplug, User, VideoOff, Wifi } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { fmtAgo, fmtTime, SEVERITY_COLOR, TYPE_LABEL } from "../lib/format";
import type { SecEvent } from "../lib/types";
import { SeverityBadge, StatusBadge } from "./ui";

export const TYPE_ICON: Record<string, ReactNode> = {
  motion: <ScanEye size={15} />,
  person: <User size={15} />,
  vehicle: <Car size={15} />,
  intrusion: <ShieldAlert size={15} />,
  loitering: <Footprints size={15} />,
  tamper: <Eye size={15} />,
  camera_offline: <VideoOff size={15} />,
  camera_online: <Wifi size={15} />,
  host_down: <Unplug size={15} />,
  host_up: <Network size={15} />,
  vpn_up: <Cloud size={15} />,
  vpn_down: <Cloud size={15} />,
  source_down: <ServerOff size={15} />,
  ai_alert: <Sparkles size={15} />,
  external: <CircleDot size={15} />,
  system: <CircleDot size={15} />,
};

export function EventItem({
  ev,
  onClick,
  showThumb = true,
  dense = false,
  selectable = false,
  checked = false,
  onCheck,
}: {
  ev: SecEvent;
  onClick?: () => void;
  showThumb?: boolean;
  dense?: boolean;
  /** Muestra una casilla para selección múltiple (Eventos). */
  selectable?: boolean;
  checked?: boolean;
  onCheck?: (checked: boolean, e: MouseEvent) => void;
}) {
  const c = SEVERITY_COLOR[ev.severity];
  const fresh = Date.now() - ev.ts < 60_000 && ev.status === "new";
  const occurrences = ev.occurrences ?? 1;
  const recovered = ev.resolvedBy === "sistema" && ev.status === "resolved";
  const item = (
    <motion.button
      layout
      initial={{ opacity: 0, x: -16, backgroundColor: "rgba(34,211,238,0.15)" }}
      animate={{ opacity: ev.silent ? 0.6 : 1, x: 0, backgroundColor: "rgba(0,0,0,0)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35 }}
      onClick={onClick}
      className={`w-full min-w-0 text-left flex gap-3 rounded-lg border hover:border-line hover:bg-panel-2/60 ${checked ? "border-accent/60 bg-accent/5" : "border-line-soft"} ${dense ? "p-2" : "p-2.5"} relative overflow-hidden`}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: ev.silent ? "var(--color-line)" : c, boxShadow: fresh && !ev.silent ? `0 0 12px ${c}` : undefined }} />
      <span className="mt-0.5 shrink-0" style={{ color: ev.silent ? "var(--color-muted)" : c }}>
        {TYPE_ICON[ev.type] ?? <CircleDot size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {ev.silent && <BellOff size={12} className="shrink-0 text-muted" aria-label="Silenciado" />}
          <span className="text-sm font-medium text-ink truncate">{ev.title}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-muted">
          <SeverityBadge severity={ev.severity} />
          <span>{TYPE_LABEL[ev.type] ?? ev.type}</span>
          {ev.cameraName && <span className="text-ink-2">· {ev.cameraName}</span>}
          {occurrences > 1 && (
            <span className="flex items-center gap-0.5 text-ink-2" title={`Se repitió ${occurrences} veces`}>
              <Repeat size={11} /> ×{occurrences} · último {fmtAgo(ev.lastTs ?? ev.ts)}
            </span>
          )}
          {ev.meta?.flapping === true && <span className="text-warn">inestable</span>}
          {ev.ai && (
            <span className="text-ai flex items-center gap-0.5">
              <Sparkles size={11} /> IA
            </span>
          )}
          {recovered && (
            <span className="text-ok flex items-center gap-0.5">
              <CheckCircle2 size={11} /> Recuperada
            </span>
          )}
          {!dense && !recovered && <StatusBadge status={ev.status} />}
        </span>
      </span>
      <span className="shrink-0 flex flex-col items-end gap-1">
        <span className="font-mono text-[11px] text-ink-2" title={fmtTime(ev.ts)}>
          {fmtAgo(ev.ts)}
        </span>
        {showThumb && ev.hasSnapshot && <img src={`/api/events/${ev.id}/snapshot`} alt="" loading="lazy" className="w-20 h-11 object-cover rounded border border-line" />}
      </span>
    </motion.button>
  );
  if (!selectable) return item;
  return (
    <div className="flex items-stretch gap-2">
      <label className="shrink-0 grid place-items-center px-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="accent-[#22d3ee] w-4 h-4"
          checked={checked}
          aria-label={`Seleccionar evento ${ev.id}`}
          onChange={() => undefined}
          onClick={(e) => onCheck?.(!checked, e)}
        />
      </label>
      {item}
    </div>
  );
}
