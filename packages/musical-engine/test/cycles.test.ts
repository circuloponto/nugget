import { describe, expect, it } from "vitest";
import {
  analyzeTriadSteps,
  applyCycleToSteps,
  buildScale,
  CYCLE_IDS,
  CYCLES,
  formatPitch,
  generateCycle,
  getCycle,
  midi,
  MusicTheoryError,
  verifyCycleDefinition,
  type Inversion,
} from "../src";
import { ALL_SCALES, label } from "./helpers";

const symbols = (tonic: string, type: Parameters<typeof buildScale>[1], cycle: number, length = 7) =>
  generateCycle(buildScale(tonic, type), cycle, { length }).map((s) => s.triad.symbol);

describe("cycle definitions (all six diatonic cycles)", () => {
  it("defines exactly cycles 2-7", () => {
    expect([...CYCLE_IDS]).toEqual([2, 3, 4, 5, 6, 7]);
    expect(Object.keys(CYCLES).map(Number)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it.each(CYCLE_IDS)("cycle %i maps every diatonic triad/inversion to the triad N-1 degrees higher", (id) => {
    expect(verifyCycleDefinition(CYCLES[id])).toEqual([]);
    expect(CYCLES[id].rootMotion).toBe(id - 1);
  });

  it("verifyCycleDefinition actually detects a broken table", () => {
    const broken = { ...CYCLES[5], deltas: { root: 1, third: 0, fifth: 0 } };
    expect(verifyCycleDefinition(broken).length).toBeGreaterThan(0);
  });

  it("rejects unknown cycles", () => {
    for (const bad of [0, 1, 8, 2.5, NaN]) expect(() => getCycle(bad)).toThrow(MusicTheoryError);
    expect(() => generateCycle(buildScale("C", "major"), 9)).toThrow(MusicTheoryError);
  });
});

describe("known progressions", () => {
  it("C major, root-position start", () => {
    expect(symbols("C", "major", 2)).toEqual(["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
    expect(symbols("C", "major", 3)).toEqual(["C", "Em", "G", "Bdim", "Dm", "F", "Am"]);
    expect(symbols("C", "major", 4)).toEqual(["C", "F", "Bdim", "Em", "Am", "Dm", "G"]);
    expect(symbols("C", "major", 5)).toEqual(["C", "G", "Dm", "Am", "Em", "Bdim", "F"]);
    expect(symbols("C", "major", 6)).toEqual(["C", "Am", "F", "Dm", "Bdim", "G", "Em"]);
    expect(symbols("C", "major", 7)).toEqual(["C", "Bdim", "Am", "G", "F", "Em", "Dm"]);
  });

  it("C major cycle 5 has exact voice-led pitches", () => {
    const pitches = generateCycle(buildScale("C", "major"), 5).map((s) => s.voicing.pitches.map(formatPitch).join(" "));
    expect(pitches).toEqual([
      "C3 E3 G3", "B2 D3 G3", "A2 D3 F3", "A2 C3 E3", "G2 B2 E3", "F2 B2 D3", "F2 A2 C3",
    ]);
  });

  it("harmonic minor includes the augmented and diminished triads in the right places", () => {
    expect(symbols("A", "harmonicMinor", 5)).toEqual(["Am", "E", "Bdim", "F", "Caug", "G#dim", "Dm"]);
    expect(symbols("A", "harmonicMinor", 3)).toEqual(["Am", "Caug", "E", "G#dim", "Bdim", "Dm", "F"]);
  });

  it("natural minor cycle 5 (A minor)", () => {
    expect(symbols("A", "naturalMinor", 5)).toEqual(["Am", "Em", "Bdim", "F", "C", "G", "Dm"]);
  });

  it("altered spellings flow through the cycle (F# major, Db major, G# harmonic minor)", () => {
    expect(symbols("F#", "major", 5)).toEqual(["F#", "C#", "G#m", "D#m", "A#m", "E#dim", "B"]);
    expect(symbols("Db", "major", 5)).toEqual(["Db", "Ab", "Ebm", "Bbm", "Fm", "Cdim", "Gb"]);
    expect(symbols("G#", "harmonicMinor", 5)).toEqual(["G#m", "D#", "A#dim", "E", "Baug", "F##dim", "C#m"]);
  });
});

describe("cycle invariants over every key, scale type, cycle, start degree and inversion", () => {
  const inversions: Inversion[] = [0, 1, 2];

  it("every step is the diatonic triad whose root is N-1 degrees above the previous", () => {
    for (const scale of ALL_SCALES) {
      for (const id of CYCLE_IDS) {
        for (const startDegree of [1, 2, 3, 4, 5, 6, 7]) {
          for (const inversion of inversions) {
            const steps = generateCycle(scale, id, { startDegree, inversion, length: 8 });
            steps.forEach((s, k) => {
              const expected = ((startDegree - 1 + k * (id - 1)) % 7) + 1;
              expect(s.triad.degree, `${label(scale)} c${id} d${startDegree} i${inversion} k${k}`).toBe(expected);
            });
          }
        }
      }
    }
  });

  it("each step's sounding pitches are exactly its triad's notes", () => {
    for (const scale of ALL_SCALES) {
      for (const id of CYCLE_IDS) {
        for (const s of generateCycle(scale, id, { length: 7 })) {
          const names = s.voicing.pitches.map((p) => `${p.letter}${p.accidental}`).sort();
          const expected = s.triad.notes.map((n) => `${n.letter}${n.accidental}`).sort();
          expect(names, `${label(scale)} c${id} step ${s.index}`).toEqual(expected);
        }
      }
    }
  });

  it("the first seven steps visit all seven diatonic triads exactly once", () => {
    for (const id of CYCLE_IDS) {
      const degrees = generateCycle(buildScale("C", "major"), id).map((s) => s.triad.degree);
      expect([...degrees].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it("triad sequence has period 7; the full voicing (with inversion) has period 21", () => {
    for (const id of CYCLE_IDS) {
      const steps = generateCycle(buildScale("C", "major"), id, { length: 22 });
      for (let k = 0; k < 14; k++) expect(steps[k + 7]!.triad.degree).toBe(steps[k]!.triad.degree);
      // after 7 steps the same triad returns in a different inversion …
      expect(steps[7]!.inversion).not.toBe(steps[0]!.inversion);
      // … and after 21 steps it is the same inversion, shifted by whole octaves.
      expect(steps[21]!.inversion).toBe(steps[0]!.inversion);
      const shift = midi(steps[21]!.voicing.pitches[0]!) - midi(steps[0]!.voicing.pitches[0]!);
      expect(Math.abs(shift) % 12).toBe(0);
      steps[0]!.voicing.pitches.forEach((p, i) =>
        expect(midi(steps[21]!.voicing.pitches[i]!) - midi(p)).toBe(shift),
      );
    }
  });

  it("no voice moves more than two scale steps per step, and voices never cross", () => {
    for (const scale of ALL_SCALES) {
      for (const id of CYCLE_IDS) {
        for (const inversion of inversions) {
          for (const s of generateCycle(scale, id, { inversion, length: 10 })) {
            expect(s.voiceCrossing, `${label(scale)} c${id}`).toBe(false);
            for (const m of s.voiceMotion) expect(Math.abs(m)).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });

  it("is deterministic", () => {
    const s = buildScale("Eb", "harmonicMinor");
    expect(generateCycle(s, 6, { startDegree: 3, inversion: 2 })).toEqual(
      generateCycle(s, 6, { startDegree: 3, inversion: 2 }),
    );
  });
});

describe("applyCycleToSteps / analyzeTriadSteps", () => {
  it("identifies roles regardless of voice order or octave spread", () => {
    expect(analyzeTriadSteps([0, 2, 4])).toEqual({ rootDegree: 1, roles: ["root", "third", "fifth"] });
    expect(analyzeTriadSteps([2, 4, 7])).toEqual({ rootDegree: 1, roles: ["third", "fifth", "root"] });
    expect(analyzeTriadSteps([7, 0 + 4 + 7, 2 + 14])).toEqual({ rootDegree: 1, roles: ["root", "fifth", "third"] });
    expect(analyzeTriadSteps([6, 8, 10])).toEqual({ rootDegree: 7, roles: ["root", "third", "fifth"] });
  });

  it("rejects sets that are not a triad", () => {
    expect(analyzeTriadSteps([0, 1, 2])).toBeNull();
    expect(analyzeTriadSteps([0, 2])).toBeNull();
    expect(analyzeTriadSteps([0, 2, 4, 6])).toBeNull();
    expect(analyzeTriadSteps([0, 7, 14])).toBeNull(); // doubled root only
    expect(() => applyCycleToSteps([0, 1, 2], CYCLES[5])).toThrow(MusicTheoryError);
  });

  it("preserves voice identity: output[i] belongs to input voice i", () => {
    // C E G with cycle 5: root -1, third -1, fifth 0  → B D G
    expect(applyCycleToSteps([0, 2, 4], CYCLES[5])).toEqual([-1, 1, 4]);
    // shuffled voice order keeps its positions
    expect(applyCycleToSteps([4, 0, 2], CYCLES[5])).toEqual([4, -1, 1]);
  });
});
