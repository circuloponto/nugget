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

describe("perfect loop: the cycle continues, wraps when out of room, and closes on the first triad", () => {
  it("one lap of true voice leading is 21 chords", () => {
    expect(CYCLE_LAP).toBe(21);
  });

  it.each(CYCLE_IDS)("cycle %i closes for every key × inversion × start degree, with every chord playable, exact and spelled right", (id) => {
    for (const [tonic, type] of KEYS) {
      for (const inversion of INVERSIONS) {
        for (const startDegree of [1, 4]) {
          const { plan, path } = loopOf(id, tonic, type, { inversion, startDegree });
          const ctx = `${tonic} ${type} c${id} inv${inversion} d${startDegree}`;
          expect(path.steps.length % CYCLE_LAP, ctx).toBe(0);
          expect(plan.length, ctx).toBe(path.steps.length);
          expect(plan.laps, ctx).toBe(plan.length / CYCLE_LAP);
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

  it("the triad after the last chord IS the first one: same triad, inversion and spelling, in the same place", () => {
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
          const gaps = first.voicing.pitches.map((p, v) => {
            const n = next.voicing.pitches[v]!;
            expect(formatNote(p), ctx).toBe(formatNote(n));
            expect(pitchClass(p), ctx).toBe(pitchClass(n));
            return midi(p) - (midi(n) + 12 * last.octaveShift);
          });
          expect(new Set(gaps).size, ctx).toBe(1); // all voices move together
          expect(Math.abs(gaps[0]!) % 12, ctx).toBe(0); // by whole octaves only
          expect(gaps[0]! / 12, ctx).toBe(plan.restartJumpOctaves);
        }
      }
    }
  });

  it("the restart is either plain continuation, or a wrap that was forced because the next chord had no room", () => {
    let continuation = 0;
    let wrapLanding = 0;
    for (const id of CYCLE_IDS) {
      for (const [tonic, type] of KEYS) {
        for (const inversion of INVERSIONS) {
          const { plan, path } = loopOf(id, tonic, type, { inversion });
          const ctx = `${tonic} ${type} c${id} inv${inversion}`;
          const last = path.steps[path.steps.length - 1]!;
          const nextTheory = generateCycle(buildScale(tonic, type), id, { inversion, length: plan.length + 1 })[plan.length]!;
          const playableWhereItIs =
            realizeVoicing(shiftVoicingOctaves(nextTheory.voicing, last.octaveShift), fb, C).length > 0;
          if (plan.restartJumpOctaves === 0) {
            // the true next chord, at the octave the run is in, IS the first chord: nothing to jump
            continuation++;
            expect(playableWhereItIs, ctx).toBe(true);
          } else {
            // the run had to wrap, and the wrap lands exactly on the first triad
            wrapLanding++;
            expect(playableWhereItIs, `${ctx}: wrapped although there was room`).toBe(false);
          }
        }
      }
    }
    // both kinds of closure occur, and between them they cover every case
    expect(continuation).toBeGreaterThan(0);
    expect(wrapLanding).toBeGreaterThan(0);
    expect(continuation + wrapLanding).toBe(CYCLE_IDS.length * KEYS.length * INVERSIONS.length);
  });

  it("between wraps the real voice leading is untouched: each voice moves exactly as the cycle says", () => {
    for (const id of CYCLE_IDS) {
      const { plan, path } = loopOf(id);
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

  it("every cycle wraps at least once per loop, and only ever when the chord has no room", () => {
    for (const id of CYCLE_IDS) {
      for (const inversion of INVERSIONS) {
        const { plan, path } = loopOf(id, "C", "major", { inversion });
        expect(plan.wraps, `cycle ${id} inv${inversion}`).toBeGreaterThan(0);
        const down = cycleDrift(id) < 0;
        for (const w of path.steps.filter((s) => s.wrapped)) {
          const prevShift = path.steps[w.index - 1]!.octaveShift;
          const here = plan.cycle[w.index]!.voicing;
          // (1) the chord could not be played where the run had reached
          expect(
            realizeVoicing(shiftVoicingOctaves(here, prevShift), fb, C).length,
            `cycle ${id} inv${inversion} step ${w.index}: had room`,
          ).toBe(0);
          // (2) it went back to the far end: up for descending cycles, down for ascending ones
          expect(down ? w.octaveShift > prevShift : w.octaveShift < prevShift).toBe(true);
        }
      }
    }
  });

  it("starts at the far end of the neck (at most one octave from the very top/bottom)", () => {
    for (const id of CYCLE_IDS) {
      for (const [tonic, type] of KEYS) {
        for (const inversion of INVERSIONS) {
          const { plan } = loopOf(id, tonic, type, { inversion });
          expect(plan.startOctavesFromEdge, `${tonic} ${type} c${id} inv${inversion}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("known loop shapes for C major, root position (regression)", () => {
    const shape = Object.fromEntries(CYCLE_IDS.map((id) => [id, loopOf(id).plan.length]));
    expect(shape).toEqual({ 2: 21, 3: 42, 4: 21, 5: 21, 6: 42, 7: 21 });
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

  it("anchorFret moves the first chord toward the requested fret, and the loop still closes", () => {
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
