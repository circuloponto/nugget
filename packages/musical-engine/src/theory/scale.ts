/**
 * Heptatonic scales defined by *spelled* intervals above the tonic, so every
 * key gets correct note names (F# major has E#, G# harmonic minor has F##).
 *
 * Scale "steps" are absolute: step 0 is the tonic, step 7 the tonic one octave
 * up, step -1 the leading-tone below. Voices in the cycle/voicing code are
 * expressed in these steps, which keeps octaves exact.
 */
import { MusicTheoryError } from "../errors";
import {
  addInterval,
  mod,
  parseNote,
  pitchClass,
  pitchFromMidi,
  pitch as makePitch,
  toNote,
  type Interval,
  type Note,
  type Pitch,
} from "./pitch";

export type ScaleType = "major" | "naturalMinor" | "harmonicMinor";

const P1: Interval = { steps: 0, semitones: 0 };
const M2: Interval = { steps: 1, semitones: 2 };
const m3: Interval = { steps: 2, semitones: 3 };
const M3: Interval = { steps: 2, semitones: 4 };
const P4: Interval = { steps: 3, semitones: 5 };
const P5: Interval = { steps: 4, semitones: 7 };
const m6: Interval = { steps: 5, semitones: 8 };
const M6: Interval = { steps: 5, semitones: 9 };
const m7: Interval = { steps: 6, semitones: 10 };
const M7: Interval = { steps: 6, semitones: 11 };

/** Intervals above the tonic for degrees 1-7. */
export const SCALE_DEFINITIONS: Readonly<Record<ScaleType, readonly Interval[]>> = {
  major: [P1, M2, M3, P4, P5, M6, M7],
  naturalMinor: [P1, M2, m3, P4, P5, m6, m7],
  harmonicMinor: [P1, M2, m3, P4, P5, m6, M7],
};

export const SCALE_TYPES = Object.keys(SCALE_DEFINITIONS) as ScaleType[];

export interface Scale {
  readonly tonic: Note;
  readonly type: ScaleType;
  /** The seven spelled notes, degree 1 first. */
  readonly notes: readonly Note[];
}

export function isScaleType(value: string): value is ScaleType {
  return Object.prototype.hasOwnProperty.call(SCALE_DEFINITIONS, value);
}

export function buildScale(tonic: Note | string, type: ScaleType): Scale {
  const t = typeof tonic === "string" ? parseNote(tonic) : tonic;
  const defs = SCALE_DEFINITIONS[type];
  if (!defs) throw new MusicTheoryError(`Unknown scale type "${String(type)}"`);
  const base = makePitch(t.letter, t.accidental, 4);
  return {
    tonic: t,
    type,
    notes: defs.map((i) => toNote(addInterval(base, i))),
  };
}

/** Spelled interval from the tonic to absolute scale step `step` (compound ok). */
export function intervalAtStep(type: ScaleType, step: number): Interval {
  const octaves = Math.floor(step / 7);
  const degreeIndex = mod(step, 7);
  const base = SCALE_DEFINITIONS[type][degreeIndex]!;
  return { steps: base.steps + 7 * octaves, semitones: base.semitones + 12 * octaves };
}

/**
 * Pitch at absolute scale step. `tonicOctave` is the octave of step 0 (the
 * tonic). Octave numbers advance at the letter C, so for tonic A the sequence
 * A4 B4 C#5 … is produced correctly.
 */
export function pitchAtStep(scale: Scale, step: number, tonicOctave: number): Pitch {
  const tonic = makePitch(scale.tonic.letter, scale.tonic.accidental, tonicOctave);
  return addInterval(tonic, intervalAtStep(scale.type, step));
}

/**
 * Spell a sounding MIDI number using the scale's own note names (MIDI 66 in Db
 * major is Gb4, in F# major it is F#4). Returns undefined if the pitch class is
 * not in the scale.
 */
export function spellMidiInScale(scale: Scale, midiNumber: number): Pitch | undefined {
  const pc = mod(midiNumber, 12);
  const match = scale.notes.find((n) => pitchClass(n) === pc);
  return match ? pitchFromMidi(midiNumber, match) : undefined;
}

/** Note (no octave) of degree 1-7. */
export function degreeNote(scale: Scale, degree: number): Note {
  if (!Number.isInteger(degree) || degree < 1 || degree > 7) {
    throw new MusicTheoryError(`Scale degree must be an integer 1-7, got ${degree}`);
  }
  return scale.notes[degree - 1]!;
}
