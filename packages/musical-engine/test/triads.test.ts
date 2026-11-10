import { describe, expect, it } from "vitest";
import { buildScale, diatonicTriads, formatNote, MusicTheoryError, pitchClass, triadAt } from "../src";
import { ALL_SCALES, label } from "./helpers";

const summary = (tonic: string, type: Parameters<typeof buildScale>[1]) =>
  diatonicTriads(buildScale(tonic, type)).map((t) => `${t.roman}:${t.symbol}`);

describe("diatonic triads", () => {
  it("major: I ii iii IV V vi vii°", () => {
    expect(summary("C", "major")).toEqual([
      "I:C", "ii:Dm", "iii:Em", "IV:F", "V:G", "vi:Am", "vii°:Bdim",
    ]);
  });

  it("natural minor: i ii° III iv v VI VII", () => {
    expect(summary("A", "naturalMinor")).toEqual([
      "i:Am", "ii°:Bdim", "III:C", "iv:Dm", "v:Em", "VI:F", "VII:G",
    ]);
  });

  it("harmonic minor: i ii° III+ iv V VI vii°  (the case the reference could not handle)", () => {
    expect(summary("A", "harmonicMinor")).toEqual([
      "i:Am", "ii°:Bdim", "III+:Caug", "iv:Dm", "V:E", "VI:F", "vii°:G#dim",
    ]);
  });

  it("uses the scale's spelling for chord tones (F# major, G# harmonic minor)", () => {
    const fs = diatonicTriads(buildScale("F#", "major"));
    expect(fs[2]!.symbol).toBe("A#m");
    expect(fs[2]!.notes.map(formatNote)).toEqual(["A#", "C#", "E#"]);
    expect(fs[6]!.symbol).toBe("E#dim");
    expect(fs[6]!.notes.map(formatNote)).toEqual(["E#", "G#", "B"]);

    const gs = diatonicTriads(buildScale("G#", "harmonicMinor"));
    expect(gs[6]!.notes.map(formatNote)).toEqual(["F##", "A#", "C#"]);
    expect(gs[6]!.symbol).toBe("F##dim");
    expect(gs[2]!.notes.map(formatNote)).toEqual(["B", "D#", "F##"]);
    expect(gs[2]!.quality).toBe("augmented");
  });

  it("flat keys: Db major vi is Bbm, Eb natural minor has a Cb major triad", () => {
    expect(diatonicTriads(buildScale("Db", "major"))[5]!.symbol).toBe("Bbm");
    const eb = diatonicTriads(buildScale("Eb", "naturalMinor"));
    expect(eb[5]!.symbol).toBe("Cb");
    expect(eb[5]!.notes.map(formatNote)).toEqual(["Cb", "Eb", "Gb"]);
  });

  it("quality distribution is fixed per scale type, for every key", () => {
    const expected = {
      major: ["major", "minor", "minor", "major", "major", "minor", "diminished"],
      naturalMinor: ["minor", "diminished", "major", "minor", "minor", "major", "major"],
      harmonicMinor: ["minor", "diminished", "augmented", "minor", "major", "major", "diminished"],
    };
    for (const s of ALL_SCALES) {
      expect(diatonicTriads(s).map((t) => t.quality), label(s)).toEqual(expected[s.type]);
    }
  });

  it("chord tones are stacked thirds of the scale in every key", () => {
    for (const s of ALL_SCALES) {
      diatonicTriads(s).forEach((t, i) => {
        expect(t.degree).toBe(i + 1);
        expect(t.root).toEqual(s.notes[i]);
        expect(t.third).toEqual(s.notes[(i + 2) % 7]);
        expect(t.fifth).toEqual(s.notes[(i + 4) % 7]);
        // triad tones are three distinct pitch classes
        expect(new Set(t.notes.map(pitchClass)).size).toBe(3);
      });
    }
  });

  it("rejects an invalid degree", () => {
    const s = buildScale("C", "major");
    expect(() => triadAt(s, 0)).toThrow(MusicTheoryError);
    expect(() => triadAt(s, 8)).toThrow(MusicTheoryError);
  });
});
