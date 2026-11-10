/**
 * Guitar fretboard model. This layer is pure geometry over MIDI numbers: it
 * knows nothing about keys, spelling or chords. Spelling is attached by the
 * abstract voicing that is being realized.
 *
 * STRING INDEX CONVENTION (single, explicit): index 0 is the LOWEST-pitched
 * string (the "6th" string on a standard guitar) and index n-1 the highest.
 * Use `guitarStringNumber` to convert to the traditional 6…1 numbering.
 * (The reference project mixed both conventions in comments and data.)
 */
import { MusicTheoryError } from "../errors";
import { midi, parsePitch, type Pitch } from "../theory/pitch";

export interface Tuning {
  readonly name: string;
  /** Open-string pitches, lowest string first. */
  readonly strings: readonly Pitch[];
}

export function makeTuning(name: string, strings: readonly (string | Pitch)[]): Tuning {
  if (strings.length === 0) throw new MusicTheoryError("A tuning needs at least one string");
  const pitches = strings.map((s) => (typeof s === "string" ? parsePitch(s) : s));
  return { name, strings: pitches };
}

export const STANDARD_TUNING: Tuning = makeTuning("Standard", ["E2", "A2", "D3", "G3", "B3", "E4"]);
export const DROP_D_TUNING: Tuning = makeTuning("Drop D", ["D2", "A2", "D3", "G3", "B3", "E4"]);

export interface Fretboard {
  readonly tuning: Tuning;
  /** Highest fret that physically exists (frets 0…fretCount). */
  readonly fretCount: number;
}

export function makeFretboard(tuning: Tuning = STANDARD_TUNING, fretCount = 22): Fretboard {
  if (!Number.isInteger(fretCount) || fretCount < 1) throw new MusicTheoryError("fretCount must be a positive integer");
  return { tuning, fretCount };
}

export interface FretPosition {
  /** 0 = lowest-pitched string. */
  readonly string: number;
  /** 0 = open string. */
  readonly fret: number;
}

/** Traditional guitar string number: 1 = highest string, n = lowest. */
export function guitarStringNumber(fb: Fretboard, stringIndex: number): number {
  return fb.tuning.strings.length - stringIndex;
}

export function openStringMidi(fb: Fretboard, string: number): number {
  const open = fb.tuning.strings[string];
  if (!open) throw new MusicTheoryError(`String index ${string} does not exist`);
  return midi(open);
}

/** MIDI number sounded at a string/fret. */
export function midiAt(fb: Fretboard, string: number, fret: number): number {
  if (!Number.isInteger(fret) || fret < 0 || fret > fb.fretCount) {
    throw new MusicTheoryError(`Fret ${fret} is outside 0-${fb.fretCount}`);
  }
  return openStringMidi(fb, string) + fret;
}

/** Every string/fret that sounds exactly `midiNumber` within [minFret, maxFret]. */
export function positionsForMidi(
  fb: Fretboard,
  midiNumber: number,
  minFret = 0,
  maxFret: number = fb.fretCount,
): FretPosition[] {
  const out: FretPosition[] = [];
  const hi = Math.min(maxFret, fb.fretCount);
  for (let string = 0; string < fb.tuning.strings.length; string++) {
    const fret = midiNumber - openStringMidi(fb, string);
    if (fret >= Math.max(0, minFret) && fret <= hi) out.push({ string, fret });
  }
  return out;
}

/** Lowest and highest MIDI pitch the instrument can sound. */
export function pitchRange(fb: Fretboard): { lowest: number; highest: number } {
  const opens = fb.tuning.strings.map(midi);
  return { lowest: Math.min(...opens), highest: Math.max(...opens) + fb.fretCount };
}
