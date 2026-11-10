import { describe, expect, it } from "vitest";
import {
  approach,
  arpeggiate,
  buildScale,
  CHORD_QUALITIES,
  chordDegrees,
  chordPitchesIn,
  chromaticStep,
  classifyPitchClass,
  connect,
  degreeOf,
  formatNote,
  formatPitch,
  guideToneLine,
  hasDegree,
  iiVI,
  invert,
  makeChord,
  midi,
  MusicTheoryError,
  parseChordSymbol,
  parsePitch,
  pitchClass,
  stepInScale,
  surround,
  transpose,
  tensionLabel,
  type ChordQuality,
} from "../src";
import { ALL_TONICS } from "./helpers";

const names = (c: ReturnType<typeof makeChord>) => c.tones.map(formatNote).join(" ");
const P = (s: string) => parsePitch(s);
const fp = (ps: readonly { letter: string; accidental: number; octave: number }[]) => ps.map((p) => formatPitch(p as never)).join(" ");

describe("chords: spelling of seventh chords", () => {
  it.each([
    ["Dm7", "D F A C"],
    ["G7", "G B D F"],
    ["Cmaj7", "C E G B"],
    ["Bm7b5", "B D F A"],
    ["F#7", "F# A# C# E"],
    ["Bb7", "Bb D F Ab"],
    ["Ebmaj7", "Eb G Bb D"],
    ["C#m7", "C# E G# B"],
    ["Bdim7", "B D F Ab"],
    ["CmMaj7", "C Eb G B"],
    ["Fmaj7", "F A C E"],
    ["Gbmaj7", "Gb Bb Db F"],
  ])("%s is spelled %s", (symbol, expected) => {
    const c = parseChordSymbol(symbol);
    expect(c.symbol).toBe(symbol);
    expect(names(c)).toBe(expected);
  });

  it("every quality on every tonic has the right semitones and one letter per tone", () => {
    const semis: Record<ChordQuality, number[]> = {
      major: [0, 4, 7],
      minor: [0, 3, 7],
      diminished: [0, 3, 6],
      augmented: [0, 4, 8],
      major7: [0, 4, 7, 11],
      dominant7: [0, 4, 7, 10],
      minor7: [0, 3, 7, 10],
      "half-diminished7": [0, 3, 6, 10],
      diminished7: [0, 3, 6, 9],
      "minor-major7": [0, 3, 7, 11],
    };
    for (const tonic of ALL_TONICS) {
      for (const q of Object.keys(CHORD_QUALITIES) as ChordQuality[]) {
        const c = makeChord(tonic, q);
        const root = pitchClass(c.tones[0]!);
        expect(c.tones.map((t) => (pitchClass(t) - root + 12) % 12), `${tonic} ${q}`).toEqual(semis[q]);
        expect(new Set(c.tones.map((t) => t.letter)).size, `${tonic} ${q} letters`).toBe(c.tones.length);
      }
    }
  });

  it("round-trips symbols and rejects nonsense", () => {
    for (const q of Object.keys(CHORD_QUALITIES) as ChordQuality[]) {
      const c = makeChord("Ab", q);
      expect(parseChordSymbol(c.symbol)).toEqual(c);
    }
    expect(() => parseChordSymbol("H7")).toThrow(MusicTheoryError);
    expect(() => parseChordSymbol("Cwhat")).toThrow(MusicTheoryError);
  });
});

describe("chords: extensions, alterations, and what a pitch class is", () => {
  it("names the 9th, #11th and 13th of Cmaj7 and the altered tensions of G7", () => {
    const cmaj7 = parseChordSymbol("Cmaj7");
    expect(formatNote(degreeOf(cmaj7, "9").note)).toBe("D");
    expect(formatNote(degreeOf(cmaj7, "#11").note)).toBe("F#");
    expect(formatNote(degreeOf(cmaj7, "13").note)).toBe("A");
    const g7 = parseChordSymbol("G7");
    expect(["b9", "#9", "#11", "13", "b13"].map((d) => formatNote(degreeOf(g7, d).note)).join(" ")).toBe("Ab A# C# E Eb");
  });

  it("a note keeps its harmonic degree separate from everything else: D over Cmaj7 is the ninth, an extension", () => {
    const cmaj7 = parseChordSymbol("Cmaj7");
    const d = classifyPitchClass(cmaj7, 2)!;
    expect(d).toMatchObject({ label: "9", role: "ninth", kind: "extension" });
    expect(classifyPitchClass(cmaj7, 6)).toMatchObject({ label: "#11", kind: "alteration" });
    expect(classifyPitchClass(cmaj7, 4)).toMatchObject({ role: "third", kind: "chord-tone" });
    // the natural 11th (F) clashes with the third of a major seventh and is not offered as an extension
    expect(classifyPitchClass(cmaj7, 5)).toBeNull();
    expect(tensionLabel(cmaj7, 5)).toBe("11");
  });

  it("a triad has no seventh, and unknown degrees are rejected", () => {
    const c = makeChord("C", "major");
    expect(hasDegree(c, "7")).toBe(false);
    expect(hasDegree(c, "9")).toBe(true);
    expect(() => degreeOf(c, "7")).toThrow(MusicTheoryError);
    expect(() => degreeOf(c, "b2")).toThrow(MusicTheoryError);
    expect(chordDegrees(c, false)).toHaveLength(3);
  });

  it("lists chord pitches in a register, spelled as the chord spells them", () => {
    const g7 = parseChordSymbol("G7");
    expect(fp(chordPitchesIn(g7, 55, 71))).toBe("G3 B3 D4 F4 G4 B4");
    const cm = parseChordSymbol("Cm7");
    expect(fp(chordPitchesIn(cm, 60, 72, ["3"]))).toBe("Eb4");
  });

  it("ii–V–I in any major key has correct roots and qualities", () => {
    for (const tonic of ALL_TONICS) {
      const { chords, romans } = iiVI(tonic);
      const t = pitchClass(makeChord(tonic, "major").tones[0]!);
      expect(chords.map((c) => (pitchClass(c.tones[0]!) - t + 12) % 12)).toEqual([2, 7, 0]);
      expect(chords.map((c) => c.quality)).toEqual(["minor7", "dominant7", "major7"]);
      expect(romans).toEqual(["iim7", "V7", "Imaj7"]);
    }
    expect(iiVI("A", "minor").chords.map((c) => c.symbol)).toEqual(["Bm7b5", "E7", "Am7"]);
  });
});

describe("operations: chromatic neighbours are spelled the way tonal music spells them", () => {
  it.each([
    ["E4", 1, "F4"],
    ["E4", -1, "D#4"],
    ["F#4", 1, "G4"],
    ["F#4", -1, "F4"],
    ["C4", -1, "B3"],
    ["C4", 1, "Db4"],
    ["D4", 1, "Eb4"],
    ["D4", -1, "C#4"],
    ["Bb3", -1, "A3"],
    ["G4", 1, "Ab4"],
  ] as const)("%s %s semitone → %s", (from, dir, expected) => {
    expect(formatPitch(chromaticStep(P(from), dir))).toBe(expected);
  });

  it("always moves exactly one semitone", () => {
    for (let m = 40; m < 90; m++) {
      for (const t of ["C", "C#", "Db", "D", "Eb", "E", "F", "F#", "Gb", "G", "Ab", "A", "Bb", "B"]) {
        const p = parsePitch(`${t}${Math.floor(m / 12) - 1}`);
        expect(midi(chromaticStep(p, 1)) - midi(p)).toBe(1);
        expect(midi(chromaticStep(p, -1)) - midi(p)).toBe(-1);
      }
    }
  });
});

describe("operations: the fundamental movements", () => {
  const space = { scale: buildScale("C", "major").notes };

  it("steps through a scale from a pitch that is not in it", () => {
    expect(formatPitch(stepInScale(P("D#4"), 1, space))).toBe("E4");
    expect(formatPitch(stepInScale(P("D#4"), -1, space))).toBe("D4");
    expect(formatPitch(stepInScale(P("B4"), 1, space))).toBe("C5");
  });

  it("surround builds the chromatic enclosure of E from either side (F and D#), and a diatonic one (F and D)", () => {
    const e = P("E4");
    expect(fp(surround(e, { first: "above", upper: "chromatic", lower: "chromatic" }).pitches)).toBe("F4 D#4");
    expect(fp(surround(e, { first: "below", upper: "chromatic", lower: "chromatic" }).pitches)).toBe("D#4 F4");
    expect(fp(surround(e, { first: "above", upper: "diatonic", lower: "diatonic", space }).pitches)).toBe("F4 D4");
    expect(surround(e, { first: "above", upper: "chromatic", lower: "chromatic" }).description).toEqual({ op: "surround", params: { first: "above", upper: "chromatic", lower: "chromatic" } });
  });

  it("approach leads into the target from one side, ending next to it", () => {
    expect(fp(approach(P("E4"), { from: "below", kind: "chromatic", count: 2 }).pitches)).toBe("D4 D#4");
    expect(fp(approach(P("E4"), { from: "above", kind: "chromatic" }).pitches)).toBe("F4");
    expect(fp(approach(P("E4"), { from: "below", kind: "diatonic", count: 2, space }).pitches)).toBe("C4 D4");
  });

  it("connect fills the gap diatonically, chromatically, or with chord tones", () => {
    expect(fp(connect(P("C4"), P("G4"), "diatonic", { space }).pitches)).toBe("D4 E4 F4");
    expect(connect(P("C4"), P("G4"), "chromatic").pitches.map(midi)).toEqual([61, 62, 63, 64, 65, 66]);
    expect(fp(connect(P("C4"), P("C5"), "chord-tones", { chord: parseChordSymbol("Cmaj7") }).pitches)).toBe("E4 G4 B4");
    expect(fp(connect(P("G4"), P("C4"), "diatonic", { space }).pitches)).toBe("F4 E4 D4");
    expect(() => connect(P("C4"), P("G4"), "chord-tones")).toThrow(MusicTheoryError);
  });

  it("transposes and inverts with spelling preserved", () => {
    expect(fp(transpose([P("E4"), P("G4")], { steps: 2, semitones: 4 }).pitches)).toBe("G#4 B4");
    expect(fp(invert([P("E4"), P("G4")], P("E4")).pitches)).toBe("E4 C#4");
    expect(fp(invert([P("E4"), P("B4")], P("E4")).pitches)).toBe("E4 A3");
  });

  it("arpeggiates a chord from its tones: up, down, bouncing and mixed", () => {
    const g7 = parseChordSymbol("G7");
    const up = arpeggiate(g7, { direction: "up", count: 4, range: [55, 79], startIndex: 0 });
    expect(fp(up.pitches)).toBe("G3 B3 D4 F4");
    const down = arpeggiate(g7, { direction: "down", count: 4, range: [55, 79] });
    expect(fp(down.pitches)).toBe("G5 F5 D5 B4");
    const bounce = arpeggiate(g7, { direction: "updown", count: 7, range: [55, 65], startIndex: 0 });
    expect(bounce.pitches.map(midi)).toEqual([55, 59, 62, 65, 62, 59, 55]);
    const mixed = arpeggiate(g7, { direction: "mixed", count: 5, range: [55, 79], startIndex: 0 });
    expect(fp(mixed.pitches)).toBe("G3 B3 D4 B3 D4");
    expect(up.description).toEqual({ op: "arpeggiate", params: { chord: "G7", direction: "up", count: 4 } });
  });

  it("builds a guide-tone line: thirds and sevenths joined by step (F–F–E through ii–V–I)", () => {
    const { chords } = iiVI("C");
    expect(fp(guideToneLine(chords, { near: 65 }).pitches)).toBe("F4 F4 E4");
    // the same logic in another key: Dm7 G7 Cmaj7 transposed to Eb → Fm7 Bb7 Ebmaj7: Ab Ab G
    expect(fp(guideToneLine(iiVI("Eb").chords, { near: 68 }).pitches)).toBe("Ab4 Ab4 G4");
  });
});
