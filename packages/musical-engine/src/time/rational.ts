/**
 * Exact rational numbers for symbolic musical time.
 *
 * Positions and durations are fractions of a whole note (1/4 = a quarter note),
 * kept exact so a triplet is exactly 1/3 of its span and 3:2 against 2:3 really
 * does realign. Floating point only appears at the playback boundary
 * (`toSeconds`). All values are normalized (lowest terms, positive denominator),
 * so structural equality (`toEqual`) and JSON round-trips work.
 */
import { MusicTheoryError } from "../errors";

export interface Fraction {
  readonly num: number;
  /** Always > 0. */
  readonly den: number;
}

export function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function checkSafe(n: number, what: string): number {
  if (!Number.isSafeInteger(n)) throw new MusicTheoryError(`Fraction overflow while computing ${what}`);
  return n;
}

export function lcmInt(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return checkSafe(Math.abs((a / gcdInt(a, b)) * b), "lcm");
}

/** Build a normalized fraction. Both parts must be integers; the denominator may not be 0. */
export function frac(num: number, den = 1): Fraction {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new MusicTheoryError(`Fraction parts must be integers, got ${num}/${den}`);
  }
  if (den === 0) throw new MusicTheoryError("Fraction denominator cannot be 0");
  let n = num;
  let d = den;
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcdInt(n, d) || 1;
  // `|| 0` normalizes -0
  return { num: checkSafe(n / g, "numerator") || 0, den: checkSafe(d / g, "denominator") };
}

export const ZERO: Fraction = { num: 0, den: 1 };
export const ONE: Fraction = { num: 1, den: 1 };

export function fadd(a: Fraction, b: Fraction): Fraction {
  const l = lcmInt(a.den, b.den);
  return frac(checkSafe(a.num * (l / a.den) + b.num * (l / b.den), "sum"), l);
}
export const fneg = (a: Fraction): Fraction => frac(-a.num, a.den);
export const fsub = (a: Fraction, b: Fraction): Fraction => fadd(a, fneg(b));

export function fmul(a: Fraction, b: Fraction): Fraction {
  // cross-reduce first to keep intermediates small
  const g1 = gcdInt(a.num, b.den) || 1;
  const g2 = gcdInt(b.num, a.den) || 1;
  return frac(checkSafe((a.num / g1) * (b.num / g2), "product"), checkSafe((a.den / g2) * (b.den / g1), "product"));
}

export function fdiv(a: Fraction, b: Fraction): Fraction {
  if (b.num === 0) throw new MusicTheoryError("Division by zero fraction");
  return fmul(a, frac(b.den, b.num));
}

/** -1, 0 or 1. Uses BigInt so comparison can never overflow. */
export function fcmp(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const l = BigInt(a.num) * BigInt(b.den);
  const r = BigInt(b.num) * BigInt(a.den);
  return l < r ? -1 : l > r ? 1 : 0;
}
export const feq = (a: Fraction, b: Fraction): boolean => fcmp(a, b) === 0;
export const flt = (a: Fraction, b: Fraction): boolean => fcmp(a, b) < 0;
export const fle = (a: Fraction, b: Fraction): boolean => fcmp(a, b) <= 0;
export const fmin = (a: Fraction, b: Fraction): Fraction => (fle(a, b) ? a : b);
export const fmax = (a: Fraction, b: Fraction): Fraction => (fle(a, b) ? b : a);
export const fisZero = (a: Fraction): boolean => a.num === 0;
export const fsign = (a: Fraction): -1 | 0 | 1 => (a.num < 0 ? -1 : a.num > 0 ? 1 : 0);

/** Largest integer ≤ a. */
export function ffloor(a: Fraction): number {
  const n = BigInt(a.num);
  const d = BigInt(a.den);
  let q = n / d;
  if (n % d !== 0n && n < 0n) q -= 1n;
  return Number(q);
}

/** a modulo b, result in [0, b) for b > 0. */
export function fmod(a: Fraction, b: Fraction): Fraction {
  if (b.num <= 0) throw new MusicTheoryError("fmod needs a positive modulus");
  return fsub(a, fmul(b, frac(ffloor(fdiv(a, b)))));
}

/** Floating-point value; use only at the playback/display boundary. */
export const fnum = (a: Fraction): number => a.num / a.den;

export const fstr = (a: Fraction): string => (a.den === 1 ? `${a.num}` : `${a.num}/${a.den}`);

/** Parse "3/8" or "2" (and negatives). */
export function parseFraction(text: string): Fraction {
  const m = /^\s*(-?\d+)(?:\s*\/\s*(\d+))?\s*$/.exec(text);
  if (!m) throw new MusicTheoryError(`Invalid fraction "${text}"`);
  return frac(Number(m[1]), m[2] === undefined ? 1 : Number(m[2]));
}

/** Smallest positive span that is a whole number of each given (positive) fraction: lcm(a/b, c/d) = lcm(a,c)/gcd(b,d). */
export function lcmFractions(list: readonly Fraction[]): Fraction {
  if (list.length === 0) throw new MusicTheoryError("lcmFractions needs at least one fraction");
  let acc = list[0]!;
  if (acc.num <= 0) throw new MusicTheoryError("lcmFractions needs positive fractions");
  for (const x of list.slice(1)) {
    if (x.num <= 0) throw new MusicTheoryError("lcmFractions needs positive fractions");
    acc = frac(lcmInt(acc.num, x.num), gcdInt(acc.den, x.den));
  }
  return acc;
}

export function fsum(list: readonly Fraction[]): Fraction {
  return list.reduce(fadd, ZERO);
}
