/**
 * Motifs and their development. A motif is a short shape with an identity made of separable
 * parts: its intervals (spelled), its rhythm (exact offsets and durations), its accents and its
 * length. A transformation keeps some parts and changes others, and says which: the claim is not
 * trusted, it is recomputed by `compareMotifs`, and the tests hold every transformation to it.
 *
 *   Three notes with the same rhythm but new intervals  → rhythm preserved, intervals transformed.
 *   The same intervals with augmented durations         → intervals preserved, rhythm transformed.
 */
import { addInterval, intervalBetween, midi, type Interval, type Pitch } from "../theory/pitch";
import { fadd, fcmp, fdiv, fmul, fstr, frac, fsub, type Fraction } from "../time/rational";
import { stepInScale, type PitchSpace } from "./operations";

export interface MotifNote {
  /** Spelled interval from the previous note (zero for the first). */
  readonly interval: Interval;
  /** Offset from the start of the motif (after `delay`). */
  readonly offset: Fraction;
  readonly duration: Fraction;
  readonly accent: number;
}

export type MotifAspect = "intervals" | "contour" | "rhythm" | "accents" | "length" | "start-pitch" | "delay";

export interface MotifStep {
  readonly op: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly preserved: readonly MotifAspect[];
  readonly transformed: readonly MotifAspect[];
}

export interface Motif {
  readonly id: string;
  readonly name?: string;
  /** Pitch of the first note. */
  readonly start: Pitch;
  readonly notes: readonly MotifNote[];
  /** Total span (a motif may end with silence, so this can exceed the last note's end). */
  readonly length: Fraction;
  /** A leading silence before the first note: rhythmic displacement. */
  readonly delay: Fraction;
  /** How this motif came to be. */
  readonly lineage: readonly MotifStep[];
}

export interface TimedPitch {
  readonly pitch: Pitch;
  readonly onset: Fraction;
  readonly duration: Fraction;
  readonly accent: number;
}

/** Build a motif from notes (onsets are made relative to the first). */
export function motifFromNotes(id: string, notes: readonly TimedPitch[], opts: { name?: string; length?: Fraction } = {}): Motif {
  if (notes.length === 0) throw new RangeError("a motif needs at least one note");
  const first = notes[0]!;
  const last = notes[notes.length - 1]!;
  const end = fadd(last.onset, last.duration);
  return {
    id,
    ...(opts.name ? { name: opts.name } : {}),
    start: first.pitch,
    notes: notes.map((n, i) => ({
      interval: i === 0 ? { steps: 0, semitones: 0 } : intervalBetween(notes[i - 1]!.pitch, n.pitch),
      offset: fsub(n.onset, first.onset),
      duration: n.duration,
      accent: n.accent,
    })),
    length: opts.length ?? fsub(end, first.onset),
    delay: frac(0),
    lineage: [],
  };
}

/** Place a motif in time: the exact pitches and onsets it produces from `onset`. */
export function realizeMotif(m: Motif, onset: Fraction): TimedPitch[] {
  const out: TimedPitch[] = [];
  let p = m.start;
  m.notes.forEach((n, i) => {
    if (i > 0) p = addInterval(p, n.interval);
    out.push({ pitch: p, onset: fadd(fadd(onset, m.delay), n.offset), duration: n.duration, accent: n.accent });
  });
  return out;
}

export const pitchesOf = (m: Motif): Pitch[] => realizeMotif(m, frac(0)).map((n) => n.pitch);
export const lastPitch = (m: Motif): Pitch => pitchesOf(m)[m.notes.length - 1]!;

// ── identity: what can be compared ─────────────────────────────────────────
export interface MotifSignature {
  readonly intervals: string;
  readonly contour: string;
  readonly rhythm: string;
  readonly accents: string;
  readonly length: string;
  readonly start: number;
  readonly delay: string;
}

export function signatureOf(m: Motif): MotifSignature {
  const iv = m.notes.slice(1).map((n) => n.interval.semitones);
  return {
    intervals: iv.join(","),
    contour: iv.map((x) => (x > 0 ? "u" : x < 0 ? "d" : "l")).join(""),
    rhythm: m.notes.map((n) => `${fstr(n.offset)}+${fstr(n.duration)}`).join(","),
    accents: m.notes.map((n) => n.accent).join(","),
    length: fstr(m.length),
    start: midi(m.start),
    delay: fstr(m.delay),
  };
}

/** Which aspects two motifs share, and which differ. */
export function compareMotifs(a: Motif, b: Motif): { preserved: MotifAspect[]; transformed: MotifAspect[] } {
  const x = signatureOf(a);
  const y = signatureOf(b);
  const pairs: [MotifAspect, boolean][] = [
    ["intervals", x.intervals === y.intervals],
    ["contour", x.contour === y.contour],
    ["rhythm", x.rhythm === y.rhythm],
    ["accents", x.accents === y.accents],
    ["length", x.length === y.length],
    ["start-pitch", x.start === y.start],
    ["delay", x.delay === y.delay],
  ];
  return { preserved: pairs.filter(([, same]) => same).map(([k]) => k), transformed: pairs.filter(([, same]) => !same).map(([k]) => k) };
}

function derive(from: Motif, next: Omit<Motif, "lineage" | "id"> & { id?: string }, op: string, params: Record<string, string | number>): Motif {
  const candidate: Motif = { ...next, id: next.id ?? `${from.id}.${op}`, lineage: from.lineage };
  const { preserved, transformed } = compareMotifs(from, candidate);
  return { ...candidate, lineage: [...from.lineage, { op, params, preserved, transformed }] };
}

// ── transformations ───────────────────────────────────────────────────────
const zero: Interval = { steps: 0, semitones: 0 };

/** Start the motif on another pitch: same intervals, same rhythm. */
export function transposeMotif(m: Motif, by: Interval): Motif {
  return derive(m, { ...m, start: addInterval(m.start, by) }, "transpose", { semitones: by.semitones });
}

/** Start the motif `steps` scale steps higher (negative = lower): a real sequence step. */
export function shiftMotifInScale(m: Motif, steps: number, space: PitchSpace): Motif {
  let p = m.start;
  for (let i = 0; i < Math.abs(steps); i++) p = stepInScale(p, steps > 0 ? 1 : -1, space);
  return derive(m, { ...m, start: p }, "transpose", { scaleSteps: steps });
}

/** Mirror the intervals: every move up becomes the same move down. Rhythm untouched. */
export function invertMotif(m: Motif): Motif {
  return derive(
    m,
    { ...m, notes: m.notes.map((n, i) => (i === 0 ? n : { ...n, interval: { steps: -n.interval.steps, semitones: -n.interval.semitones } })) },
    "invert",
    {},
  );
}

/** Play the notes backwards: reversed pitches, reversed durations. */
export function retrograde(m: Motif): Motif {
  const pitches = pitchesOf(m);
  const rev = [...m.notes].reverse();
  const last = pitches[pitches.length - 1]!;
  // new offsets: mirror each note inside the motif's span
  const mirrored = rev.map((n) => ({ dur: n.duration, off: fsub(m.length, fadd(n.offset, n.duration)), accent: n.accent }));
  const notes: MotifNote[] = mirrored.map((n, i) => ({
    interval: i === 0 ? zero : intervalBetween(pitches[pitches.length - i]!, pitches[pitches.length - 1 - i]!),
    offset: n.off,
    duration: n.dur,
    accent: n.accent,
  }));
  return derive(m, { ...m, start: last, notes }, "retrograde", {});
}

/** Stretch (factor > 1) or squeeze (< 1) every time value. Intervals untouched. */
export function scaleRhythm(m: Motif, factor: Fraction): Motif {
  if (factor.num <= 0) throw new RangeError("rhythmic factor must be positive");
  const op = fcmp(factor, frac(1)) > 0 ? "augment" : "diminish";
  return derive(
    m,
    {
      ...m,
      notes: m.notes.map((n) => ({ ...n, offset: fmul(n.offset, factor), duration: fmul(n.duration, factor) })),
      length: fmul(m.length, factor),
      delay: fmul(m.delay, factor),
    },
    op,
    { factor: fstr(factor) },
  );
}
export const augment = (m: Motif, factor: Fraction = frac(2)): Motif => scaleRhythm(m, factor);
export const diminish = (m: Motif, divisor: Fraction = frac(2)): Motif => scaleRhythm(m, fdiv(frac(1), divisor));

/** Keep notes [from, to): a fragment of the motif, rebased to start at zero. */
export function fragment(m: Motif, from: number, to: number): Motif {
  const keep = m.notes.slice(from, to);
  if (keep.length === 0) throw new RangeError("fragment is empty");
  const pitches = pitchesOf(m).slice(from, to);
  const base = keep[0]!.offset;
  const end = fadd(keep[keep.length - 1]!.offset, keep[keep.length - 1]!.duration);
  return derive(
    m,
    {
      ...m,
      start: pitches[0]!,
      notes: keep.map((n, i) => ({ ...n, interval: i === 0 ? zero : n.interval, offset: fsub(n.offset, base) })),
      length: fsub(end, base),
    },
    "fragment",
    { from, to },
  );
}

/** Add notes after the motif (each: an interval from the previous note and a duration). */
export function extendMotif(m: Motif, extra: readonly { interval: Interval; duration: Fraction; accent?: number }[]): Motif {
  let at = m.length;
  const added: MotifNote[] = extra.map((e) => {
    const n: MotifNote = { interval: e.interval, offset: at, duration: e.duration, accent: e.accent ?? 1 };
    at = fadd(at, e.duration);
    return n;
  });
  return derive(m, { ...m, notes: [...m.notes, ...added], length: at }, "extend", { notes: extra.length });
}

/** Shift the whole motif later inside its slot (rhythmic displacement): the pitches and durations are the same, the onsets are not. */
export function displaceMotif(m: Motif, by: Fraction): Motif {
  const delay = fadd(m.delay, by);
  if (delay.num < 0) throw new RangeError("displacement cannot start before the motif");
  return derive(m, { ...m, delay }, "displace", { by: fstr(by) });
}

/** The same notes with a new rhythm: intervals are retained, so the motif stays recognizable by its shape. */
export function varyRhythm(m: Motif, durations: readonly Fraction[]): Motif {
  if (durations.length !== m.notes.length) throw new RangeError("one duration per note");
  let at = frac(0);
  const notes = m.notes.map((n, i) => {
    const out: MotifNote = { ...n, offset: at, duration: durations[i]! };
    at = fadd(at, durations[i]!);
    return out;
  });
  return derive(m, { ...m, notes, length: at }, "vary-rhythm", { durations: durations.map(fstr).join(",") });
}

/** The same rhythm with new intervals: rhythmic identity is retained. */
export function varyIntervals(m: Motif, intervals: readonly Interval[]): Motif {
  if (intervals.length !== m.notes.length - 1) throw new RangeError("one interval between each pair of notes");
  return derive(m, { ...m, notes: m.notes.map((n, i) => (i === 0 ? n : { ...n, interval: intervals[i - 1]! })) }, "vary-intervals", { semitones: intervals.map((i) => i.semitones).join(",") });
}

/** The motif followed by `times - 1` more statements of itself back to back (the same pitches: repetition). */
export function repeatMotif(m: Motif, times: number): Motif {
  if (times < 1) throw new RangeError("repeat at least once");
  const first = pitchesOf(m);
  const joinBack = intervalBetween(first[first.length - 1]!, first[0]!);
  const notes: MotifNote[] = [...m.notes];
  for (let t = 1; t < times; t++) {
    m.notes.forEach((n, i) => {
      notes.push({ ...n, interval: i === 0 ? joinBack : n.interval, offset: fadd(n.offset, fmul(m.length, frac(t))) });
    });
  }
  return derive(m, { ...m, notes, length: fmul(m.length, frac(times)) }, "repeat", { times });
}

/**
 * A real melodic sequence: the motif, then the same motif `by` higher, and again, `times` statements
 * in all. Intervals and rhythm of each statement are those of the original.
 */
export function sequenceMotif(m: Motif, by: Interval, times: number): Motif {
  if (times < 1) throw new RangeError("a sequence needs at least one statement");
  const base = pitchesOf(m);
  const notes: MotifNote[] = [...m.notes];
  let prev = base[base.length - 1]!;
  for (let t = 1; t < times; t++) {
    const shifted = base.map((p) => addInterval(p, { steps: by.steps * t, semitones: by.semitones * t }));
    m.notes.forEach((n, i) => {
      notes.push({ ...n, interval: i === 0 ? intervalBetween(prev, shifted[0]!) : n.interval, offset: fadd(n.offset, fmul(m.length, frac(t))) });
    });
    prev = shifted[shifted.length - 1]!;
  }
  return derive(m, { ...m, notes, length: fmul(m.length, frac(times)) }, "sequence", { semitones: by.semitones, times });
}

/**
 * Fit a motif to a target: transposed so that its LAST note is `target`, placed so that this note
 * begins exactly at `arrival`. Throws if that would start before time zero.
 */
export function fitMotifToTarget(m: Motif, target: Pitch, arrival: Fraction): { motif: Motif; onset: Fraction } {
  const last = lastPitch(m);
  const lastNote = m.notes[m.notes.length - 1]!;
  const onset = fsub(arrival, fadd(m.delay, lastNote.offset));
  if (onset.num < 0) throw new RangeError("the motif does not fit before the target arrival");
  return { motif: transposeMotif(m, intervalBetween(last, target)), onset };
}
