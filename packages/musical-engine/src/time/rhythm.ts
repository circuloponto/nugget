/**
 * Rhythmic cells and the operations on them: subdivision, tuplets (nested too),
 * polyrhythm, polymeter, phase rotation, augmentation/diminution, accent grouping.
 *
 * A cell is a bar-like span with events inside it. All times are exact fractions
 * of a whole note, so every operation is lossless: rotating a cell never changes
 * how much sound it contains, and a triplet is exactly one third of its span.
 */
import { MusicTheoryError } from "../errors";
import {
  fadd,
  fcmp,
  fdiv,
  feq,
  fle,
  flt,
  fmod,
  fmul,
  frac,
  fsub,
  fsum,
  lcmFractions,
  ZERO,
  type Fraction,
} from "./rational";

export interface RhythmEvent {
  /** Position inside the cell. */
  readonly onset: Fraction;
  readonly duration: Fraction;
  /** A rest sounds nothing but still occupies time. */
  readonly rest?: boolean;
  /** Accent weight (higher = stronger); see accentProfile for the meter hierarchy. */
  readonly accent?: number;
  /** This event continues into the next one (created when rotation splits a note). */
  readonly tiedToNext?: boolean;
}

export interface RhythmCell {
  readonly length: Fraction;
  /** Ascending by onset, non-overlapping, inside [0, length]. */
  readonly events: readonly RhythmEvent[];
}

/** Problems with a cell (empty = valid): order, overlap, bounds, positive durations. */
export function validateCell(c: RhythmCell): string[] {
  const issues: string[] = [];
  if (c.length.num <= 0) issues.push("cell length must be positive");
  c.events.forEach((e, i) => {
    if (e.onset.num < 0) issues.push(`event ${i}: negative onset`);
    if (e.duration.num <= 0) issues.push(`event ${i}: duration must be positive`);
    if (flt(c.length, fadd(e.onset, e.duration))) issues.push(`event ${i}: runs past the end of the cell`);
    const next = c.events[i + 1];
    if (next) {
      if (flt(next.onset, e.onset)) issues.push(`event ${i + 1}: out of order`);
      else if (flt(next.onset, fadd(e.onset, e.duration))) issues.push(`event ${i}: overlaps event ${i + 1}`);
    }
  });
  return issues;
}

/** Build a cell, throwing if it is not valid. */
export function makeCell(length: Fraction, events: readonly RhythmEvent[]): RhythmCell {
  const c = { length, events: [...events] };
  const issues = validateCell(c);
  if (issues.length) throw new MusicTheoryError(`Invalid rhythm cell: ${issues.join("; ")}`);
  return c;
}

/** Total time occupied by sounding (non-rest) events. */
export const soundingTime = (c: RhythmCell): Fraction =>
  fsum(c.events.filter((e) => !e.rest).map((e) => e.duration));

/** `n` equally spaced onsets across `span`: 0, span/n, 2·span/n, … */
export function subdivide(span: Fraction, n: number): Fraction[] {
  if (!Number.isInteger(n) || n < 1) throw new MusicTheoryError("subdivision count must be a positive integer");
  const step = fdiv(span, frac(n));
  return Array.from({ length: n }, (_, i) => fmul(step, frac(i)));
}

/** A cell of `n` equal notes filling `span`. Accent on the first note by default. */
export function subdivisionCell(span: Fraction, n: number, accentFirst = true): RhythmCell {
  const step = fdiv(span, frac(n));
  return makeCell(
    span,
    subdivide(span, n).map((onset, i) => ({ onset, duration: step, ...(accentFirst && i === 0 ? { accent: 2 } : {}) })),
  );
}

/** Duration of each note of a tuplet: `count` notes in the time of `inTimeOf` normal notes. Triplet eighth = tupletDuration(1/8, 3, 2) = 1/12. */
export function tupletDuration(normal: Fraction, count: number, inTimeOf: number): Fraction {
  if (!Number.isInteger(count) || !Number.isInteger(inTimeOf) || count < 1 || inTimeOf < 1) {
    throw new MusicTheoryError("tuplet counts must be positive integers");
  }
  return fdiv(fmul(normal, frac(inTimeOf)), frac(count));
}

/** `count` notes in the time of `inTimeOf` normal notes of value `normal`. */
export function tupletCell(normal: Fraction, count: number, inTimeOf: number): RhythmCell {
  return subdivisionCell(fmul(normal, frac(inTimeOf)), count);
}

/**
 * Replace event `index` by `n` equal events filling the same time: a tuplet
 * nested inside a note (e.g. a quintuplet inside the second note of a triplet).
 */
export function subdivideEvent(c: RhythmCell, index: number, n: number): RhythmCell {
  const e = c.events[index];
  if (!e) throw new MusicTheoryError(`No event ${index} to subdivide`);
  const step = fdiv(e.duration, frac(n));
  const parts: RhythmEvent[] = subdivide(e.duration, n).map((off, i) => ({
    onset: fadd(e.onset, off),
    duration: step,
    ...(e.rest ? { rest: true } : {}),
    ...(i === 0 && e.accent !== undefined ? { accent: e.accent } : {}),
  }));
  return makeCell(c.length, [...c.events.slice(0, index), ...parts, ...c.events.slice(index + 1)]);
}

/** Subdivide `span` by each factor in turn: [3, 2] → triplets each split in two (six equal notes). */
export function nestedSubdivision(span: Fraction, levels: readonly number[]): RhythmCell {
  let c = subdivisionCell(span, 1);
  for (const n of levels) {
    let next = c;
    // subdivide from the back so earlier indices stay valid
    for (let i = c.events.length - 1; i >= 0; i--) next = subdivideEvent(next, i, n);
    c = next;
  }
  return c;
}

export interface PolyrhythmResult {
  /** Onsets of each layer, in input order. */
  readonly layers: readonly { readonly ratio: number; readonly onsets: readonly Fraction[] }[];
  /** Every distinct attack time across layers, ascending, with the layers (by ratio) that sound there. */
  readonly merged: readonly { readonly onset: Fraction; readonly ratios: readonly number[] }[];
}

/**
 * Several equal subdivisions of the same span sounding together: [3, 2] is 3
 * against 2 (three equal attack spacings and two equal attack spacings across
 * the same total interval).
 */
export function polyrhythm(span: Fraction, ratios: readonly number[]): PolyrhythmResult {
  if (ratios.length === 0) throw new MusicTheoryError("polyrhythm needs at least one ratio");
  const layers = ratios.map((ratio) => ({ ratio, onsets: subdivide(span, ratio) }));
  const all = layers.flatMap((l) => l.onsets.map((onset) => ({ onset, ratio: l.ratio })));
  all.sort((a, b) => fcmp(a.onset, b.onset) || a.ratio - b.ratio);
  const merged: { onset: Fraction; ratios: number[] }[] = [];
  for (const a of all) {
    const last = merged[merged.length - 1];
    if (last && feq(last.onset, a.onset)) last.ratios.push(a.ratio);
    else merged.push({ onset: a.onset, ratios: [a.ratio] });
  }
  return { layers, merged };
}

/**
 * Polymeter: bars of different lengths running together realign after the
 * least common multiple of their lengths. 3/4 against 4/4 realigns after 3
 * whole notes = 12 quarter-note beats.
 */
export function polymeterRealignment(barLengths: readonly Fraction[]): Fraction {
  return lcmFractions(barLengths);
}

/**
 * Phase rotation: shift every event later by `offset` (wrapping around the
 * cell). A note that would cross the end is split in two, the first part tied to
 * the second, so the amount of sound is exactly preserved.
 */
export function rotate(c: RhythmCell, offset: Fraction): RhythmCell {
  const o = fmod(offset, c.length);
  const out: RhythmEvent[] = [];
  for (const e of logicalEvents(c)) {
    const onset = fmod(fadd(e.onset, o), c.length);
    const room = fsub(c.length, onset);
    if (fle(e.duration, room)) {
      out.push({ ...e, onset });
    } else {
      out.push({ ...e, onset, duration: room, ...(e.rest ? {} : { tiedToNext: true }) });
      out.push({
        onset: ZERO,
        duration: fsub(e.duration, room),
        ...(e.rest ? { rest: true } : {}),
        ...(e.tiedToNext ? { tiedToNext: true } : {}),
      });
    }
  }
  out.sort((a, b) => fcmp(a.onset, b.onset));
  return makeCell(c.length, out);
}

/**
 * The cell's notes with tied pieces joined back together, including a note tied
 * across the bar line (last event tied into an event at 0). A joined note may run
 * past the end of the cell: it wraps. Working on whole notes is what makes rotation
 * additive (rotate a then b == rotate a+b) however many times notes get split.
 */
function logicalEvents(c: RhythmCell): RhythmEvent[] {
  const merged: RhythmEvent[] = [];
  for (const e of c.events) {
    const prev = merged[merged.length - 1];
    if (prev?.tiedToNext && !prev.rest && feq(fadd(prev.onset, prev.duration), e.onset)) {
      const { tiedToNext: _drop, ...rest } = prev;
      merged[merged.length - 1] = {
        ...rest,
        duration: fadd(prev.duration, e.duration),
        ...(e.tiedToNext ? { tiedToNext: true } : {}),
      };
    } else {
      merged.push(e);
    }
  }
  const first = merged[0];
  const last = merged[merged.length - 1];
  if (merged.length > 1 && first && last && last.tiedToNext && feq(first.onset, ZERO) && feq(fadd(last.onset, last.duration), c.length)) {
    const { tiedToNext: _drop, ...rest } = last;
    merged[merged.length - 1] = {
      ...rest,
      duration: fadd(last.duration, first.duration),
      ...(first.tiedToNext ? { tiedToNext: true } : {}),
    };
    merged.shift();
  }
  return merged;
}

/** Augmentation (factor > 1) or diminution (factor < 1): every time value is multiplied. */
export function scaleCell(c: RhythmCell, factor: Fraction): RhythmCell {
  if (factor.num <= 0) throw new MusicTheoryError("scale factor must be positive");
  return makeCell(
    fmul(c.length, factor),
    c.events.map((e) => ({ ...e, onset: fmul(e.onset, factor), duration: fmul(e.duration, factor) })),
  );
}

/** Cells played one after another. */
export function concatCells(cells: readonly RhythmCell[]): RhythmCell {
  let offset = ZERO;
  const events: RhythmEvent[] = [];
  for (const c of cells) {
    for (const e of c.events) events.push({ ...e, onset: fadd(e.onset, offset) });
    offset = fadd(offset, c.length);
  }
  return makeCell(offset, events);
}

export const repeatCell = (c: RhythmCell, times: number): RhythmCell =>
  concatCells(Array.from({ length: times }, () => c));

/** The cell's events placed at absolute time starting at `start`. */
export function absoluteEvents(c: RhythmCell, start: Fraction = ZERO): RhythmEvent[] {
  return c.events.map((e) => ({ ...e, onset: fadd(e.onset, start) }));
}

/**
 * Accent by event grouping: the first event of each group (sizes in events, e.g.
 * [3, 2, 2]) gets accent 2 and the others 1; the very first event gets 3.
 */
export function accentsFromGroups(c: RhythmCell, groups: readonly number[]): RhythmCell {
  if (groups.reduce((a, b) => a + b, 0) !== c.events.length) {
    throw new MusicTheoryError(`Groups [${groups.join("+")}] do not cover ${c.events.length} events`);
  }
  const accents: number[] = [];
  groups.forEach((g, gi) => {
    for (let k = 0; k < g; k++) accents.push(k === 0 ? (gi === 0 ? 3 : 2) : 1);
  });
  return { length: c.length, events: c.events.map((e, i) => ({ ...e, accent: accents[i]! })) };
}
