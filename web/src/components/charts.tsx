import { motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtHM, TYPE_LABEL } from "../lib/format";
import type { EventStats } from "../lib/types";

/*
 * Paleta de series validada para daltonismo sobre la superficie oscura (#0d1628):
 *   baja/info  #3987e5 · media #c98500 · alta/crítica #e5486e
 * Las severidades se agrupan en 3 series para que el apilado sea legible; el detalle está en el tooltip.
 */
export const SERIES = { low: "#3987e5", med: "#c98500", high: "#e5486e" };
const GRID = "#1a2742";
const AXIS = "#66779c";
const SURFACE = "#0b1426";

const tooltipStyle = {
  contentStyle: { background: "#0f1b33", border: "1px solid #1b2b4b", borderRadius: 8, fontSize: 12, color: "#dce6ff" },
  labelStyle: { color: "#9fb0d4", marginBottom: 4 },
  itemStyle: { padding: 0 },
  cursor: { fill: "rgba(34,211,238,0.06)" },
};

export function TimelineChart({ stats }: { stats: EventStats }) {
  const buckets = new Map<number, { t: number; low: number; med: number; high: number }>();
  const now = Date.now();
  const start = Math.floor((now - stats.hours * 3600_000) / stats.bucketMs) * stats.bucketMs;
  for (let t = start; t <= now; t += stats.bucketMs) buckets.set(t, { t, low: 0, med: 0, high: 0 });
  for (const r of stats.timeline) {
    const b = buckets.get(r.bucket) ?? { t: r.bucket, low: 0, med: 0, high: 0 };
    if (r.severity === "info" || r.severity === "low") b.low += r.n;
    else if (r.severity === "medium") b.med += r.n;
    else b.high += r.n;
    buckets.set(r.bucket, b);
  }
  const data = [...buckets.values()].sort((a, b) => a.t - b.t);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="t" tickFormatter={(t) => fmtHM(t)} stroke={AXIS} tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
        <YAxis allowDecimals={false} stroke={AXIS} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
        <Tooltip {...tooltipStyle} labelFormatter={(t) => `${fmtHM(t as number)} – ${fmtHM((t as number) + stats.bucketMs)}`} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: "#9fb0d4" }} />
        <Bar dataKey="low" name="Baja / info" stackId="s" fill={SERIES.low} stroke={SURFACE} strokeWidth={2} />
        <Bar dataKey="med" name="Media" stackId="s" fill={SERIES.med} stroke={SURFACE} strokeWidth={2} />
        <Bar dataKey="high" name="Alta / crítica" stackId="s" fill={SERIES.high} stroke={SURFACE} strokeWidth={2} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Barras horizontales de una sola serie (magnitud): un solo tono, etiquetas directas. */
export function RankBars({ items, color = SERIES.low, max = 8 }: { items: Array<{ label: string; value: number }>; color?: string; max?: number }) {
  const top = items.slice(0, max);
  const peak = Math.max(1, ...top.map((i) => i.value));
  if (!top.length) return <div className="text-sm text-muted py-6 text-center">Sin datos en el período</div>;
  return (
    <ul className="space-y-2" role="table" aria-label="Ranking">
      {top.map((it, i) => (
        <li key={it.label} className="group" role="row" title={`${it.label}: ${it.value}`}>
          <div className="flex justify-between text-xs mb-1" role="cell">
            <span className="text-ink-2 truncate pr-2">{it.label}</span>
            <span className="font-mono text-ink tabular-nums">{it.value}</span>
          </div>
          <div className="h-2 rounded bg-line-soft overflow-hidden">
            <motion.div
              className="h-full rounded"
              style={{ background: color }}
              initial={{ width: 0 }}
              animate={{ width: `${(it.value / peak) * 100}%` }}
              transition={{ duration: 0.8, delay: i * 0.05, ease: "easeOut" }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export const typeItems = (stats: EventStats) => stats.byType.map((t) => ({ label: TYPE_LABEL[t.type] ?? t.type, value: t.count }));

/** Medidor semicircular del nivel de amenaza (1-5). */
export function ThreatGauge({ level, label, score }: { level: number; label: string; score: number }) {
  const colors = ["#19d27c", "#4da3ff", "#ffb020", "#ff7a45", "#ff3b5c"];
  const segs = 5;
  const r = 80;
  const cx = 100;
  const cy = 96;
  const arc = (i: number) => {
    const a0 = Math.PI + (i / segs) * Math.PI + 0.03;
    const a1 = Math.PI + ((i + 1) / segs) * Math.PI - 0.03;
    const p = (a: number, rr: number) => `${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)}`;
    return `M ${p(a0, r)} A ${r} ${r} 0 0 1 ${p(a1, r)}`;
  };
  const angle = -90 + ((level - 0.5) / segs) * 180;
  const color = colors[level - 1] ?? "#66779c";
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 116" className="w-full max-w-[260px]" role="img" aria-label={`Nivel de amenaza ${level} de 5: ${label}`}>
        {Array.from({ length: segs }, (_, i) => (
          <path key={i} d={arc(i)} stroke={i < level ? colors[i] : "#1b2b4b"} strokeWidth={14} fill="none" strokeLinecap="round" style={{ filter: i < level ? `drop-shadow(0 0 6px ${colors[i]})` : undefined }} />
        ))}
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${cx}px ${cy}px`, transformBox: "view-box", transition: "transform 1.1s cubic-bezier(.34,1.56,.64,1)" }}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - r + 22} stroke="#dce6ff" strokeWidth={3} strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r={7} fill="#0b1426" stroke="#dce6ff" strokeWidth={2} />
      </svg>
      <div className="font-display text-2xl font-bold tracking-[0.2em] -mt-2" style={{ color, textShadow: `0 0 18px ${color}` }}>
        {label}
      </div>
      <div className="text-xs text-muted">Nivel {level}/5 · puntaje {score}</div>
    </div>
  );
}

export function Meter({ label, value, max, format, warnAt = 0.75, critAt = 0.9 }: { label: string; value: number; max: number; format: (v: number) => string; warnAt?: number; critAt?: number }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const color = pct >= critAt ? "var(--color-crit)" : pct >= warnAt ? "var(--color-warn)" : "var(--color-accent)";
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-ink-2">{label}</span>
        <span className="font-mono tabular-nums">{format(value)}</span>
      </div>
      <div className="h-1.5 rounded bg-line-soft overflow-hidden">
        <motion.div className="h-full rounded" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${pct * 100}%` }} transition={{ duration: 0.6 }} />
      </div>
    </div>
  );
}

/** Sparkline de latencia (una serie, sin ejes): el texto de al lado lleva el valor. */
export function Sparkline({ values, color = "#22d3ee", height = 24, width = 90 }: { values: Array<number | null>; color?: string; height?: number; width?: number }) {
  const vals = values.map((v) => v ?? 0);
  if (vals.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...vals, 1);
  const step = width / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {values.map((v, i) =>
        v === null ? <rect key={i} x={i * step - 1} y={0} width={2} height={height} fill="var(--color-crit)" opacity={0.7} /> : null,
      )}
    </svg>
  );
}
