import { describe, expect, it } from "vitest";
import {
  buildScale,
  closeVoicing,
  closeVoicingSteps,
  diatonicTriads,
  formatNote,
  formatPitch,
  intervalBetween,
  inversionOfSteps,
  midi,
  MusicTheoryError,
  pitchClass,
  shiftVoicingOctaves,
  totalSemitoneMotion,
  voicingFromSteps,
  type Inversion,
} from "../src";
import { ALL_SCALES, label } from "./helpers";

const INVERSIONS: Inversion[] = [0, 1, 2];

describe("inversion correctness (abstract theory)", () => {
  it("C major triad: exact pitches for each inversion", () => {
    const c = buildScale("C", "major");
    const show = (inv: Inversion) => closeVoicing(c, 1, inv, 3).pitches.map(formatPitch).join(" ");
    expect(show(0)).toBe("C3 E3 G3");
    expect(show(1)).toBe("E3 G3 C4");
    expect(show(2)).toBe("G3 C4 E4");
  });

  it("the bass voice is root / third / fifth for inversion 0 / 1 / 2, in every key and degree", () => {
    for (const scale of ALL_SCALES) {
      const triads = diatonicTriads(scale);
      for (const triad of triads) {
        for (const inv of INVERSIONS) {
          const v = closeVoicing(scale, triad.degree, inv, 3);
          const bass = formatNote(v.pitches[0]!);
          const expectedBass = [triad.root, triad.third, triad.fifth][inv]!;
          expect(bass, `${label(scale)} ${triad.symbol} inv${inv}`).toBe(formatNote(expectedBass));
          expect(v.inversion).toBe(inv);
          expect(v.triad.symbol).toBe(triad.symbol);
        }
      }
    }
  });

  it("pitches ascend strictly and span less than an octave plus a sixth", () => {
    for (const scale of ALL_SCALES) {
      for (let degree = 1; degree <= 7; degree++) {
        for (const inv of INVERSIONS) {
          const m = closeVoicing(scale, degree, inv, 3).pitches.map(midi);
          expect(m[0]!).toBeLessThan(m[1]!);
          expect(m[1]!).toBeLessThan(m[2]!);
          // close position: top - bottom is a 5th-ish (6..9 semitones for the span of a sixth/fifth family)
          expect(m[2]! - m[0]!).toBeGreaterThanOrEqual(6);
          expect(m[2]! - m[0]!).toBeLessThanOrEqual(9);
        }
      }
    }
  });

  it("close-position intervals are exact: root pos = 3rd+3rd, 1st inv = 3rd+4th, 2nd inv = 4th+3rd (by letter steps)", () => {
    const scale = buildScale("D", "major");
    const steps = (inv: Inversion) => {
      const p = closeVoicing(scale, 1, inv, 3).pitches;
      return [intervalBetween(p[0]!, p[1]!).steps, intervalBetween(p[1]!, p[2]!).steps];
    };
    expect(steps(0)).toEqual([2, 2]);
    expect(steps(1)).toEqual([2, 3]);
    expect(steps(2)).toEqual([3, 2]);
  });

  it("semitone structure matches triad quality in root position", () => {
    const expected = { major: [4, 3], minor: [3, 4], diminished: [3, 3], augmented: [4, 4] };
    for (const scale of ALL_SCALES) {
      for (const triad of diatonicTriads(scale)) {
        const m = closeVoicing(scale, triad.degree, 0, 3).pitches.map(midi);
        expect([m[1]! - m[0]!, m[2]! - m[1]!], `${label(scale)} ${triad.symbol}`).toEqual(expected[triad.quality]);
      }
    }
  });

  it("every inversion contains the same three pitch classes", () => {
    for (const scale of ALL_SCALES) {
      for (const triad of diatonicTriads(scale)) {
        const pcs = new Set(triad.notes.map(pitchClass));
        for (const inv of INVERSIONS) {
          const got = new Set(closeVoicing(scale, triad.degree, inv, 3).pitches.map(pitchClass));
          expect(got).toEqual(pcs);
        }
      }
    }
  });

  it("derives the inversion from the lowest voice for open/spread voicings too", () => {
    // C E G spread as E (bass), C+octave, G → bass is the third → first inversion
    expect(inversionOfSteps([2, 4, 7])).toBe(1);
    expect(inversionOfSteps([0, 4, 9])).toBe(0); // C G E(upper) : root bass
    expect(inversionOfSteps([4, 7, 9])).toBe(2);
    expect(inversionOfSteps([14, 4, 9])).toBe(2); // shuffled input: lowest step 4 is the fifth (G)
    expect(inversionOfSteps([16, 11, 7])).toBe(0); // shuffled input: lowest step 7 is the root (C)
  });

  it("octave shifts keep spelling, steps and inversion consistent", () => {
    const scale = buildScale("F#", "major");
    const v = closeVoicing(scale, 3, 1, 3);
    const up = shiftVoicingOctaves(v, 1);
    expect(up.inversion).toBe(1);
    expect(up.pitches.map(midi)).toEqual(v.pitches.map((p) => midi(p) + 12));
    expect(up.pitches.map((p) => formatNote(p))).toEqual(v.pitches.map((p) => formatNote(p)));
    expect(up.steps).toEqual(v.steps.map((s) => s + 7));
    // rebuilding from the shifted steps gives the identical voicing
    expect(voicingFromSteps(scale, 3, up.steps)).toEqual(up);
  });

  it("totalSemitoneMotion measures voice-by-voice motion", () => {
    const c = buildScale("C", "major");
    const a = closeVoicing(c, 1, 0, 3).pitches; // C3 E3 G3
    const b = closeVoicing(c, 5, 0, 3).pitches; // G3 B3 D4
    expect(totalSemitoneMotion(a, a)).toBe(0);
    expect(totalSemitoneMotion(a, b)).toBe(7 + 7 + 7); // C→G, E→B, G→D
    expect(() => totalSemitoneMotion(a, a.slice(0, 2))).toThrow(MusicTheoryError);
  });

  it("validates its inputs", () => {
    expect(() => closeVoicingSteps(0, 0)).toThrow(MusicTheoryError);
    expect(() => closeVoicingSteps(8, 0)).toThrow(MusicTheoryError);
    expect(() => closeVoicingSteps(1, 3 as Inversion)).toThrow(MusicTheoryError);
    expect(() => inversionOfSteps([0, 1, 2])).toThrow(MusicTheoryError);
    expect(() => voicingFromSteps(buildScale("C", "major"), 3, [0, 1, 2])).toThrow(MusicTheoryError);
  });
});
