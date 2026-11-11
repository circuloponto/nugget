"use client";

import type { ReactNode } from "react";

export interface BarItem {
  readonly label: ReactNode;
  readonly value: number;
  readonly text?: string;
  readonly title?: string;
}

/** Horizontal bars; every bar carries its number, so the picture never replaces the data. */
export function Bars({ items, max, testId }: { items: readonly BarItem[]; max?: number; testId?: string }) {
  const top = max ?? Math.max(1e-9, ...items.map((i) => i.value));
  return (
    <div className="co-bars" data-testid={testId}>
      {items.map((it, k) => (
        <div className="co-bar" key={k} title={it.title}>
          <span className="co-bar-label">{it.label}</span>
          <span className="co-bar-track">
            <i style={{ width: `${Math.max(0, Math.min(100, (it.value / top) * 100))}%` }} />
          </span>
          <span className="co-bar-num">{it.text ?? String(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** A pitch contour as a line: one point per note, time-spaced by onset. */
export function ContourSvg({ points, width = 220, height = 64, label }: { points: readonly { x: number; midi: number }[]; width?: number; height?: number; label?: string }) {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ms = points.map((p) => p.midi);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs, x0 + 1e-9);
  const lo = Math.min(...ms);
  const hi = Math.max(...ms, lo + 1);
  const px = (x: number) => 6 + ((x - x0) / (x1 - x0)) * (width - 12);
  const py = (m: number) => height - 6 - ((m - lo) / (hi - lo)) * (height - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.midi).toFixed(1)}`).join(" ");
  return (
    <svg className="co-contour" width={width} height={height} role="img" aria-label={label ?? "melodic contour"}>
      <path d={d} fill="none" />
      {points.map((p, i) => (
        <circle key={i} cx={px(p.x)} cy={py(p.midi)} r={2.4} />
      ))}
    </svg>
  );
}

/** Attack ticks on a time axis; the tick's height is the note's length class (short, medium, long). */
export function RhythmStrip({ ticks, total, width = 220, label }: { ticks: readonly { at: number; len: number }[]; total: number; width?: number; label?: string }) {
  const h = 34;
  const t = Math.max(total, 1e-9);
  return (
    <svg className="co-rhythm" width={width} height={h} role="img" aria-label={label ?? "rhythm"}>
      <line x1={0} x2={width} y1={h - 2} y2={h - 2} />
      {ticks.map((k, i) => {
        const x = 4 + (k.at / t) * (width - 8);
        const w = Math.max(2, (k.len / t) * (width - 8) - 1);
        return <rect key={i} x={x} y={h - 4 - Math.min(26, 6 + k.len * 40)} width={w} height={Math.min(26, 6 + k.len * 40)} rx={1.5} />;
      })}
    </svg>
  );
}

export const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;
