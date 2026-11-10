/**
 * Melodic lines: notes with an exact position in time and a function along four independent
 * dimensions (harmonic, melodic, metric, structural). The same D over Cmaj7 can be the ninth
 * (harmonic), a passing tone (melodic), an accented arrival (metric) and part of a motif
 * (structural) at once; none of these excludes the others.
 */
import type { Pitch } from "../theory/pitch";
import { midi } from "../theory/pitch";
import { feq, ffloor, fmod, fadd, fcmp, fdiv, frac, fsub, type Fraction } from "../time/rational";

/** What a note is, along independent dimensions. Pitch identity lives in `LineNote.pitch`. */
export interface NoteFunctions {
  /** Harmonic degree roles over the sounding chord ("third", "ninth"); empty for a non-chord tone. */
  readonly harmonic: readonly string[];
  /** Melodic roles ("upper-chromatic-neighbor", "passing-tone", "arrival"); several may hold at once. */
  readonly melodic: readonly string[];
  /** Metric position: downbeat, strong, beat, offbeat or subdivision. */
  readonly metric: string;
  /** Structural roles ("target", "outline", "enclosure-member", "motif-member"). */
  readonly structural: readonly string[];
}

export interface LineNote {
  readonly kind: "note";
  readonly id: string;
  readonly pitch: Pitch;
  readonly onset: Fraction;
  readonly duration: Fraction;
  /** 0 off the pulse, 1 beat, 2 strong beat, 3 downbeat. */
  readonly accent: number;
  readonly functions: NoteFunctions;
  /** Where it is fretted, when the line has been realized on the guitar. */
  readonly position?: { readonly string: number; readonly fret: number };
  /** The gesture that produced it. */
  readonly gesture?: string;
}

export interface LineRest {
  readonly kind: "rest";
  readonly id: string;
  readonly onset: Fraction;
  readonly duration: Fraction;
}

export type LineEvent = LineNote | LineRest;

export const isNote = (e: LineEvent): e is LineNote => e.kind === "note";
export const notesOf = (line: readonly LineEvent[]): LineNote[] => line.filter(isNote);
export const endOf = (e: LineEvent): Fraction => fadd(e.onset, e.duration);

// ── metric position ───────────────────────────────────────────────────────
export interface MetricPosition {
  readonly label: "downbeat" | "strong" | "beat" | "offbeat" | "subdivision";
  readonly accent: 0 | 1 | 2 | 3;
  /** Beat number within the bar, from 1 (fractional when off the pulse). */
  readonly beat: number;
}

export interface MetricFrame {
  readonly bar: Fraction;
  readonly unit: Fraction;
  /** Pulse indices (0-based) that are strong beats (beat 3 of 4/4 is index 2). */
  readonly strongPulses: readonly number[];
}

/** 4/4 counted in quarters; beat 3 strong. */
export const FOUR_FOUR_FRAME: MetricFrame = { bar: frac(1), unit: frac(1, 4), strongPulses: [2] };

export function metricPosition(onset: Fraction, frame: MetricFrame = FOUR_FOUR_FRAME): MetricPosition {
  const pos = fmod(onset, frame.bar);
  const pulses = fdiv(pos, frame.unit);
  const idx = ffloor(pulses);
  const within = fmod(pos, frame.unit);
  const beat = idx + 1 + within.num / within.den / (frame.unit.num / frame.unit.den);
  if (within.num === 0) {
    if (idx === 0) return { label: "downbeat", accent: 3, beat };
    if (frame.strongPulses.includes(idx)) return { label: "strong", accent: 2, beat };
    return { label: "beat", accent: 1, beat };
  }
  return feq(within, fdiv(frame.unit, frac(2))) ? { label: "offbeat", accent: 0, beat } : { label: "subdivision", accent: 0, beat };
}

// ── contour and motion ────────────────────────────────────────────────────
export type MotionKind = "repeat" | "step" | "chromatic-step" | "skip" | "leap";

/** Classify the move between two pitches by size: repeat, semitone step, whole-tone step, skip (a third), leap (larger). */
export function motionKind(a: Pitch, b: Pitch): MotionKind {
  const d = Math.abs(midi(b) - midi(a));
  if (d === 0) return "repeat";
  if (d === 1) return "chromatic-step";
  if (d === 2) return "step";
  if (d <= 4) return "skip";
  return "leap";
}

export type Direction = "up" | "down" | "level";

export interface Contour {
  /** Direction of each consecutive move. */
  readonly directions: readonly Direction[];
  readonly motions: readonly MotionKind[];
  /** Indices (into the note list) where the direction reverses. */
  readonly turningPoints: readonly number[];
  readonly highest: number;
  readonly lowest: number;
  /** Highest minus lowest, in semitones. */
  readonly span: number;
  /** Overall movement first to last note, in semitones. */
  readonly net: number;
}

export function contourOf(notes: readonly { pitch: Pitch }[]): Contour {
  const ms = notes.map((n) => midi(n.pitch));
  const directions: Direction[] = [];
  const motions: MotionKind[] = [];
  for (let i = 1; i < notes.length; i++) {
    directions.push(ms[i]! > ms[i - 1]! ? "up" : ms[i]! < ms[i - 1]! ? "down" : "level");
    motions.push(motionKind(notes[i - 1]!.pitch, notes[i]!.pitch));
  }
  const turningPoints: number[] = [];
  let last: Direction = "level";
  directions.forEach((d, i) => {
    if (d === "level") return;
    if (last !== "level" && d !== last) turningPoints.push(i);
    last = d;
  });
  const hi = ms.length ? Math.max(...ms) : 0;
  const lo = ms.length ? Math.min(...ms) : 0;
  return { directions, motions, turningPoints, highest: ms.indexOf(hi), lowest: ms.indexOf(lo), span: hi - lo, net: ms.length ? ms[ms.length - 1]! - ms[0]! : 0 };
}

/** Semitone intervals between consecutive notes (signed). */
export const intervalsOf = (notes: readonly { pitch: Pitch }[]): number[] => notes.slice(1).map((n, i) => midi(n.pitch) - midi(notes[i]!.pitch));

// ── operations on time: HOLD and DISPLACE ─────────────────────────────────
/** Shift events in time by an exact amount (negative = earlier). Throws if anything would start before 0. */
export function displace<T extends LineEvent>(line: readonly T[], by: Fraction): T[] {
  return line.map((e) => {
    const onset = fadd(e.onset, by);
    if (onset.num < 0) throw new RangeError("displacement would move an event before the start");
    return { ...e, onset };
  });
}

/** Lengthen (or shorten) one event so that it ends at `until`. */
export function hold<T extends LineEvent>(event: T, until: Fraction): T {
  const duration = fsub(until, event.onset);
  if (duration.num <= 0) throw new RangeError("hold must end after the event begins");
  return { ...event, duration };
}

/** Do events overlap in time (a monophonic line must not)? Returns the first offending pair of ids. */
export function firstOverlap(line: readonly LineEvent[]): [string, string] | null {
  const sorted = [...line].sort((a, b) => fcmp(a.onset, b.onset));
  for (let i = 1; i < sorted.length; i++) {
    if (fcmp(sorted[i]!.onset, endOf(sorted[i - 1]!)) < 0) return [sorted[i - 1]!.id, sorted[i]!.id];
  }
  return null;
}
