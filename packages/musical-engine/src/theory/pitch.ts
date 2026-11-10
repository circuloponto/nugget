/**
 * Spelled pitch arithmetic (12-TET).
 *
 * A pitch is identified by a letter, an integer accidental (+1 = sharp,
 * -1 = flat, +2 = double sharp, …) and an octave in scientific pitch notation
 * (C4 = MIDI 60). The octave belongs to the *letter*, so B#3 === MIDI 60 and
 * Cb4 === MIDI 59. Spelling is therefore never lost, unlike a sharps-only
 * pitch-class table.
 */
import { MusicTheoryError } from "../errors";

export type Letter = "C" | "D" | "E" | "F" | "G" | "A" | "B";

export const LETTERS: readonly Letter[] = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL_PC: readonly number[] = [0, 2, 4, 5, 7, 9, 11];

/** A spelled pitch class: letter + accidental, no octave. */
export interface Note {
  readonly letter: Letter;
  /** +1 sharp, -1 flat, 0 natural, ±2 double, … */
  readonly accidental: number;
}

/** A spelled, octave-qualified pitch. */
export interface Pitch extends Note {
  readonly octave: number;
}

/**
 * A spelled interval: `steps` is the number of letter steps (0 = unison,
 * 2 = a third, 7 = an octave) and `semitones` the size in half steps.
 * Both are needed to name the result correctly (C + 3 semitones is Eb or D#
 * depending on whether `steps` is 2 or 1).
 */
export interface Interval {
  readonly steps: number;
  readonly semitones: number;
}

export const mod = (n: number, m: number): number => ((n % m) + m) % m;

export function letterIndex(letter: Letter): number {
  return LETTERS.indexOf(letter);
}

/** Pitch class 0-11 of a spelled note. */
export function pitchClass(note: Note): number {
  return mod(NATURAL_PC[letterIndex(note.letter)]! + note.accidental, 12);
}

/** MIDI number of a spelled pitch (C4 = 60). */
export function midi(pitch: Pitch): number {
  return 12 * (pitch.octave + 1) + NATURAL_PC[letterIndex(pitch.letter)]! + pitch.accidental;
}

/** Absolute diatonic step index (letter position counted from C0). */
export function diatonicIndex(pitch: Pitch): number {
  return pitch.octave * 7 + letterIndex(pitch.letter);
}

export function note(letter: Letter, accidental = 0): Note {
  return { letter, accidental };
}

export function pitch(letter: Letter, accidental: number, octave: number): Pitch {
  return { letter, accidental, octave };
}

const ACCIDENTAL_RE = /^(#{1,}|b{1,}|♯+|♭+|x)?$/;

function parseAccidental(text: string): number {
  if (!ACCIDENTAL_RE.test(text)) {
    throw new MusicTheoryError(`Invalid accidental "${text}"`);
  }
  if (text === "") return 0;
  if (text === "x") return 2; // conventional double-sharp
  const c = text[0]!;
  return c === "#" || c === "♯" ? text.length : -text.length;
}

/** Parse "F#", "Bb", "C##", "Ebb", "F♯". Case of the letter must be upper. */
export function parseNote(text: string): Note {
  const m = /^([A-G])(.*)$/.exec(text.trim());
  if (!m) throw new MusicTheoryError(`Invalid note name "${text}"`);
  return { letter: m[1] as Letter, accidental: parseAccidental(m[2]!) };
}

/** Parse "C4", "F#3", "Bb2", "B#3", "Cb-1". */
export function parsePitch(text: string): Pitch {
  const m = /^([A-G])([#b♯♭x]*)(-?\d+)$/.exec(text.trim());
  if (!m) throw new MusicTheoryError(`Invalid pitch "${text}"`);
  return {
    letter: m[1] as Letter,
    accidental: parseAccidental(m[2]!),
    octave: Number(m[3]),
  };
}

export function accidentalToString(accidental: number): string {
  if (accidental === 0) return "";
  return (accidental > 0 ? "#" : "b").repeat(Math.abs(accidental));
}

export function formatNote(n: Note): string {
  return `${n.letter}${accidentalToString(n.accidental)}`;
}

export function formatPitch(p: Pitch): string {
  return `${formatNote(p)}${p.octave}`;
}

/** Same sounding pitch class (C# and Db are enharmonic). */
export function isEnharmonic(a: Note, b: Note): boolean {
  return pitchClass(a) === pitchClass(b);
}

/** Exact same spelling. */
export function isSameNote(a: Note, b: Note): boolean {
  return a.letter === b.letter && a.accidental === b.accidental;
}

/**
 * Add an interval to a pitch, spelling the result by letter step first and
 * deriving the accidental from the required semitone distance. Compound
 * and negative intervals are supported.
 */
export function addInterval(from: Pitch, interval: Interval): Pitch {
  const targetIndex = diatonicIndex(from) + interval.steps;
  const octave = Math.floor(targetIndex / 7);
  const letter = LETTERS[mod(targetIndex, 7)]!;
  const targetMidi = midi(from) + interval.semitones;
  const natural = 12 * (octave + 1) + NATURAL_PC[mod(targetIndex, 7)]!;
  return { letter, octave, accidental: targetMidi - natural };
}

/** Spelled interval from `a` up (or down, if negative) to `b`. */
export function intervalBetween(a: Pitch, b: Pitch): Interval {
  return { steps: diatonicIndex(b) - diatonicIndex(a), semitones: midi(b) - midi(a) };
}

export function transposeNote(n: Note, interval: Interval): Note {
  const { letter, accidental } = addInterval({ ...n, octave: 4 }, interval);
  return { letter, accidental };
}

/**
 * Spell a MIDI number as a given note name (e.g. MIDI 61 as Db → Db4). Throws
 * if the MIDI number is not a pitch-class match for the note.
 */
export function pitchFromMidi(midiNumber: number, spelling: Note): Pitch {
  const base = NATURAL_PC[letterIndex(spelling.letter)]! + spelling.accidental;
  const diff = midiNumber - base;
  if (mod(diff, 12) !== 0) {
    throw new MusicTheoryError(`MIDI ${midiNumber} is not ${formatNote(spelling)}`);
  }
  return { ...spelling, octave: diff / 12 - 1 };
}

export function toNote(p: Pitch): Note {
  return { letter: p.letter, accidental: p.accidental };
}

export const noteKey = (n: Note): string => formatNote(n);
