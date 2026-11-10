import { buildScale, frac, iiVI, type PhraseSpec, type ProgressionChord } from "../src";

/** Dm7 | G7 | Cmaj7, one bar each. */
export function iiVIProgression(tonic = "C"): ProgressionChord[] {
  const { chords, romans } = iiVI(tonic);
  return chords.map((chord, i) => ({ chord, onset: frac(i), duration: frac(1), roman: romans[i]! }));
}

/** The acceptance experiment: outline G7, enclose the third (E) of Cmaj7, arrive on its downbeat. */
export function acceptanceSpec(over: Partial<PhraseSpec> = {}): PhraseSpec {
  return {
    space: { scale: buildScale("C", "major").notes },
    progression: iiVIProgression("C"),
    start: frac(1),
    target: { chordIndex: 2, degree: "3" },
    outline: { direction: "any", counts: [3, 4] },
    embellishment: { kind: "enclosure", step: "chromatic" },
    hard: { register: [55, 84], maxLeap: 9 },
    candidates: 5,
    ...over,
  };
}

import { chordSegmentOf, formatPitch, MUSIC_IR_VERSION, midi, parseChordSymbol, parseFraction, parsePitch, type MusicIR } from "../src";

/** A hand-written melody over chord symbols, for analysis tests. Times are fraction strings of a whole note. Not validated. */
export function melodyDoc(chords: readonly [symbol: string, onset: string, duration: string][], notes: readonly [name: string, onset: string, duration: string][]): MusicIR {
  return {
    version: MUSIC_IR_VERSION,
    id: "analysis-fixture",
    voices: [{ id: "melody", name: "Melody", role: "melody" }],
    events: notes.map(([name, onset, duration], i) => ({
      id: `m${i + 1}`,
      kind: "note" as const,
      voice: "melody",
      pitch: { name: formatPitch(parsePitch(name)), midi: midi(parsePitch(name)) },
      onset,
      duration,
    })),
    chords: chords.map(([symbol, onset, duration], i) => chordSegmentOf({ chord: parseChordSymbol(symbol), onset: parseFraction(onset), duration: parseFraction(duration) }, i)),
    relations: [],
    constraints: [],
    transformations: [],
  };
}
