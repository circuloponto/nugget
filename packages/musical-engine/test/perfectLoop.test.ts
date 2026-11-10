import { describe, expect, it } from "vitest";
import {
  buildScale,
  CYCLE_IDS,
  CYCLE_LAP,
  cycleDrift,
  formatNote,
  generateCycle,
  makeFretboard,
  midi,
  pitchClass,
  planPerfectCycleLoop,
  realizeVoicing,
  shiftVoicingOctaves,
  STANDARD_TUNING,
  transitionCost,
  validateVoicing,
  withDefaults,
  type Inversion,
  type PerfectLoopPlan,
  type PlanResult,
} from "../src";

const fb = makeFretboard(STANDARD_TUNING, 22);
const C = withDefaults();
type Ok = Extract<PlanResult, { ok: true }>;

function loopOf(id: number, tonic = "C", type: "major" | "naturalMinor" | "harmonicMinor" = "major", extra = {}) {
  const plan = planPerfectCycleLoop(buildScale(tonic, type), id, fb, extra);
  if (!plan.path.ok) throw new Error(`loop failed (${tonic} ${type} c${id}): ${plan.path.reason}`);
  return { plan, path: plan.path as Ok };
}

const KEYS: [string, "major" | "naturalMinor" | "harmonicMinor"][] = [
  ["C", "major"], ["F#", "major"], ["Db", "major"], ["A", "naturalMinor"], ["A", "harmonicMinor"], ["G#", "harmonicMinor"],
];
const INVERSIONS: Inversion[] = [0, 1, 2];

describe("perfect loop: a whole number of 21-chord laps", () => {
  it("one lap of true voice leading is 21 chords", () => {
    expect(CYCLE_LAP).toBe(21);
  });

  it.each(CYCLE_IDS)("cycle %i: every chord playable, exact and correctly spelled (keys × inversions × start degrees)", (id) => {
    for (const [tonic, type] of KEYS) {
      for (const inversion of INVERSIONS) {
        for (const startDegree of [1, 4]) {
          const { plan, path } = loopOf(id, tonic, type, { inversion, startDegree });
          const ctx = `${tonic} ${type} c${id} inv${inversion} d${startDegree}`;
          expect(path.steps.length % CYCLE_LAP, ctx).toBe(0);
          expect(plan.length, ctx).toBe(path.steps.length);
          path.steps.forEach((s, i) => {
            const theory = plan.cycle[i]!;
            expect(s.voicing.triad.symbol, ctx).toBe(theory.triad.symbol);
            s.voicing.pitches.forEach((p, v) => {
              expect(midi(p) - midi(theory.voicing.pitches[v]!), ctx).toBe(12 * s.octaveShift);
              expect(formatNote(p), ctx).toBe(formatNote(theory.voicing.pitches[v]!));
            });
            expect(validateVoicing(s.guitar.notes, fb, C, s.voicing.pitches), `${ctx} step ${i}`).toEqual([]);
          });
        }
      }
    }
  });

  it("closes perfectly: the chord after the last IS the first (same triad, inversion, spelling), only whole octaves apart", () => {
    for (const id of CYCLE_IDS) {
      for (const [tonic, type] of KEYS) {
        for (const inversion of INVERSIONS) {
          const { plan, path } = loopOf(id, tonic, type, { inversion });
          const ctx = `${tonic} ${type} c${id} inv${inversion}`;
          const scale = buildScale(tonic, type);
          const next = generateCycle(scale, id, { inversion, length: plan.length + 1 })[plan.length]!;
          const first = path.steps[0]!;
          const last = path.steps[path.steps.length - 1]!;
          expect(next.triad.symbol, ctx).toBe(first.voicing.triad.symbol);
          expect(next.inversion, ctx).toBe(first.voicing.inversion);
          // every voice: same note name, and the gap is the same whole number of octaves
          const gaps = first.voicing.pitches.map((p, v) => {
            const n = next.voicing.pitches[v]!;
            expect(formatNote(p), ctx).toBe(formatNote(n));
            expect(pitchClass(p), ctx).toBe(pitchClass(n));
            return midi(p) - (midi(n) + 12 * last.octaveShift);
          });
          expect(new Set(gaps).size, ctx).toBe(1);
          expect(gaps[0]! % 12, ctx).toBe(0);
          expect(gaps[0]! / 12, ctx).toBe(plan.restartJumpOctaves);
        }
      }
    }
  });

  it("the closing move costs what the planner says, and the totals add up", () => {
    for (const id of CYCLE_IDS) {
      const { path } = loopOf(id);
      expect(path.closingCost).toBeDefined();
      const last = path.steps[path.steps.length - 1]!;
      expect(transitionCost(last.guitar, path.steps[0]!.guitar)).toBeCloseTo(path.closingCost!, 9);
      const sum = path.steps.reduce((s, x) => s + x.costFromPrevious, 0);
      expect(sum + path.closingCost!).toBeCloseTo(path.totalCost, 9);
    }
  });

  it("starts at the far end of the neck and ends at the other (top→bottom when descending, bottom→top when ascending)", () => {
    for (const id of CYCLE_IDS) {
      const { plan, path } = loopOf(id);
      if (plan.laps === 0) continue; // a lap that wraps inside itself has no single end-to-end run
      const mean = (i: number) => path.steps[i]!.voicing.pitches.reduce((s, p) => s + midi(p), 0) / 3;
      const lastIdx = path.steps.length - 1;
      if (cycleDrift(id) < 0) expect(mean(0), `cycle ${id}`).toBeGreaterThan(mean(lastIdx));
      else expect(mean(0), `cycle ${id}`).toBeLessThan(mean(lastIdx));
    }
  });

  it("uses as many whole laps as fit: a lap fewer would waste neck, a lap more would need a wrap", () => {
    for (const id of CYCLE_IDS) {
      for (const inversion of INVERSIONS) {
        const { plan, path } = loopOf(id, "C", "major", { inversion });
        if (plan.laps === 0) continue;
        const s0 = path.steps[0]!.octaveShift;
        // no wrap anywhere inside the loop
        expect(path.steps.every((s) => s.octaveShift === s0), `cycle ${id} inv${inversion}`).toBe(true);
        // adding one more lap would not fit at this octave: some chord in it has no room
        const longer = generateCycle(buildScale("C", "major"), id, { inversion, length: plan.length + CYCLE_LAP });
        const someStuck = longer
          .slice(plan.length)
          .some((s) => realizeVoicing(shiftVoicingOctaves(s.voicing, s0), fb, C).length === 0);
        expect(someStuck, `cycle ${id} inv${inversion}: another lap would have fit`).toBe(true);
      }
    }
  });

  it("known lap counts for C major, root position (regression)", () => {
    const laps = Object.fromEntries(CYCLE_IDS.map((id) => [id, loopOf(id).plan.laps]));
    expect(laps).toEqual({ 2: 0, 3: 2, 4: 1, 5: 1, 6: 2, 7: 0 });
    expect(loopOf(3).plan.length).toBe(42);
    expect(loopOf(5).plan.length).toBe(21);
  });

  it("cycles too wide for one lap wrap inside it, only when out of room, and still restart exactly", () => {
    for (const id of [2, 7]) {
      const { plan, path } = loopOf(id);
      expect(plan.laps).toBe(0);
      expect(plan.length).toBe(CYCLE_LAP);
      expect(plan.innerWraps).toBeGreaterThan(0);
      const down = cycleDrift(id) < 0;
      for (const w of path.steps.filter((s) => s.wrapped)) {
        const prevShift = path.steps[w.index - 1]!.octaveShift;
        const here = plan.cycle[w.index]!.voicing;
        expect(realizeVoicing(shiftVoicingOctaves(here, prevShift), fb, C).length, `cycle ${id} step ${w.index}`).toBe(0);
        expect(down ? w.octaveShift > prevShift : w.octaveShift < prevShift).toBe(true);
      }
    }
  });

  it("anchorFret moves the opening chord toward the requested fret, and the loop still closes", () => {
    const free = loopOf(5).path;
    const anchored = loopOf(5, "C", "major", { anchorFret: 5 });
    expect(Math.abs(anchored.path.steps[0]!.guitar.center - 5)).toBeLessThanOrEqual(
      Math.abs(free.steps[0]!.guitar.center - 5),
    );
    expect(anchored.plan.length % CYCLE_LAP).toBe(0);
  });

  it("reports failure when nothing is playable", () => {
    const tiny = makeFretboard(STANDARD_TUNING, 2);
    const plan: PerfectLoopPlan = planPerfectCycleLoop(buildScale("F#", "major"), 5, tiny, {
      constraints: { maxFret: 2 },
    });
    expect(plan.path.ok).toBe(false);
    expect(plan.length).toBe(0);
  });

  it("is deterministic", () => {
    expect(loopOf(6, "Eb", "naturalMinor", { inversion: 2 })).toEqual(loopOf(6, "Eb", "naturalMinor", { inversion: 2 }));
  });
});
