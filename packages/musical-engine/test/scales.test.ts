import { describe, expect, it } from "vitest";
import {
  buildScale,
  degreeNote,
  formatNote,
  formatPitch,
  isScaleType,
  midi,
  MusicTheoryError,
  pitchAtStep,
  pitchClass,
  SCALE_TYPES,
  spellMidiInScale,
} from "../src";
import { ALL_SCALES, label, scaleNames } from "./helpers";

describe("major scales", () => {
  it.each([
    ["C", "C D E F G A B"],
    ["G", "G A B C D E F#"],
    ["F", "F G A Bb C D E"],
    ["D", "D E F# G A B C#"],
    ["Bb", "Bb C D Eb F G A"],
    ["F#", "F# G# A# B C# D# E#"], // E# not F
    ["Db", "Db Eb F Gb Ab Bb C"],
    ["C#", "C# D# E# F# G# A# B#"],
    ["Cb", "Cb Db Eb Fb Gb Ab Bb"],
    ["G#", "G# A# B# C# D# E# F##"], // double sharp
  ])("%s major = %s", (tonic, expected) => {
    expect(scaleNames(tonic, "major").join(" ")).toBe(expected);
  });
});

describe("natural minor scales", () => {
  it.each([
    ["A", "A B C D E F G"],
    ["E", "E F# G A B C D"],
    ["C", "C D Eb F G Ab Bb"],
    ["F#", "F# G# A B C# D E"],
    ["Eb", "Eb F Gb Ab Bb Cb Db"], // Cb
    ["D#", "D# E# F# G# A# B C#"],
    ["G#", "G# A# B C# D# E F#"],
    ["Bb", "Bb C Db Eb F Gb Ab"],
  ])("%s natural minor = %s", (tonic, expected) => {
    expect(scaleNames(tonic, "naturalMinor").join(" ")).toBe(expected);
  });
});

describe("harmonic minor scales", () => {
  it.each([
    ["A", "A B C D E F G#"],
    ["C", "C D Eb F G Ab B"],
    ["G", "G A Bb C D Eb F#"],
    ["E", "E F# G A B C D#"],
    ["Bb", "Bb C Db Eb F Gb A"],
    ["G#", "G# A# B C# D# E F##"], // raised 7th of G# is F##
    ["D#", "D# E# F# G# A# B C##"],
    ["F#", "F# G# A B C# D E#"],
    ["Eb", "Eb F Gb Ab Bb Cb D"],
  ])("%s harmonic minor = %s", (tonic, expected) => {
    expect(scaleNames(tonic, "harmonicMinor").join(" ")).toBe(expected);
  });

  it("differs from natural minor only in the 7th degree, by one semitone", () => {
    for (const t of ["A", "C", "F#", "Bb", "G#", "Eb"]) {
      const nat = buildScale(t, "naturalMinor");
      const har = buildScale(t, "harmonicMinor");
      for (let d = 1; d <= 7; d++) {
        const diff = pitchClass(degreeNote(har, d)) - pitchClass(degreeNote(nat, d));
        const wrapped = ((diff % 12) + 12) % 12;
        expect(wrapped).toBe(d === 7 ? 1 : 0);
      }
    }
  });
});

describe("spelling invariants across every key (21 tonics × 3 scale types)", () => {
  it.each(ALL_SCALES.map((s) => [label(s), s] as const))("%s uses each letter exactly once", (_n, scale) => {
    const letters = scale.notes.map((n) => n.letter);
    expect(new Set(letters).size).toBe(7);
    // letters follow the alphabet starting from the tonic
    const order = "CDEFGAB";
    const start = order.indexOf(scale.tonic.letter);
    letters.forEach((l, i) => expect(l).toBe(order[(start + i) % 7]));
  });

  it.each(ALL_SCALES.map((s) => [label(s), s] as const))("%s never needs more than a double accidental", (_n, scale) => {
    for (const n of scale.notes) expect(Math.abs(n.accidental)).toBeLessThanOrEqual(2);
  });

  it("has the right interval pattern in semitones for every key", () => {
    const expected: Record<string, number[]> = {
      major: [0, 2, 4, 5, 7, 9, 11],
      naturalMinor: [0, 2, 3, 5, 7, 8, 10],
      harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    };
    for (const s of ALL_SCALES) {
      const tonicPc = pitchClass(s.tonic);
      const actual = s.notes.map((n) => (pitchClass(n) - tonicPc + 12) % 12);
      expect(actual, label(s)).toEqual(expected[s.type]);
    }
  });
});

describe("pitch at absolute scale step", () => {
  it("places octave numbers correctly across the letter C boundary", () => {
    const a = buildScale("A", "major");
    const names = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => formatPitch(pitchAtStep(a, s, 3)));
    expect(names).toEqual(["A3", "B3", "C#4", "D4", "E4", "F#4", "G#4", "A4"]);
  });

  it("supports negative steps and compound steps", () => {
    const c = buildScale("C", "major");
    expect(formatPitch(pitchAtStep(c, -1, 4))).toBe("B3");
    expect(formatPitch(pitchAtStep(c, -7, 4))).toBe("C3");
    expect(formatPitch(pitchAtStep(c, 15, 3))).toBe("D5");
  });

  it("is spelled by the scale: harmonic-minor 7th is G#, not Ab", () => {
    const s = buildScale("A", "harmonicMinor");
    // A3 B3 C4 D4 E4 F4 G#4: the octave number rolls over at C.
    expect(formatPitch(pitchAtStep(s, 6, 3))).toBe("G#4");
    expect(midi(pitchAtStep(s, 6, 3))).toBe(68);
  });
});

describe("spelling a MIDI number in a scale", () => {
  it("uses the scale's note names", () => {
    expect(formatPitch(spellMidiInScale(buildScale("Db", "major"), 66)!)).toBe("Gb4");
    expect(formatPitch(spellMidiInScale(buildScale("F#", "major"), 66)!)).toBe("F#4");
    expect(formatPitch(spellMidiInScale(buildScale("F#", "major"), 65)!)).toBe("E#4");
    expect(formatPitch(spellMidiInScale(buildScale("A", "harmonicMinor"), 56)!)).toBe("G#3");
  });
  it("returns undefined for notes outside the scale, and round-trips every scale tone", () => {
    expect(spellMidiInScale(buildScale("C", "major"), 61)).toBeUndefined();
    for (const s of ALL_SCALES) {
      for (let step = -7; step <= 14; step++) {
        const p = pitchAtStep(s, step, 3);
        expect(spellMidiInScale(s, midi(p)), label(s)).toEqual(p);
      }
    }
  });
});

describe("validation", () => {
  it("recognises scale types and rejects unknown ones", () => {
    for (const t of SCALE_TYPES) expect(isScaleType(t)).toBe(true);
    expect(isScaleType("dorian")).toBe(false);
    expect(isScaleType("toString")).toBe(false); // prototype keys must not pass
    expect(() => buildScale("C", "dorian" as never)).toThrow(MusicTheoryError);
  });
  it("rejects invalid degrees", () => {
    const s = buildScale("C", "major");
    for (const d of [0, 8, 1.5, -1]) expect(() => degreeNote(s, d)).toThrow(MusicTheoryError);
    expect(formatNote(degreeNote(s, 7))).toBe("B");
  });
});
