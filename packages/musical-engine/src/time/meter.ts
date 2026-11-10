/**
 * Meter, pulse grouping and accent profiles.
 *
 * A meter is a bar made of pulses of one `unit` duration, grouped (7/8 as 2+2+3).
 * Everything is exact, so two meters sharing a pulse can be compared exactly
 * (polymeter).
 */
import { MusicTheoryError } from "../errors";
import { fadd, fmul, frac, parseFraction, type Fraction, ZERO } from "./rational";

export interface Meter {
  /** Pulses per group, e.g. [2, 2, 3] for 7/8. */
  readonly groups: readonly number[];
  /** Duration of one pulse (fraction of a whole note), e.g. 1/8. */
  readonly unit: Fraction;
}

export function makeMeter(groups: readonly number[], unit: Fraction): Meter {
  if (groups.length === 0 || groups.some((g) => !Number.isInteger(g) || g < 1)) {
    throw new MusicTheoryError("A meter needs at least one group of one or more pulses");
  }
  if (unit.num <= 0) throw new MusicTheoryError("A meter's pulse unit must be positive");
  return { groups: [...groups], unit };
}

/**
 * Parse "4/4", "3/4", "7/8", "6/8". Without explicit groups: compound meters
 * (numerator divisible by 3, denominator ≥ 8) group in threes, others in single
 * pulses. Pass `groups` for asymmetrical grouping, e.g. parseMeter("7/8", [2, 2, 3]).
 */
export function parseMeter(text: string, groups?: readonly number[]): Meter {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  if (!m) throw new MusicTheoryError(`Invalid meter "${text}"`);
  const n = Number(m[1]);
  const d = Number(m[2]);
  const unit = parseFraction(`1/${d}`);
  if (groups) {
    if (groups.reduce((a, b) => a + b, 0) !== n) {
      throw new MusicTheoryError(`Groups [${groups.join("+")}] do not add up to ${n} pulses`);
    }
    return makeMeter(groups, unit);
  }
  if (n % 3 === 0 && d >= 8 && n > 3) return makeMeter(Array(n / 3).fill(3), unit);
  return makeMeter(Array(n).fill(1), unit);
}

export const pulsesPerBar = (m: Meter): number => m.groups.reduce((a, b) => a + b, 0);

/** Length of one bar. */
export const barLength = (m: Meter): Fraction => fmul(m.unit, frac(pulsesPerBar(m)));

/** Onset of every pulse within the bar. */
export function pulsePositions(m: Meter): Fraction[] {
  return Array.from({ length: pulsesPerBar(m) }, (_, i) => fmul(m.unit, frac(i)));
}

/** Onset of every group within the bar (first is 0). */
export function groupStarts(m: Meter): Fraction[] {
  const out: Fraction[] = [];
  let acc = ZERO;
  for (const g of m.groups) {
    out.push(acc);
    acc = fadd(acc, fmul(m.unit, frac(g)));
  }
  return out;
}

/**
 * Accent weight of every pulse: 3 = downbeat, 2 = start of a group, 1 = other
 * pulses. (A hierarchy, not loudness: map it to dynamics elsewhere.)
 */
export function accentProfile(m: Meter): number[] {
  const out: number[] = [];
  m.groups.forEach((g, gi) => {
    for (let p = 0; p < g; p++) out.push(p === 0 ? (gi === 0 ? 3 : 2) : 1);
  });
  return out;
}

/** Total length of several consecutive bars. */
export const barsLength = (m: Meter, bars: number): Fraction => fmul(barLength(m), frac(bars));
