import { motion } from "framer-motion";
import { Car, CircleDot, Cloud, Eye, Footprints, Network, ScanEye, ShieldAlert, Sparkles, Unplug, User, VideoOff, Wifi } from "lucide-react";
import type { ReactNode } from "react";
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
  ai_alert: <Sparkles size={15} />,
  external: <CircleDot size={15} />,
  system: <CircleDot size={15} />,
};

export function EventItem({ ev, onClick, showThumb = true, dense = false }: { ev: SecEvent; onClick?: () => void; showThumb?: boolean; dense?: boolean }) {
  const c = SEVERITY_COLOR[ev.severity];
  const fresh = Date.now() - ev.ts < 60_000 && ev.status === "new";
  return (
    <motion.button
      layout
      initial={{ opacity: 0, x: -16, backgroundColor: "rgba(34,211,238,0.15)" }}
      animate={{ opacity: 1, x: 0, backgroundColor: "rgba(0,0,0,0)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35 }}
      onClick={onClick}
      className={`w-full text-left flex gap-3 rounded-lg border border-line-soft hover:border-line hover:bg-panel-2/60 ${dense ? "p-2" : "p-2.5"} relative overflow-hidden`}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: c, boxShadow: fresh ? `0 0 12px ${c}` : undefined }} />
      <span className="mt-0.5 shrink-0" style={{ color: c }}>
        {TYPE_ICON[ev.type] ?? <CircleDot size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink truncate">{ev.title}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-muted">
          <SeverityBadge severity={ev.severity} />
          <span>{TYPE_LABEL[ev.type] ?? ev.type}</span>
          {ev.cameraName && <span className="text-ink-2">· {ev.cameraName}</span>}
          {ev.ai && (
            <span className="text-ai flex items-center gap-0.5">
              <Sparkles size={11} /> IA
            </span>
          )}
          {!dense && <StatusBadge status={ev.status} />}
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
}
