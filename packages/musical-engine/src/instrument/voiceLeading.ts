/**
 * Guitar voice leading over a sequence of abstract voicings (e.g. a diatonic
 * cycle). The abstract theory fixes *what* each chord's voices are; this
 * module chooses *where* to play them, minimizing total motion over the whole
 * sequence with dynamic programming (Viterbi), instead of a greedy
 * step-by-step search that can dead-end.
 */
import { formatPitch, midi } from "../theory/pitch";
import { cycleDrift, generateCycle, type CycleStep, type GenerateCycleOptions } from "../theory/cycles";
import { type Scale } from "../theory/scale";
import { shiftVoicingOctaves, type TriadVoicing } from "../theory/voicing";
import { pitchRange, type Fretboard } from "./fretboard";
import { type PlayabilityConstraints } from "./playability";
import { realizeVoicing, type GuitarVoicing } from "./realize";

export interface VoiceLeadingWeights {
  /** Cost per semitone of motion, summed over voices. Default 1. */
  semitone: number;
  /** Cost per fret the fretting hand's center moves. Default 0.5. */
  handShift: number;
  /** Cost per string the lowest string of the voicing moves. Default 0.5. */
  stringShift: number;
}

export const DEFAULT_WEIGHTS: VoiceLeadingWeights = { semitone: 1, handShift: 0.5, stringShift: 0.5 };

/** Cost of moving from one guitar voicing to the next (same voice count). */
export function transitionCost(
  a: GuitarVoicing,
  b: GuitarVoicing,
  weights: Partial<VoiceLeadingWeights> = {},
): number {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  if (a.notes.length !== b.notes.length) return Infinity;
  const pitch = a.notes.reduce((sum, n, i) => sum + Math.abs(n.midi - b.notes[i]!.midi), 0);
  return (
    w.semitone * pitch +
    w.handShift * Math.abs(a.center - b.center) +
    w.stringShift * Math.abs(a.strings[0]! - b.strings[0]!)
  );
}

const meanMidi = (v: TriadVoicing): number => v.pitches.reduce((s, p) => s + midi(p), 0) / v.pitches.length;

export type OctaveShiftPolicy = "none" | "whole-voicing" | "sweep";

export interface PlanOptions {
  /**
   * "none": play the exact pitches; fail if a step is unplayable.
   * "whole-voicing" (default): each step may independently move up/down whole
   * octaves as a unit (spelling and inversion unchanged), chosen to minimize
   * total motion.
   * "sweep": run the cycle's real pitches continuously along the neck. The
   * voicing keeps its octave from chord to chord, so the cycle's own voice
   * leading is what you hear, until a chord has no playable position left. Then
   * the whole voicing wraps to the far end of the neck (the top when descending,
   * the bottom when ascending) and the run continues from there.
   * Every shift is reported in the result; `wrapped` marks the wrap points.
   */
  octaveShift?: OctaveShiftPolicy;
  /**
   * Sweep only: which way the sequence travels. "down" wraps back to the top of
   * the neck when it runs out of strings/frets; "up" wraps back to the bottom.
   * Inferred from the sequence (first vs last chord) when omitted.
   */
  sweepDirection?: "down" | "up";
  /**
   * Optional cap on the whole-octave shift considered per step. By default
   * every shift that fits inside the instrument's pitch range is considered,
   * so a cycle that drifts arbitrarily far can still be folded back.
   */
  maxOctaveShift?: number;
  constraints?: Partial<PlayabilityConstraints>;
  weights?: Partial<VoiceLeadingWeights>;
  /**
   * Where on the neck the first chord should sit (fret number). Without it every
   * opening position costs the same and the planner may start anywhere, e.g. at
   * the 17th fret. With it, the first chord is penalized by `handShift` per fret
   * of distance from the anchor; later steps are still chosen purely by motion.
   */
  anchorFret?: number;
  /**
   * Treat the sequence as a circuit: after the last chord the first plays again.
   * The last→first transition is optimized together with the rest, so the
   * planner may change string set or fold octaves to make the wrap smooth.
   * `closingCost` in the result reports that transition.
   */
  loop?: boolean;
}

export interface PlannedStep {
  readonly index: number;
  /** The abstract voicing actually played (after any octave shift). */
  readonly voicing: TriadVoicing;
  readonly guitar: GuitarVoicing;
  /** Whole octaves this step was moved from its theoretical pitch. */
  readonly octaveShift: number;
  /** True when this step's octave differs from the previous step's (a wrap/fold point). */
  readonly wrapped: boolean;
  readonly costFromPrevious: number;
}

export type PlanResult =
  | {
      readonly ok: true;
      readonly steps: readonly PlannedStep[];
      /** Σ costFromPrevious (+ anchor penalty, + closingCost when looping). */
      readonly totalCost: number;
      /** Loop mode only: cost of moving from the last chord back to the first. */
      readonly closingCost?: number;
    }
  | { readonly ok: false; readonly failedStep: number; readonly reason: string };

interface Candidate {
  voicing: TriadVoicing;
  guitar: GuitarVoicing;
  octaveShift: number;
}

/**
 * Choose one guitar realization per abstract voicing so that total transition
 * cost is globally minimal. Deterministic: ties resolve to the earlier
 * candidate in a fixed enumeration order.
 */
export function planGuitarPath(
  sequence: readonly TriadVoicing[],
  fb: Fretboard,
  options: PlanOptions = {},
): PlanResult {
  const { octaveShift = "whole-voicing", maxOctaveShift = Infinity, constraints = {}, weights = {} } = options;
  if (sequence.length === 0) return { ok: true, steps: [], totalCost: 0 };

  const range = pitchRange(fb);
  /** Whole-octave shifts that keep the voicing inside the instrument's range, nearest first. */
  const shiftsFor = (v: TriadVoicing): number[] => {
    if (octaveShift === "none") return [0];
    const ms = v.pitches.map(midi);
    // `|| 0` normalizes -0 so a reported shift of "no shift" is always +0.
    const lo = Math.ceil((range.lowest - Math.min(...ms)) / 12) || 0;
    const hi = Math.floor((range.highest - Math.max(...ms)) / 12) || 0;
    const out: number[] = [];
    for (let k = lo; k <= hi; k++) if (Math.abs(k) <= maxOctaveShift) out.push(k);
    // always consider "no shift" first so ties keep the theoretical pitch
    return out.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  };

  // Sweep: the octave carries over from chord to chord; it only changes when the
  // next chord has no playable position, and then it jumps to the far end.
  const direction: "down" | "up" =
    options.sweepDirection ??
    (sequence.length > 1 && meanMidi(sequence[sequence.length - 1]!) > meanMidi(sequence[0]!) ? "up" : "down");
  let sweepShift: number | null = null;
  const realized = (v: TriadVoicing, k: number) =>
    realizeVoicing(k === 0 ? v : shiftVoicingOctaves(v, k), fb, constraints);

  const layers: Candidate[][] = [];
  for (let i = 0; i < sequence.length; i++) {
    const layer: Candidate[] = [];
    let shifts: number[];
    if (octaveShift === "sweep") {
      const base = sequence[i]!;
      let pick: number | undefined;
      if (sweepShift !== null && realized(base, sweepShift).length > 0) pick = sweepShift;
      if (pick === undefined) {
        // first chord, or out of room: choose among octaves that are playable at all
        const playable = shiftsFor(base).filter((k) => realized(base, k).length > 0);
        if (playable.length > 0) {
          const edge = direction === "down" ? Math.max(...playable) : Math.min(...playable);
          if (i === 0 && options.anchorFret !== undefined) {
            const dist = (k: number) =>
              Math.min(...realized(base, k).map((g) => Math.abs(g.center - options.anchorFret!)));
            pick = playable.reduce((a, b) => (dist(b) < dist(a) ? b : a), edge);
          } else {
            pick = edge;
          }
        }
      }
      shifts = pick === undefined ? [] : [pick];
      if (pick !== undefined) sweepShift = pick;
    } else {
      shifts = shiftsFor(sequence[i]!);
    }
    for (const shift of shifts) {
      const voicing = shift === 0 ? sequence[i]! : shiftVoicingOctaves(sequence[i]!, shift);
      for (const guitar of realizeVoicing(voicing, fb, constraints)) {
        layer.push({ voicing, guitar, octaveShift: shift });
      }
    }
    if (layer.length === 0) {
      const names = sequence[i]!.pitches.map(formatPitch);
      return {
        ok: false,
        failedStep: i,
        reason:
          `No playable realization for step ${i} (${sequence[i]!.triad.symbol}: ${names.join(" ")}) ` +
          `under the given constraints${octaveShift === "none" ? "; try octaveShift: 'sweep' or 'whole-voicing'" : ""}`,
      };
    }
    layers.push(layer);
  }

  // Viterbi: best[i][c] = cheapest total cost ending at candidate c of step i.
  // Octave-shift jumps are already priced through the semitone-motion term.
  const handShift = { ...DEFAULT_WEIGHTS, ...weights }.handShift;
  const openingCost = (g: GuitarVoicing): number =>
    options.anchorFret === undefined ? 0 : handShift * Math.abs(g.center - options.anchorFret);
  const n = layers.length;
  const cost = (a: Candidate, b: Candidate): number => transitionCost(a.guitar, b.guitar, weights);

  /** One Viterbi pass. `only` pins the first chord to a single candidate (used for loops). */
  const viterbi = (only: number | null) => {
    const best: number[][] = [layers[0]!.map((c, k) => (only === null || only === k ? openingCost(c.guitar) : Infinity))];
    const back: number[][] = [layers[0]!.map(() => -1)];
    for (let i = 1; i < n; i++) {
      const costs: number[] = [];
      const from: number[] = [];
      for (const cand of layers[i]!) {
        let bestCost = Infinity;
        let bestPrev = -1;
        layers[i - 1]!.forEach((prev, p) => {
          const c = best[i - 1]![p]! + cost(prev, cand);
          if (c < bestCost) {
            bestCost = c;
            bestPrev = p;
          }
        });
        costs.push(bestCost);
        from.push(bestPrev);
      }
      best.push(costs);
      back.push(from);
    }
    return { best, back };
  };
  const trace = (back: number[][], end: number): number[] => {
    const path: number[] = new Array(n);
    let idx = end;
    for (let i = n - 1; i >= 0; i--) {
      path[i] = idx;
      idx = back[i]![idx]!;
    }
    return path;
  };

  let chosen: number[] = [];
  let totalCost = Infinity;
  if (!options.loop) {
    const { best, back } = viterbi(null);
    const last = best[n - 1]!;
    const end = last.indexOf(Math.min(...last));
    totalCost = last[end]!;
    chosen = trace(back, end);
  } else {
    // Closed circuit: the last chord must lead back into the first. Try every
    // opening candidate and charge the closing transition, so the whole loop
    // (including any string-set change or octave fold at the wrap) is optimal.
    for (let s = 0; s < layers[0]!.length; s++) {
      const { best, back } = viterbi(s);
      best[n - 1]!.forEach((c, end) => {
        const total = c + cost(layers[n - 1]![end]!, layers[0]![s]!);
        if (total < totalCost) {
          totalCost = total;
          chosen = trace(back, end);
        }
      });
    }
  }
  const closingCost = options.loop ? cost(layers[n - 1]![chosen[n - 1]!]!, layers[0]![chosen[0]!]!) : undefined;

  const steps: PlannedStep[] = chosen.map((c, i) => {
    const cand = layers[i]![c]!;
    const prev = i > 0 ? layers[i - 1]![chosen[i - 1]!]! : undefined;
    return {
      index: i,
      voicing: cand.voicing,
      guitar: cand.guitar,
      octaveShift: cand.octaveShift,
      wrapped: i > 0 && cand.octaveShift !== layers[i - 1]![chosen[i - 1]!]!.octaveShift,
      costFromPrevious: prev ? transitionCost(prev.guitar, cand.guitar, weights) : 0,
    };
  });
  return closingCost === undefined ? { ok: true, steps, totalCost } : { ok: true, steps, totalCost, closingCost };
}

export interface PlayCycleOptions extends GenerateCycleOptions, PlanOptions {}

export interface CyclePlan {
  readonly cycle: readonly CycleStep[];
  readonly path: PlanResult;
}

/** Generate a diatonic cycle and plan its guitar realization in one call. */
export function planCycleOnGuitar(
  scale: Scale,
  cycleId: number,
  fb: Fretboard,
  options: PlayCycleOptions = {},
): CyclePlan {
  const { octaveShift, maxOctaveShift, constraints, weights, anchorFret, loop, sweepDirection, ...cycleOptions } =
    options;
  const cycle = generateCycle(scale, cycleId, cycleOptions);
  const path = planGuitarPath(
    cycle.map((s) => s.voicing),
    fb,
    {
      octaveShift,
      maxOctaveShift,
      constraints,
      weights,
      anchorFret,
      loop,
      // the cycle itself says which way it travels
      sweepDirection: sweepDirection ?? (cycleDrift(cycleId) < 0 ? "down" : "up"),
    },
  );
  return { cycle, path };
}

/** Chords after which a cycle's voicing (triad AND inversion) repeats exactly: 7 triads × 3 inversions. */
export const CYCLE_LAP = 21;

export interface PerfectLoopPlan extends CyclePlan {
  /** Chords in one lap of the cycle's true voice leading (always 21). */
  readonly lapLength: number;
  /** Whole laps played before the loop restarts (0 means the lap needed a wrap inside it). */
  readonly laps: number;
  /** Total chords in the loop (a multiple of 21). */
  readonly length: number;
  /** Wraps to the far end of the neck inside the loop (not counting the restart). */
  readonly innerWraps: number;
  /**
   * Octaves the voicing jumps when the loop restarts: the true next chord would
   * be the first chord moved by this many octaves; it is played at the first
   * chord's position instead. Pitch classes and voice leading are unchanged.
   */
  readonly restartJumpOctaves: number;
}

export type PerfectLoopOptions = Omit<PlayCycleOptions, "length" | "loop" | "octaveShift">;

/**
 * A cycle that loops forever and repeats exactly.
 *
 * The cycle's voicing only repeats after {@link CYCLE_LAP} chords, and by then it has
 * drifted a whole number of octaves. So the loop is a whole number of laps: the run
 * starts at the far end of the neck (top for descending cycles, bottom for ascending
 * ones), travels along the neck at the cycle's real pitches, and when it runs out of
 * room the first chord plays again at its original position, an octave jump that
 * leaves the harmony and voice leading untouched. The lap count is the largest that
 * fits without wrapping mid-run; when even one lap does not fit, the lap wraps
 * inside itself (reported in `innerWraps`) and still restarts exactly.
 */
export function planPerfectCycleLoop(
  scale: Scale,
  cycleId: number,
  fb: Fretboard,
  options: PerfectLoopOptions = {},
): PerfectLoopPlan {
  const { constraints, weights, anchorFret, maxOctaveShift, sweepDirection, ...cycleOptions } = options;
  const direction = sweepDirection ?? (cycleDrift(cycleId) < 0 ? "down" : "up");
  const MAX_LAPS = 8;
  const probe = generateCycle(scale, cycleId, { ...cycleOptions, length: CYCLE_LAP * MAX_LAPS + 1 });
  const base = { constraints, weights, anchorFret, maxOctaveShift, sweepDirection: direction };

  const fail = (path: PlanResult): PerfectLoopPlan => ({
    cycle: probe.slice(0, CYCLE_LAP),
    path,
    lapLength: CYCLE_LAP,
    laps: 0,
    length: 0,
    innerWraps: 0,
    restartJumpOctaves: 0,
  });

  // 1. Run forward from the start and see how far the neck lasts before the first wrap.
  const forward = planGuitarPath(
    probe.slice(0, CYCLE_LAP * MAX_LAPS).map((s) => s.voicing),
    fb,
    { ...base, octaveShift: "sweep" },
  );
  if (!forward.ok) return fail(forward);
  const firstWrap = forward.steps.findIndex((s) => s.wrapped);
  const playableRun = firstWrap < 0 ? forward.steps.length : firstWrap;
  const laps = Math.max(1, Math.floor(playableRun / CYCLE_LAP));
  const length = laps * CYCLE_LAP;

  // 2. Plan exactly that many chords as a closed circuit.
  const cycle = probe.slice(0, length);
  const path = planGuitarPath(
    cycle.map((s) => s.voicing),
    fb,
    { ...base, octaveShift: "sweep", loop: true },
  );
  if (!path.ok) return fail(path);

  // 3. How far does the restart jump? Compare the true next chord with the first.
  const last = path.steps[path.steps.length - 1]!;
  const next = probe[length]!.voicing.pitches[0]!;
  const jump = (midi(path.steps[0]!.voicing.pitches[0]!) - (midi(next) + 12 * last.octaveShift)) / 12;

  return {
    cycle,
    path,
    lapLength: CYCLE_LAP,
    laps: playableRun >= CYCLE_LAP ? laps : 0,
    length,
    innerWraps: path.steps.filter((s) => s.wrapped).length,
    restartJumpOctaves: jump,
  };
}
