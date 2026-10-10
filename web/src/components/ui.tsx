import { AnimatePresence, motion } from "framer-motion";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Loader2, ShieldAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { SEVERITY_COLOR, SEVERITY_LABEL, STATUS_LABEL } from "../lib/format";
import type { EventStatus, Severity } from "../lib/types";
import { useCountUp } from "../lib/hooks";

export function Panel({
  title,
  icon,
  actions,
  children,
  className = "",
  glow = false,
  bodyClass = "p-4",
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  glow?: boolean;
  bodyClass?: string;
}) {
  return (
    <section className={`panel ${glow ? "panel-glow" : ""} flex flex-col min-w-0 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-line-soft">
          {icon && <span className="text-accent">{icon}</span>}
          <h2 className="label !text-ink-2 truncate">{title}</h2>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={`flex-auto min-h-0 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  suffix,
  icon,
  tone = "accent",
  hint,
  format = (n: number) => Math.round(n).toString(),
}: {
  label: string;
  value: number;
  suffix?: string;
  icon?: ReactNode;
  tone?: "accent" | "ok" | "warn" | "crit" | "ai" | "info";
  hint?: ReactNode;
  format?: (n: number) => string;
}) {
  const v = useCountUp(value);
  const color = {
    accent: "var(--color-accent)",
    ok: "var(--color-ok)",
    warn: "var(--color-warn)",
    crit: "var(--color-crit)",
    ai: "var(--color-ai)",
    info: "var(--color-info)",
  }[tone];
  return (
    <div className="panel px-4 py-3 overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-[2px] opacity-80" style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <span style={{ color }} className="opacity-80">
          {icon}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="font-display text-3xl font-bold text-ink">{format(v)}</span>
        {suffix && <span className="text-sm text-ink-2">{suffix}</span>}
      </div>
      {hint && <div className="text-xs text-muted mt-0.5 truncate">{hint}</div>}
    </div>
  );
}

const SEV_ICON: Record<Severity, ReactNode> = {
  info: <Info size={12} />,
  low: <Info size={12} />,
  medium: <AlertTriangle size={12} />,
  high: <ShieldAlert size={12} />,
  critical: <AlertOctagon size={12} />,
};

export function SeverityBadge({ severity, compact = false }: { severity: Severity; compact?: boolean }) {
  const c = SEVERITY_COLOR[severity];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide border"
      style={{ color: c, borderColor: `color-mix(in oklab, ${c} 45%, transparent)`, background: `color-mix(in oklab, ${c} 12%, transparent)` }}
    >
      {SEV_ICON[severity]}
      {!compact && SEVERITY_LABEL[severity]}
    </span>
  );
}

export function StatusBadge({ status }: { status: EventStatus }) {
  const map: Record<EventStatus, string> = {
    new: "text-crit border-crit/40 bg-crit/10",
    ack: "text-warn border-warn/40 bg-warn/10",
    investigating: "text-ai border-ai/40 bg-ai/10",
    resolved: "text-ok border-ok/40 bg-ok/10",
    false_positive: "text-muted border-line bg-panel-2",
  };
  return <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${map[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function Dot({ tone, pulse = false, size = 8 }: { tone: "ok" | "warn" | "crit" | "muted" | "accent" | "ai"; pulse?: boolean; size?: number }) {
  const c = { ok: "var(--color-ok)", warn: "var(--color-warn)", crit: "var(--color-crit)", muted: "var(--color-muted)", accent: "var(--color-accent)", ai: "var(--color-ai)" }[tone];
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {pulse && <span className="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: c }} />}
      <span className="relative inline-flex rounded-full w-full h-full" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-accent" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4 text-ink-2">
      <div className="text-muted">{icon}</div>
      <div className="font-display text-lg tracking-wide text-ink">{title}</div>
      {children && <div className="text-sm max-w-md">{children}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 520,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            className="panel panel-glow w-full max-h-[90vh] flex flex-col"
            style={{ maxWidth: width }}
            initial={{ y: 16, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <header className="flex items-center px-5 py-3 border-b border-line-soft">
              <h3 className="font-display text-lg tracking-wide">{title}</h3>
              <button className="ml-auto btn btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">
                <X size={16} />
              </button>
            </header>
            <div className="p-5 overflow-y-auto">{children}</div>
            {footer && <footer className="px-5 py-3 border-t border-line-soft flex justify-end gap-2">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label block mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 disabled:opacity-50"
    >
      <span className={`relative w-9 h-5 rounded-full transition-colors ${checked ? "bg-accent/80" : "bg-line"}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
      {label && <span className="text-sm text-ink-2">{label}</span>}
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-[#ffd2da]">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-crit" />
      <div>{children}</div>
    </div>
  );
}

export function OkNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm">
      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
      <div>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: ReactNode; icon?: ReactNode }> }) {
  return (
    <div className="flex gap-1 border-b border-line-soft overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative flex items-center gap-2 px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors ${value === t.id ? "text-accent" : "text-ink-2 hover:text-ink"}`}
        >
          {t.icon}
          {t.label}
          {value === t.id && <motion.span layoutId="tab-underline" className="absolute left-2 right-2 -bottom-px h-0.5 bg-accent rounded-full shadow-[0_0_10px_#22d3ee]" />}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, icon, actions }: { title: string; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div className="flex items-center gap-3">
        {icon && <div className="w-10 h-10 rounded-xl grid place-items-center bg-accent/10 border border-accent/30 text-accent">{icon}</div>}
        <div>
          <h1 className="font-display text-2xl font-bold tracking-wide leading-tight">{title}</h1>
          {subtitle && <p className="text-sm text-ink-2">{subtitle}</p>}
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
