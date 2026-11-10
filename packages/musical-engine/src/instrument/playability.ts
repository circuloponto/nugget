/**
 * Physical playability of a set of simultaneous notes on a fretboard.
 * One validator is the single source of truth: the realizer proposes
 * candidates and this module accepts or rejects them.
 */
import { midi, type Pitch } from "../theory/pitch";
import { midiAt, type Fretboard } from "./fretboard";

export interface PlayabilityConstraints {
  /** Lowest allowed fret (0 = open strings allowed by fret range). Default 0. */
  minFret: number;
  /** Highest allowed fret. Default 17 (clamped to the instrument's frets). */
  maxFret: number;
  /**
   * Maximum stretch: highest fretted fret minus lowest fretted fret. Open
   * strings (fret 0) do not count toward the stretch. Default 4, i.e. index
   * finger on fret n, little finger on fret n+4 (an extended reach). Use 3 for
   * a comfortable four-fret box. One definition, replacing the reference's
   * mix of inclusive/exclusive spans and hard-coded 2/3/4/5.
   */
  maxFretSpan: number;
  /** Allow open strings. Default true. */
  allowOpenStrings: boolean;
  /** All sounding strings must be adjacent (no skipped strings). Default true. */
  requireContiguousStrings: boolean;
  /**
   * Lower voices must sit on lower strings (bass on the lowest string, voices
   * ascending with the strings). Default true.
   */
  requireAscendingStrings: boolean;
  /** Fretting-hand fingers available (a barre counts as one). Default 4. */
  maxFingers: number;
}

export const DEFAULT_CONSTRAINTS: PlayabilityConstraints = {
  minFret: 0,
  maxFret: 17,
  maxFretSpan: 4,
  allowOpenStrings: true,
  requireContiguousStrings: true,
  requireAscendingStrings: true,
  maxFingers: 4,
};

export function withDefaults(c: Partial<PlayabilityConstraints> = {}): PlayabilityConstraints {
  return { ...DEFAULT_CONSTRAINTS, ...c };
}

/** One sounding note on the fretboard. `pitch` carries the abstract spelling. */
export interface GuitarNote {
  readonly string: number;
  readonly fret: number;
  readonly midi: number;
  readonly pitch: Pitch;
}

export type ViolationCode =
  | "NoNotes"
  | "StringOutOfRange"
  | "FretOutOfRange"
  | "StringReused"
  | "OpenStringNotAllowed"
  | "NonContiguousStrings"
  | "StringOrder"
  | "FretSpanTooWide"
  | "TooManyFingers"
  | "PitchMismatch";

export interface Violation {
  readonly code: ViolationCode;
  readonly message: string;
}

/** Number of fretting fingers needed, allowing one barre on the lowest fretted fret. */
export function fingersRequired(notes: readonly { string: number; fret: number }[]): number {
  const fretted = notes.filter((n) => n.fret > 0);
  if (fretted.length === 0) return 0;
  const lowest = Math.min(...fretted.map((n) => n.fret));
  const atLowest = fretted.filter((n) => n.fret === lowest);
  const others = fretted.length - atLowest.length;
  if (atLowest.length < 2) return fretted.length;
  const lo = Math.min(...atLowest.map((n) => n.string));
  const hi = Math.max(...atLowest.map((n) => n.string));
  // A barre is blocked if any note between its ends is open or lower than it.
  const blocked = notes.some((n) => n.string > lo && n.string < hi && n.fret < lowest);
  return (blocked ? atLowest.length : 1) + others;
}

/**
 * Check a candidate voicing (notes in voice order, bass first) against the
 * instrument and constraints. Empty result = physically valid.
 * If `expectedPitches` is given, each note must sound exactly that pitch.
 */
export function validateVoicing(
  notes: readonly GuitarNote[],
  fb: Fretboard,
  constraints: PlayabilityConstraints,
  expectedPitches?: readonly Pitch[],
): Violation[] {
  const v: Violation[] = [];
  if (notes.length === 0) return [{ code: "NoNotes", message: "A voicing needs at least one note" }];

  const maxFret = Math.min(constraints.maxFret, fb.fretCount);
  for (const n of notes) {
    if (!Number.isInteger(n.string) || n.string < 0 || n.string >= fb.tuning.strings.length) {
      v.push({ code: "StringOutOfRange", message: `String index ${n.string} does not exist` });
      return v; // nothing else can be evaluated safely
    }
    if (!Number.isInteger(n.fret) || n.fret < constraints.minFret || n.fret > maxFret) {
      v.push({ code: "FretOutOfRange", message: `Fret ${n.fret} outside ${constraints.minFret}-${maxFret}` });
    }
    if (n.fret === 0 && !constraints.allowOpenStrings) {
      v.push({ code: "OpenStringNotAllowed", message: `Open string ${n.string} not allowed` });
    }
  }
  if (v.some((x) => x.code === "FretOutOfRange")) return v;

  const strings = notes.map((n) => n.string);
  if (new Set(strings).size !== strings.length) {
    v.push({ code: "StringReused", message: "Two voices share a string" });
    return v;
  }
  const sorted = [...strings].sort((a, b) => a - b);
  if (constraints.requireContiguousStrings && sorted[sorted.length - 1]! - sorted[0]! !== sorted.length - 1) {
    v.push({ code: "NonContiguousStrings", message: `Strings [${sorted.join(", ")}] skip a string` });
  }
  if (constraints.requireAscendingStrings && strings.some((s, i) => i > 0 && s <= strings[i - 1]!)) {
    v.push({ code: "StringOrder", message: "Voices do not ascend with the strings" });
  }

  const fretted = notes.filter((n) => n.fret > 0).map((n) => n.fret);
  if (fretted.length > 0) {
    const span = Math.max(...fretted) - Math.min(...fretted);
    if (span > constraints.maxFretSpan) {
      v.push({ code: "FretSpanTooWide", message: `Stretch of ${span} frets exceeds ${constraints.maxFretSpan}` });
    }
  }
  const fingers = fingersRequired(notes);
  if (fingers > constraints.maxFingers) {
    v.push({ code: "TooManyFingers", message: `Needs ${fingers} fingers, only ${constraints.maxFingers} available` });
  }

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    const actual = midiAt(fb, n.string, n.fret);
    if (actual !== n.midi) {
      v.push({ code: "PitchMismatch", message: `String ${n.string} fret ${n.fret} sounds MIDI ${actual}, not ${n.midi}` });
    }
    const expected = expectedPitches?.[i];
    if (expected && actual !== midi(expected)) {
      v.push({ code: "PitchMismatch", message: `Voice ${i} should sound MIDI ${midi(expected)}, sounds ${actual}` });
    }
  }
  return v;
}
