/**
 * Chords beyond triads: seventh chords, extensions (9, 11, 13) and chromatic alterations,
 * with every tone spelled by letter step (so Bb7 has an Ab, never a G#).
 *
 * A chord degree is described independently of its pitch: "3" of Cmaj7 is the note E in any
 * octave. Harmonic function (root, third, ninth, ...) is therefore a property of a pitch
 * CLASS in a chord context, and stays separate from melodic, metric and structural function.
 */
import { MusicTheoryError } from "../errors";
import {
  addInterval,
  formatNote,
  midi,
  mod,
  parseNote,
  pitchClass,
  pitchFromMidi,
  transposeNote,
  type Interval,
  type Note,
  type Pitch,
} from "../theory/pitch";

export type ChordQuality =
  | "major"
  | "minor"
  | "diminished"
  | "augmented"
  | "major7"
  | "dominant7"
  | "minor7"
  | "half-diminished7"
  | "diminished7"
  | "minor-major7";

interface QualityDef {
  readonly suffix: string;
  /** Intervals above the root: third, fifth, optional seventh. */
  readonly above: readonly Interval[];
  /** Extensions and alterations this quality conventionally carries (labels of EXTENSIONS). */
  readonly extensions: readonly string[];
}

const I = (steps: number, semitones: number): Interval => ({ steps, semitones });
const M3 = I(2, 4), m3 = I(2, 3), P5 = I(4, 7), d5 = I(4, 6), A5 = I(4, 8), M7 = I(6, 11), m7 = I(6, 10), d7 = I(6, 9);

export const CHORD_QUALITIES: Readonly<Record<ChordQuality, QualityDef>> = {
  major: { suffix: "", above: [M3, P5], extensions: ["9", "13"] },
  minor: { suffix: "m", above: [m3, P5], extensions: ["9", "11"] },
  diminished: { suffix: "dim", above: [m3, d5], extensions: [] },
  augmented: { suffix: "aug", above: [M3, A5], extensions: [] },
  major7: { suffix: "maj7", above: [M3, P5, M7], extensions: ["9", "#11", "13"] },
  dominant7: { suffix: "7", above: [M3, P5, m7], extensions: ["9", "b9", "#9", "#11", "13", "b13"] },
  minor7: { suffix: "m7", above: [m3, P5, m7], extensions: ["9", "11", "13"] },
  "half-diminished7": { suffix: "m7b5", above: [m3, d5, m7], extensions: ["11", "b13"] },
  "diminished7": { suffix: "dim7", above: [m3, d5, d7], extensions: ["9"] },
  "minor-major7": { suffix: "mMaj7", above: [m3, P5, M7], extensions: ["9", "11"] },
};

export type DegreeRole = "root" | "third" | "fifth" | "seventh" | "ninth" | "eleventh" | "thirteenth";

/** Extension and alteration degrees, as intervals above the root (compound). */
export const EXTENSIONS: Readonly<Record<string, { readonly interval: Interval; readonly role: DegreeRole; readonly kind: "extension" | "alteration" }>> = {
  "9": { interval: I(8, 14), role: "ninth", kind: "extension" },
  b9: { interval: I(8, 13), role: "ninth", kind: "alteration" },
  "#9": { interval: I(8, 15), role: "ninth", kind: "alteration" },
  "11": { interval: I(10, 17), role: "eleventh", kind: "extension" },
  "#11": { interval: I(10, 18), role: "eleventh", kind: "alteration" },
  "13": { interval: I(12, 21), role: "thirteenth", kind: "extension" },
  b13: { interval: I(12, 20), role: "thirteenth", kind: "alteration" },
};

export interface Chord {
  readonly root: Note;
  readonly quality: ChordQuality;
  /** "Dm7", "G7", "Cmaj7". */
  readonly symbol: string;
  /** Chord tones, root first (3 or 4 notes). */
  readonly tones: readonly Note[];
}

export interface ChordDegree {
  /** "1" "3" "5" "7" "9" "b9" "#11" ... */
  readonly label: string;
  readonly role: DegreeRole;
  readonly kind: "chord-tone" | "extension" | "alteration";
  readonly note: Note;
  /** Interval above the root. */
  readonly interval: Interval;
}

export function makeChord(root: Note | string, quality: ChordQuality): Chord {
  const r = typeof root === "string" ? parseNote(root) : root;
  const def = CHORD_QUALITIES[quality];
  const tones = [r, ...def.above.map((iv) => transposeNote(r, iv))];
  return { root: r, quality, symbol: `${formatNote(r)}${def.suffix}`, tones };
}

/** Longest suffix first, so "m7b5" is not read as "m7" followed by junk. */
const SUFFIXES = (Object.entries(CHORD_QUALITIES) as [ChordQuality, QualityDef][])
  .map(([q, d]) => [d.suffix, q] as const)
  .sort((a, b) => b[0].length - a[0].length);

/** "Dm7", "G7", "F#m7b5", "Bbmaj7" → Chord. Throws MusicTheoryError on anything else. */
export function parseChordSymbol(text: string): Chord {
  const m = /^([A-G](?:#|b)*)(.*)$/.exec(text.trim());
  if (!m) throw new MusicTheoryError(`Not a chord symbol: "${text}"`);
  const found = SUFFIXES.find(([suffix]) => suffix === m[2]);
  if (!found) throw new MusicTheoryError(`Unknown chord quality "${m[2]}" in "${text}"`);
  return makeChord(m[1]!, found[1]);
}

const CHORD_TONE_LABELS = ["1", "3", "5", "7"] as const;
const CHORD_TONE_ROLES: readonly DegreeRole[] = ["root", "third", "fifth", "seventh"];

/** The chord's own tones as degrees. */
export function chordToneDegrees(chord: Chord): ChordDegree[] {
  return chord.tones.map((note, i) => ({
    label: CHORD_TONE_LABELS[i]!,
    role: CHORD_TONE_ROLES[i]!,
    kind: "chord-tone" as const,
    note,
    interval: i === 0 ? I(0, 0) : CHORD_QUALITIES[chord.quality].above[i - 1]!,
  }));
}

/** Extensions and alterations this chord conventionally carries. */
export function extensionDegrees(chord: Chord): ChordDegree[] {
  return CHORD_QUALITIES[chord.quality].extensions.map((label) => {
    const e = EXTENSIONS[label]!;
    return { label, role: e.role, kind: e.kind, note: transposeNote(chord.root, e.interval), interval: e.interval };
  });
}

export function chordDegrees(chord: Chord, withExtensions = true): ChordDegree[] {
  return withExtensions ? [...chordToneDegrees(chord), ...extensionDegrees(chord)] : chordToneDegrees(chord);
}

/** One degree by label ("3", "7", "9", "#11" ...). Throws if the chord has no such degree. */
export function degreeOf(chord: Chord, label: string): ChordDegree {
  const direct = chordToneDegrees(chord).find((d) => d.label === label);
  if (direct) return direct;
  const e = EXTENSIONS[label];
  if (!e) throw new MusicTheoryError(`Unknown chord degree "${label}"`);
  return { label, role: e.role, kind: e.kind, note: transposeNote(chord.root, e.interval), interval: e.interval };
}

/** Is this chord able to name that degree (a triad has no "7")? */
export function hasDegree(chord: Chord, label: string): boolean {
  if (label in EXTENSIONS) return true;
  return chordToneDegrees(chord).some((d) => d.label === label);
}

/**
 * What a pitch class is in this chord: a chord tone, a conventional extension/alteration, or
 * nothing ("non-chord", returned as null). Chord tones win, then the chord's own conventional
 * extensions; other tensions are reported separately by `tensionLabel`.
 */
export function classifyPitchClass(chord: Chord, pc: number): ChordDegree | null {
  const p = mod(pc, 12);
  return chordDegrees(chord).find((d) => pitchClass(d.note) === p) ?? null;
}

/**
 * Like `classifyPitchClass`, but a pitch counts as an EXTENSION only when it is spelled the way the
 * chord spells that degree: over G7 an Eb is the b13, a D# is not (it is a neighbour or a #12, a
 * different function). Chord tones are matched by sound, since the generator respells them.
 */
export function classifyPitch(chord: Chord, note: Note): ChordDegree | null {
  const found = classifyPitchClass(chord, pitchClass(note));
  if (!found) return null;
  return found.kind === "chord-tone" || formatNote(found.note) === formatNote(note) ? found : null;
}

/** Any of the seven named extensions/alterations (even unconventional ones) that has this pitch class. */
export function tensionLabel(chord: Chord, pc: number): string | null {
  const p = mod(pc, 12);
  for (const [label, e] of Object.entries(EXTENSIONS)) {
    if (pitchClass(transposeNote(chord.root, e.interval)) === p) return label;
  }
  return null;
}

/** The sounding pitch of a note class nearest to `near` (a MIDI number), spelled as the chord spells it. */
export function nearestPitch(note: Note, near: number): Pitch {
  const base = pitchClass(note);
  const k = Math.round((near - base) / 12);
  return pitchFromMidi(base + 12 * k, note);
}

/** Every pitch of the given degrees in [lo, hi] (MIDI), ascending, spelled as the chord spells them. */
export function chordPitchesIn(chord: Chord, lo: number, hi: number, labels: readonly string[] = ["1", "3", "5", "7"]): Pitch[] {
  const out: Pitch[] = [];
  for (const label of labels) {
    if (!hasDegree(chord, label)) continue;
    const d = degreeOf(chord, label);
    const base = pitchClass(d.note);
    for (let m = base + 12 * Math.ceil((lo - base) / 12); m <= hi; m += 12) out.push(pitchFromMidi(m, d.note));
  }
  return out.sort((a, b) => midi(a) - midi(b));
}

/** Pitch `interval` above `from`, spelled by letter step. Re-exported for the grammar's sake. */
export const above = (from: Pitch, interval: Interval): Pitch => addInterval(from, interval);

/** ii–V–I (or its minor form) in a key: the chords as exact spelled objects. */
export function iiVI(tonic: string, mode: "major" | "minor" = "major"): { chords: Chord[]; romans: string[] } {
  const t = parseNote(tonic);
  const second = transposeNote(t, I(1, 2));
  const fifth = transposeNote(t, I(4, 7));
  return mode === "major"
    ? { chords: [makeChord(second, "minor7"), makeChord(fifth, "dominant7"), makeChord(t, "major7")], romans: ["iim7", "V7", "Imaj7"] }
    : { chords: [makeChord(second, "half-diminished7"), makeChord(fifth, "dominant7"), makeChord(t, "minor7")], romans: ["iiø7", "V7", "im7"] };
}

/** Rebuild a Chord from a document's chord segment; null if its quality is unknown or its tones disagree with the quality. */
export function chordFromSegment(seg: { readonly root: string; readonly quality: string; readonly tones: readonly string[] }): Chord | null {
  try {
    if (!(seg.quality in CHORD_QUALITIES)) return null;
    const chord = makeChord(seg.root, seg.quality as ChordQuality);
    return chord.tones.length === seg.tones.length && chord.tones.every((t, i) => formatNote(t) === seg.tones[i]) ? chord : null;
  } catch {
    return null;
  }
}
