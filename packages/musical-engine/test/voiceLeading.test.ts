import { describe, expect, it } from "vitest";
import {
  buildScale,
  CYCLE_IDS,
  formatNote,
  generateCycle,
  makeFretboard,
  midi,
  pitchClass,
  planCycleOnGuitar,
  planGuitarPath,
  realizeVoicing,
  STANDARD_TUNING,
  transitionCost,
  validateVoicing,
  withDefaults,
  type GuitarVoicing,
  type PlanResult,
  type TriadVoicing,
} from "../src";

const fb = makeFretboard(STANDARD_TUNING, 22);
const C = withDefaults();

function unwrap(r: PlanResult) {
  if (!r.ok) throw new Error(`plan failed: ${r.reason}`);
  return r;
}

const KEYS: [string, "major" | "naturalMinor" | "harmonicMinor"][] = [
  ["C", "major"], ["G", "major"], ["Db", "major"], ["F#", "major"],
  ["A", "naturalMinor"], ["Eb", "naturalMinor"],
  ["A", "harmonicMinor"], ["G#", "harmonicMinor"], ["C", "harmonicMinor"],
];

describe("planning a diatonic cycle on the guitar", () => {
  it.each(CYCLE_IDS)("cycle %i: every step is playable, exact, spelled correctly and valid (all keys)", (id) => {
    for (const [tonic, type] of KEYS) {
      const scale = buildScale(tonic, type);
      const plan = planCycleOnGuitar(scale, id, fb, { length: 7 });
      const path = unwrap(plan.path);
      expect(path.steps).toHaveLength(7);
      path.steps.forEach((step, i) => {
        const theory = plan.cycle[i]!;
        const ctx = `${tonic} ${type} cycle ${id} step ${i}`;
        // the triad is the theoretical one; only whole octaves may differ
        expect(step.voicing.triad.symbol, ctx).toBe(theory.triad.symbol);
        expect(step.voicing.inversion, ctx).toBe(theory.inversion);
        step.voicing.pitches.forEach((p, v) => {
          expect(midi(p) - midi(theory.voicing.pitches[v]!), ctx).toBe(12 * step.octaveShift);
          expect(formatNote(p), ctx).toBe(formatNote(theory.voicing.pitches[v]!));
        });
        // the guitar sounds exactly those pitches, within the physical rules
        expect(validateVoicing(step.guitar.notes, fb, C, step.voicing.pitches), ctx).toEqual([]);
        const names = theory.triad.notes.map(formatNote);
        for (const n of step.guitar.notes) expect(names, ctx).toContain(formatNote(n.pitch));
        expect(new Set(step.guitar.notes.map((n) => pitchClass(n.pitch))).size).toBe(3);
      });
    }
  });

  it("works for long runs of every cycle (21 steps = a full voicing period)", () => {
    for (const id of CYCLE_IDS) {
      const path = unwrap(planCycleOnGuitar(buildScale("C", "major"), id, fb, { length: 21 }).path);
      expect(path.steps).toHaveLength(21);
      expect(Number.isFinite(path.totalCost)).toBe(true);
    }
  });

  it("reports every octave shift it applied, and never shifts when none is needed", () => {
    // Cycle 3 drifts only one scale step per chord, so seven chords fit without any shift.
    const calm = unwrap(planCycleOnGuitar(buildScale("C", "major"), 3, fb, { length: 7, octaveShift: "none" }).path);
    expect(calm.steps.every((s) => s.octaveShift === 0)).toBe(true);

    // Cycle 7 climbs ~3 octaves in 14 steps: it must fold, and say so.
    const wild = unwrap(planCycleOnGuitar(buildScale("C", "major"), 7, fb, { length: 14 }).path);
    expect(wild.steps.some((s) => s.octaveShift !== 0)).toBe(true);
    const top = Math.max(...wild.steps.flatMap((s) => s.guitar.notes.map((n) => n.midi)));
    expect(top).toBeLessThanOrEqual(86);
  });

  it('with octaveShift "none", an unreachable step fails loudly instead of silently changing pitch', () => {
    const r = planCycleOnGuitar(buildScale("C", "major"), 7, fb, { length: 14, octaveShift: "none" }).path;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failedStep).toBeGreaterThan(0);
      expect(r.reason).toMatch(/No playable realization/);
      expect(r.reason).toMatch(/whole-voicing/);
    }
  });

  it("fails (rather than lying) when the constraints make a step impossible", () => {
    const tiny = makeFretboard(STANDARD_TUNING, 3);
    const r = planCycleOnGuitar(buildScale("F#", "major"), 5, tiny, {
      constraints: { maxFret: 3 },
      octaveShift: "none",
      length: 7,
    }).path;
    expect(r.ok).toBe(false);
  });

  it("respects caller constraints in every planned step", () => {
    const constraints = { maxFretSpan: 3, allowOpenStrings: false, maxFret: 12 };
    const plan = planCycleOnGuitar(buildScale("A", "naturalMinor"), 5, fb, { constraints });
    const path = unwrap(plan.path);
    for (const s of path.steps) {
      expect(validateVoicing(s.guitar.notes, fb, withDefaults(constraints), s.voicing.pitches)).toEqual([]);
      expect(s.guitar.span).toBeLessThanOrEqual(3);
      expect(s.guitar.lowestFret).toBeGreaterThan(0);
      expect(s.guitar.highestFret).toBeLessThanOrEqual(12);
    }
  });

  it("is deterministic", () => {
    const a = planCycleOnGuitar(buildScale("Eb", "harmonicMinor"), 6, fb, { startDegree: 2, inversion: 1 });
    const b = planCycleOnGuitar(buildScale("Eb", "harmonicMinor"), 6, fb, { startDegree: 2, inversion: 1 });
    expect(a).toEqual(b);
  });

  it("anchorFret places the opening chord near the requested fret without breaking validity", () => {
    const scale = buildScale("A", "harmonicMinor");
    const free = unwrap(planCycleOnGuitar(scale, 5, fb).path);
    const anchored = unwrap(planCycleOnGuitar(scale, 5, fb, { anchorFret: 5 }).path);
    const dist = (p: typeof free) => Math.abs(p.steps[0]!.guitar.center - 5);
    expect(dist(anchored)).toBeLessThan(dist(free));
    expect(dist(anchored)).toBeLessThanOrEqual(3);
    for (const s of anchored.steps) {
      expect(validateVoicing(s.guitar.notes, fb, C, s.voicing.pitches)).toEqual([]);
    }
    // still the same harmony as the unanchored plan
    expect(anchored.steps.map((s) => s.voicing.triad.symbol)).toEqual(free.steps.map((s) => s.voicing.triad.symbol));
  });

  it("handles an empty sequence", () => {
    expect(planGuitarPath([], fb)).toEqual({ ok: true, steps: [], totalCost: 0 });
  });
});

describe("voice-leading optimality", () => {
  const seq = (cycle: number, length: number): TriadVoicing[] =>
    generateCycle(buildScale("C", "major"), cycle, { length }).map((s) => s.voicing);

  it("total cost equals the true minimum found by exhaustive search", () => {
    for (const id of [3, 5, 6] as const) {
      const sequence = seq(id, 4);
      const candidates = sequence.map((v) => realizeVoicing(v, fb));
      let best = Infinity;
      const walk = (i: number, prev: GuitarVoicing | undefined, cost: number): void => {
        if (i === candidates.length) {
          best = Math.min(best, cost);
          return;
        }
        for (const c of candidates[i]!) walk(i + 1, c, cost + (prev ? transitionCost(prev, c) : 0));
      };
      walk(0, undefined, 0);
      const planned = unwrap(planGuitarPath(sequence, fb, { octaveShift: "none" }));
      expect(planned.totalCost).toBeCloseTo(best, 9);
      // and the reported per-step costs add up to the total
      expect(planned.steps.reduce((s, x) => s + x.costFromPrevious, 0)).toBeCloseTo(planned.totalCost, 9);
    }
  });

  it("is never worse than a greedy nearest-neighbour walk", () => {
    for (const id of CYCLE_IDS) {
      const sequence = seq(id, 7);
      const planned = unwrap(planGuitarPath(sequence, fb));
      // greedy: from the first candidate of step 0, always take the cheapest next move
      const layers = sequence.map((v) => realizeVoicing(v, fb));
      if (layers.some((l) => l.length === 0)) continue; // greedy cannot fold octaves
      let prev = layers[0]![0]!;
      let greedy = 0;
      for (let i = 1; i < layers.length; i++) {
        const next = layers[i]!.reduce((a, b) => (transitionCost(prev, a) <= transitionCost(prev, b) ? a : b));
        greedy += transitionCost(prev, next);
        prev = next;
      }
      expect(planned.totalCost).toBeLessThanOrEqual(greedy + 1e-9);
    }
  });

  it("transition cost is zero for identical voicings and symmetric", () => {
    const v = realizeVoicing(seq(5, 1)[0]!, fb);
    const w = realizeVoicing(seq(5, 2)[1]!, fb);
    expect(transitionCost(v[0]!, v[0]!)).toBe(0);
    expect(transitionCost(v[0]!, w[0]!)).toBeCloseTo(transitionCost(w[0]!, v[0]!), 9);
    expect(transitionCost(v[0]!, w[0]!)).toBeGreaterThan(0);
  });

  it("smoother cycles cost less: cycle 3 (1 step of motion per chord) beats cycle 2 (4 steps)", () => {
    const smooth = unwrap(planCycleOnGuitar(buildScale("C", "major"), 3, fb, { length: 7 }).path);
    const rough = unwrap(planCycleOnGuitar(buildScale("C", "major"), 2, fb, { length: 7 }).path);
    expect(smooth.totalCost).toBeLessThan(rough.totalCost);
  });
});

describe("looping: after the last chord, continue to the first", () => {
  const sumSteps = (p: Extract<PlanResult, { ok: true }>) => p.steps.reduce((s, x) => s + x.costFromPrevious, 0);

  it.each(CYCLE_IDS)("cycle %i: the circuit is playable, valid, and its cost adds up (all keys)", (id) => {
    for (const [tonic, type] of KEYS) {
      const plan = planCycleOnGuitar(buildScale(tonic, type), id, fb, { length: 7, loop: true });
      const path = unwrap(plan.path);
      const ctx = `${tonic} ${type} cycle ${id}`;
      expect(path.closingCost, ctx).toBeDefined();
      expect(Number.isFinite(path.closingCost!), ctx).toBe(true);
      expect(path.closingCost!, ctx).toBeGreaterThanOrEqual(0);
      expect(sumSteps(path) + path.closingCost!, ctx).toBeCloseTo(path.totalCost, 9);
      for (const s of path.steps) {
        expect(validateVoicing(s.guitar.notes, fb, C, s.voicing.pitches), ctx).toEqual([]);
      }
      // the closing move really is last → first
      const last = path.steps[path.steps.length - 1]!;
      expect(transitionCost(last.guitar, path.steps[0]!.guitar), ctx).toBeCloseTo(path.closingCost!, 9);
    }
  });

  it("a non-loop plan has no closing cost", () => {
    const path = unwrap(planCycleOnGuitar(buildScale("C", "major"), 5, fb).path);
    expect(path.closingCost).toBeUndefined();
  });

  it("a circuit is never cheaper than the open path over the same chords", () => {
    for (const id of CYCLE_IDS) {
      const scale = buildScale("A", "harmonicMinor");
      const open = unwrap(planCycleOnGuitar(scale, id, fb, { length: 7 }).path);
      const loop = unwrap(planCycleOnGuitar(scale, id, fb, { length: 7, loop: true }).path);
      expect(loop.totalCost).toBeGreaterThanOrEqual(open.totalCost - 1e-9);
    }
  });

  it("is the true minimum over closed circuits (exhaustive check)", () => {
    for (const id of [3, 5, 6] as const) {
      const sequence = generateCycle(buildScale("C", "major"), id, { length: 3 }).map((s) => s.voicing);
      const cands = sequence.map((v) => realizeVoicing(v, fb));
      let best = Infinity;
      for (const a of cands[0]!) for (const b of cands[1]!) for (const c of cands[2]!) {
        best = Math.min(best, transitionCost(a, b) + transitionCost(b, c) + transitionCost(c, a));
      }
      const planned = unwrap(planGuitarPath(sequence, fb, { octaveShift: "none", loop: true }));
      expect(planned.totalCost).toBeCloseTo(best, 9);
    }
  });

  it("a single-chord loop costs nothing to close", () => {
    const path = unwrap(planCycleOnGuitar(buildScale("G", "major"), 5, fb, { length: 1, loop: true }).path);
    expect(path.closingCost).toBe(0);
  });

  it("wrapping can fold: a fast-drifting cycle still closes onto the neck", () => {
    // Cycle 7 climbs ~1.5 octaves over seven chords; the wrap must pull it back down.
    const path = unwrap(planCycleOnGuitar(buildScale("C", "major"), 7, fb, { length: 7, loop: true }).path);
    const shifts = path.steps.map((s) => s.octaveShift);
    expect(new Set(shifts).size).toBeGreaterThan(1);
    for (const s of path.steps) expect(s.guitar.highestFret).toBeLessThanOrEqual(17);
  });

  it("is deterministic", () => {
    const a = planCycleOnGuitar(buildScale("Eb", "naturalMinor"), 4, fb, { loop: true, anchorFret: 5 });
    const b = planCycleOnGuitar(buildScale("Eb", "naturalMinor"), 4, fb, { loop: true, anchorFret: 5 });
    expect(a).toEqual(b);
  });
});
