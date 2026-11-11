/** Small, deterministic statistics helpers shared by the analyses. Everything returns plain JSON-able data. */

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, mean: 0, min: 0, max: 0, p25: 0, median: 0, p75: 0 };
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, mean: round(s.reduce((a, b) => a + b, 0) / s.length), min: s[0]!, max: s[s.length - 1]!, p25: round(quantile(s, 0.25)), median: round(quantile(s, 0.5)), p75: round(quantile(s, 0.75)) };
}

export const round = (x: number, places = 4): number => {
  const k = 10 ** places;
  return Math.round(x * k) / k;
};

export const share = (part: number, whole: number): number => (whole === 0 ? 0 : round(part / whole));

export type Histogram = Record<string, number>;

export function histogram<T>(values: readonly T[], key: (v: T) => string = String): Histogram {
  const h: Histogram = {};
  for (const v of values) {
    const k = key(v);
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
}

/** Entries of a histogram by descending count, then key (stable). */
export const topEntries = (h: Histogram, n = 10): [string, number][] => Object.entries(h).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

export function mergeHistograms(list: readonly Histogram[]): Histogram {
  const out: Histogram = {};
  for (const h of list) for (const [k, v] of Object.entries(h)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Pearson correlation; 0 when either side has no variance. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : round(sxy / Math.sqrt(sxx * syy));
}

/** Least-squares slope of ys over 0..n-1 (0 for fewer than two points). */
export function slope(ys: readonly number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i]! - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : round(num / den);
}
