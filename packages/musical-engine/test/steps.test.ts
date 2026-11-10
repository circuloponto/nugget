import { describe, expect, it } from "vitest";
import {
  cellFromSteps,
  frac,
  fsum,
  fstr,
  MusicTheoryError,
  parseFraction,
  resamplePattern,
  RHYTHM_GRIDS,
  RHYTHM_PRESETS,
  rotateSteps,
  stepsFromString,
  stepsToString,
  toSampleFrameExact,
  validateCell,
  type Fraction,
  type RhythmCell,
} from "../src";

const f = (s: string): Fraction => parseFraction(s);
const shape = (c: RhythmCell) => c.events.map((e) => `${fstr(e.onset)}+${fstr(e.duration)}${e.rest ? "r" : ""}`);
const total = (c: RhythmCell) => fsum(c.events.map((e) => e.duration));

describe("step patterns", () => {
  it("print and parse round-trip", () => {
    for (const text of ["A---", ".x.x.x.x", "A..x..x.", "AxxxAxxx", "-"]) expect(stepsToString(stepsFromString(text))).toBe(text);
  });

  it("reject empty patterns and unknown characters", () => {
    expect(() => stepsFromString("")).toThrow(MusicTheoryError);
    expect(() => stepsFromString("A.q.")).toThrow(/Unknown step "q"/);
    expect(() => cellFromSteps(f("1"), [])).toThrow(MusicTheoryError);
  });

  it("A..x..x. over a bar is the tresillo, exactly", () => {
    const c = cellFromSteps(f("1"), stepsFromString("A..x..x."));
    expect(shape(c)).toEqual(["0+1/8", "1/8+1/4r", "3/8+1/8", "1/2+1/4r", "3/4+1/8", "7/8+1/8r"]);
    expect(c.events.filter((e) => !e.rest).map((e) => e.accent)).toEqual([3, 1, 1]);
    expect(validateCell(c)).toEqual([]);
  });

  it("ties extend the previous note; a tie with nothing to extend is a rest", () => {
    expect(shape(cellFromSteps(f("1"), stepsFromString("A---")))).toEqual(["0+1"]);
    expect(shape(cellFromSteps(f("1"), stepsFromString("A-x-")))).toEqual(["0+1/2", "1/2+1/2"]);
    expect(shape(cellFromSteps(f("1"), stepsFromString("-x..")))).toEqual(["0+1/4r", "1/4+1/4", "1/2+1/2r"]);
    expect(shape(cellFromSteps(f("1"), stepsFromString("x-.-")))).toEqual(["0+1/2", "1/2+1/2r"]);
  });

  it("scales exactly to any length (a bar, half a bar, three quarters)", () => {
    for (const len of ["1", "1/2", "3/4", "5/8"]) {
      const c = cellFromSteps(f(len), stepsFromString("A..x..x."));
      expect(total(c)).toEqual(f(len));
      expect(validateCell(c)).toEqual([]);
    }
  });

  it("tuplet grids divide the bar exactly: triplets, quintuplets and septuplets", () => {
    expect(shape(cellFromSteps(f("1"), stepsFromString("xxxxxxxxxxxx"))).slice(0, 3)).toEqual(["0+1/12", "1/12+1/12", "1/6+1/12"]);
    const five = cellFromSteps(f("1"), stepsFromString("Axxxx"));
    expect(five.events.map((e) => fstr(e.onset))).toEqual(["0", "1/5", "2/5", "3/5", "4/5"]);
    const seven = cellFromSteps(f("1"), stepsFromString("Axxxxxx"));
    expect(seven.events.map((e) => fstr(e.onset))).toEqual(["0", "1/7", "2/7", "3/7", "4/7", "5/7", "6/7"]);
    for (const c of [five, seven]) expect(total(c)).toEqual(f("1"));
  });

  it("rotation shifts later by whole steps, wraps, and is periodic", () => {
    const steps = stepsFromString("A..x....");
    expect(stepsToString(rotateSteps(steps, 1))).toBe(".A..x...");
    expect(stepsToString(rotateSteps(steps, 3))).toBe("...A..x.");
    expect(stepsToString(rotateSteps(steps, 8))).toBe("A..x....");
    expect(stepsToString(rotateSteps(steps, -1))).toBe("..x....A");
    expect(stepsToString(rotateSteps(rotateSteps(steps, 3), -3))).toBe("A..x....");
    expect(rotateSteps([], 4)).toEqual([]);
  });

  it("resampling to a finer grid keeps every hit on the same beat AND keeps every note's length", () => {
    // a one-step hit on an 8-step grid lasts an eighth: on a 16-step grid that is two steps ("A-")
    expect(stepsToString(resamplePattern(stepsFromString("A.x.x.x."), 16))).toBe("A-..x-..x-..x-..");
    // so the notes sound for exactly as long as before
    const before = cellFromSteps(f("1"), stepsFromString("A.x.x.x."));
    const after = cellFromSteps(f("1"), resamplePattern(stepsFromString("A.x.x.x."), 16));
    const notes = (c: RhythmCell) => c.events.filter((e) => !e.rest).map((e) => `${fstr(e.onset)}+${fstr(e.duration)}`);
    expect(notes(after)).toEqual(notes(before));
    expect(stepsToString(resamplePattern(stepsFromString("A--x...."), 16))).toBe("A-----x-........");
    expect(stepsToString(resamplePattern(stepsFromString("A.x.x.x."), 8))).toBe("A.x.x.x.");
    expect(() => resamplePattern(stepsFromString("A"), 0)).toThrow(MusicTheoryError);
  });
});

describe("presets and grids", () => {
  it("every preset is the right length for its grid and makes a valid cell", () => {
    const ids = new Set<string>();
    for (const p of RHYTHM_PRESETS) {
      expect(ids.has(p.id), `duplicate id ${p.id}`).toBe(false);
      ids.add(p.id);
      expect(p.pattern.length, p.name).toBe(p.grid);
      const c = cellFromSteps(f("1"), stepsFromString(p.pattern));
      expect(validateCell(c), p.name).toEqual([]);
      expect(total(c), p.name).toEqual(f("1"));
      expect(c.events.some((e) => !e.rest), `${p.name} should sound something`).toBe(true);
    }
    expect(RHYTHM_PRESETS.length).toBeGreaterThanOrEqual(10);
  });

  it("every preset's grid is one the editor offers", () => {
    const offered = new Set(RHYTHM_GRIDS.map((g) => g.grid));
    for (const p of RHYTHM_PRESETS) expect(offered.has(p.grid), p.name).toBe(true);
  });
});

describe("exact sample frames", () => {
  const BPM120 = frac(120);

  it("a steady pulse lands on exact multiples forever: 4000 quarter notes at 120 BPM / 44.1 kHz", () => {
    for (const n of [1, 7, 100, 1000, 4000]) {
      expect(toSampleFrameExact(frac(n, 4), BPM120, 44100)).toBe(n * 22050);
    }
  });

  it("three triplets in a beat land on exact thirds, and 5 and 7 against a bar divide it exactly", () => {
    // a bar of 4/4 at 120 BPM is 2 s = 88200 frames
    expect([0, 1, 2].map((i) => toSampleFrameExact(frac(i, 12), BPM120, 44100))).toEqual([0, 7350, 14700]);
    expect([0, 1, 2, 3, 4].map((i) => toSampleFrameExact(frac(i, 5), BPM120, 44100))).toEqual([0, 17640, 35280, 52920, 70560]);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => toSampleFrameExact(frac(i, 7), BPM120, 44100))).toEqual([0, 12600, 25200, 37800, 50400, 63000, 75600]);
  });

  it("works for fractional tempos and other sample rates", () => {
    // 400/3 BPM: a beat is 0.45 s = 19845 frames at 44.1 kHz
    expect(toSampleFrameExact(frac(1, 4), frac(400, 3), 44100)).toBe(19845);
    expect(toSampleFrameExact(frac(1, 12), frac(400, 3), 44100)).toBe(6615);
    expect(toSampleFrameExact(frac(1, 4), BPM120, 48000)).toBe(24000);
    // a different beat unit: eighth-note beats
    expect(toSampleFrameExact(frac(1, 8), frac(120), 44100, frac(1, 8))).toBe(22050);
  });

  it("rounds half up, once", () => {
    expect(toSampleFrameExact(frac(1, 4), BPM120, 3)).toBe(2); // 1.5
    expect(toSampleFrameExact(frac(1, 4), BPM120, 1)).toBe(1); // 0.5
    expect(toSampleFrameExact(frac(1, 8), BPM120, 1)).toBe(0); // 0.25
  });

  it("matches big-integer arithmetic for awkward positions (no float drift)", () => {
    for (let n = 1; n <= 200; n++) {
      const position = frac(n, 7 * 11);
      const bpm = frac(137, 2);
      const exact = (BigInt(n) * 4n * 60n * 44100n * 2n * 2n) / (77n * 137n * 2n); // numerator/denominator, floored below
      const num = BigInt(n) * 4n * 60n * 44100n * 2n;
      const den = 77n * 137n;
      const rounded = (2n * num + den) / (2n * den);
      expect(toSampleFrameExact(position, bpm, 44100), `n=${n}`).toBe(Number(rounded));
      void exact;
    }
  });

  it("rejects impossible input", () => {
    expect(() => toSampleFrameExact(frac(1, 4), frac(0), 44100)).toThrow(MusicTheoryError);
    expect(() => toSampleFrameExact(frac(1, 4), BPM120, 0)).toThrow(MusicTheoryError);
    expect(() => toSampleFrameExact(frac(1, 4), BPM120, 44100.5)).toThrow(MusicTheoryError);
    expect(() => toSampleFrameExact(frac(1, 4), BPM120, 44100, frac(0))).toThrow(MusicTheoryError);
  });
});
