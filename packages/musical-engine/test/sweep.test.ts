import { describe, expect, it } from "vitest";
import {
  buildScale,
  CYCLE_IDS,
  cycleDrift,
  formatNote,
  generateCycle,
  makeFretboard,
  midi,
  planCycleOnGuitar,
  realizeVoicing,
  shiftVoicingOctaves,
  STANDARD_TUNING,
  validateVoicing,
  withDefaults,
  type PlanResult,
} from "../src";

const fb = makeFretboard(STANDARD_TUNING, 22);
const C = withDefaults();
type Ok = Extract<PlanResult, { ok: true }>;

function sweep(id: number, tonic = "C", type: "major" | "naturalMinor" | "harmonicMinor" = "major", length = 90, extra = {}) {
  const plan = planCycleOnGuitar(buildScale(tonic, type), id, fb, { length, octaveShift: "sweep", ...extra });
  if (!plan.path.ok) throw new Error(`sweep failed (${tonic} ${type} c${id}): ${plan.path.reason}`);
  return { plan, path: plan.path as Ok };
}

const KEYS: [string, "major" | "naturalMinor" | "harmonicMinor"][] = [
  ["C", "major"], ["F#", "major"], ["Db", "major"], ["A", "naturalMinor"], ["A", "harmonicMinor"], ["G#", "harmonicMinor"],
];

describe("which way each cycle travels", () => {
  it("cycles 2, 3, 5 descend; cycles 4, 6, 7 ascend", () => {
    for (const id of [2, 3, 5]) expect(cycleDrift(id), `cycle ${id}`).toBeLessThan(0);
    for (const id of [4, 6, 7]) expect(cycleDrift(id), `cycle ${id}`).toBeGreaterThan(0);
  });

  it("agrees with the pitches the cycle actually produces", () => {
    for (const id of CYCLE_IDS) {
      const steps = generateCycle(buildScale("C", "major"), id, { length: 15 });
      const mean = (i: number) => steps[i]!.voicing.pitches.reduce((s, p) => s + midi(p), 0) / 3;
      expect(Math.sign(mean(14) - mean(0)), `cycle ${id}`).toBe(Math.sign(cycleDrift(id)));
    }
  });
});

describe("sweep: run the neck, wrap when out of room", () => {
  it.each(CYCLE_IDS)("cycle %i: every chord is playable, exact, correctly spelled (many keys)", (id) => {
    for (const [tonic, type] of KEYS) {
      const { plan, path } = sweep(id, tonic, type);
      expect(path.steps).toHaveLength(90);
      path.steps.forEach((s, i) => {
        const theory = plan.cycle[i]!;
        const ctx = `${tonic} ${type} c${id} step ${i}`;
        expect(s.voicing.triad.symbol, ctx).toBe(theory.triad.symbol);
        expect(s.voicing.inversion, ctx).toBe(theory.inversion);
        s.voicing.pitches.forEach((p, v) => {
          expect(midi(p) - midi(theory.voicing.pitches[v]!), ctx).toBe(12 * s.octaveShift);
          expect(formatNote(p), ctx).toBe(formatNote(theory.voicing.pitches[v]!));
        });
        expect(validateVoicing(s.guitar.notes, fb, C, s.voicing.pitches), ctx).toEqual([]);
      });
    }
  });

  it("between wraps the real voice leading is untouched (each voice moves exactly as the cycle says)", () => {
    for (const id of CYCLE_IDS) {
      const { plan, path } = sweep(id);
      for (let i = 1; i < path.steps.length; i++) {
        if (path.steps[i]!.wrapped) continue;
        const played = path.steps[i]!.voicing.pitches.map(midi);
        const before = path.steps[i - 1]!.voicing.pitches.map(midi);
        const theory = plan.cycle[i]!.voicing.pitches.map(midi);
        const theoryBefore = plan.cycle[i - 1]!.voicing.pitches.map(midi);
        expect(played.map((m, v) => m - before[v]!), `cycle ${id} step ${i}`).toEqual(
          theory.map((m, v) => m - theoryBefore[v]!),
        );
      }
    }
  });

  it("wraps happen, in the right direction: descending cycles jump up, ascending cycles jump down", () => {
    for (const id of CYCLE_IDS) {
      const { path } = sweep(id);
      const wraps = path.steps.filter((s) => s.wrapped);
      expect(wraps.length, `cycle ${id} should wrap at least once in 90 chords`).toBeGreaterThan(0);
      for (const w of wraps) {
        const before = path.steps[w.index - 1]!.octaveShift;
        if (cycleDrift(id) < 0) expect(w.octaveShift, `cycle ${id}`).toBeGreaterThan(before);
        else expect(w.octaveShift, `cycle ${id}`).toBeLessThan(before);
      }
    }
  });

  it("wraps only when there is genuinely no room, and lands at the far end of the neck", () => {
    for (const id of CYCLE_IDS) {
      const { plan, path } = sweep(id);
      const down = cycleDrift(id) < 0;
      const playableAt = (i: number, k: number) =>
        realizeVoicing(shiftVoicingOctaves(plan.cycle[i]!.voicing, k), fb, C).length > 0;
      for (const w of path.steps.filter((s) => s.wrapped)) {
        // (1) the chord could NOT be played where the run had reached
        expect(playableAt(w.index, path.steps[w.index - 1]!.octaveShift), `cycle ${id} step ${w.index}: had room`).toBe(false);
        // (2) it was placed at the extreme end: no octave further that way works
        for (let d = 1; d <= 8; d++) {
          const further = down ? w.octaveShift + d : w.octaveShift - d;
          expect(playableAt(w.index, further), `cycle ${id} step ${w.index}: could go further`).toBe(false);
        }
      }
    }
  });

  it("the run starts at the far end too: top of the neck when descending, bottom when ascending", () => {
    for (const id of CYCLE_IDS) {
      const { plan, path } = sweep(id);
      const down = cycleDrift(id) < 0;
      const first = path.steps[0]!;
      for (let d = 1; d <= 8; d++) {
        const further = down ? first.octaveShift + d : first.octaveShift - d;
        const ok = realizeVoicing(shiftVoicingOctaves(plan.cycle[0]!.voicing, further), fb, C).length > 0;
        expect(ok, `cycle ${id}: start could be further along`).toBe(false);
      }
    }
  });

  it("does not wrap while the run still fits (cycle 3 drifts slowly: 7 chords need no wrap)", () => {
    const { path } = sweep(3, "C", "major", 7);
    expect(path.steps.some((s) => s.wrapped)).toBe(false);
    expect(new Set(path.steps.map((s) => s.octaveShift)).size).toBe(1);
  });

  it("covers the whole neck: the run reaches the lowest strings before it wraps (descending)", () => {
    const { path } = sweep(5);
    const wrapAt = path.steps.findIndex((s) => s.wrapped);
    expect(wrapAt).toBeGreaterThan(2);
    // chords just before the wrap sit on the lowest string set; chords just after on high strings
    const lowest = (i: number) => Math.min(...path.steps[i]!.guitar.strings);
    expect(lowest(wrapAt - 1)).toBeLessThanOrEqual(1);
    expect(lowest(wrapAt)).toBeGreaterThanOrEqual(2);
    // and over the run the string set really changes (it is not stuck on one string set)
    expect(new Set(path.steps.map((s) => s.guitar.strings.join(","))).size).toBeGreaterThan(2);
  });

  it("the wrapped flag marks exactly the octave changes", () => {
    for (const id of CYCLE_IDS) {
      const { path } = sweep(id);
      path.steps.forEach((s, i) => {
        expect(s.wrapped).toBe(i > 0 && s.octaveShift !== path.steps[i - 1]!.octaveShift);
      });
    }
  });

  it("anchorFret picks the start octave nearest the requested fret", () => {
    const free = sweep(5).path;
    const anchored = sweep(5, "C", "major", 90, { anchorFret: 5 }).path;
    const dist = (p: Ok) => Math.abs(p.steps[0]!.guitar.center - 5);
    expect(dist(anchored)).toBeLessThanOrEqual(dist(free));
    expect(dist(anchored)).toBeLessThanOrEqual(4);
  });

  it("reports failure instead of guessing when nothing is playable", () => {
    const tiny = makeFretboard(STANDARD_TUNING, 2);
    const r = planCycleOnGuitar(buildScale("F#", "major"), 5, tiny, {
      octaveShift: "sweep",
      constraints: { maxFret: 2 },
      length: 7,
    }).path;
    expect(r.ok).toBe(false);
  });

  it("is deterministic", () => {
    expect(sweep(6, "Eb", "naturalMinor", 30)).toEqual(sweep(6, "Eb", "naturalMinor", 30));
  });
});

describe("the wrapped flag in the other policies", () => {
  it("whole-voicing marks octave changes; none never wraps", () => {
    const scale = buildScale("C", "major");
    const fold = planCycleOnGuitar(scale, 7, fb, { length: 14, octaveShift: "whole-voicing" }).path as Ok;
    fold.steps.forEach((s, i) => expect(s.wrapped).toBe(i > 0 && s.octaveShift !== fold.steps[i - 1]!.octaveShift));
    const exact = planCycleOnGuitar(scale, 3, fb, { length: 7, octaveShift: "none" }).path as Ok;
    expect(exact.steps.every((s) => !s.wrapped)).toBe(true);
  });
});
