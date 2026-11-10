/**
 * Guitar voice leading over a sequence of abstract voicings (e.g. a diatonic
 * cycle). The abstract theory fixes *what* each chord's voices are; this
 * module chooses *where* to play them, minimizing total motion over the whole
 * sequence with dynamic programming (Viterbi), instead of a greedy
 * step-by-step search that can dead-end.
 */
import { MusicTheoryError } from "../errors";
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
   * Force the octave shift of every step (relative to its theoretical pitch),
   * overriding `octaveShift`. Used when the run has already been decided and only
   * the fingerings remain to be chosen.
   */
  octaveShifts?: readonly number[];
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
    if (options.octaveShifts) {
      const forced = options.octaveShifts[i];
      if (forced === undefined) throw new MusicTheoryError(`octaveShifts has no entry for step ${i}`);
      shifts = [forced];
    } else if (octaveShift === "sweep") {
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
  /** Laps in the loop (length / 21). */
  readonly laps: number;
  /** Total chords in the loop; after the last one the first triad comes next, in the same place. */
  readonly length: number;
  /** Times the run wrapped to the far end of the neck inside the loop. */
  readonly wraps: number;
  /** How many octaves below the very top (or above the very bottom) the first chord sits; 0 = at the edge. */
  readonly startOctavesFromEdge: number;
  /**
   * Octaves the voicing jumps when the loop restarts. 0 means the restart is a
   * pure continuation (the true next chord is already the first chord, in place);
   * otherwise the last wrap lands exactly on the first chord.
   */
  readonly restartJumpOctaves: number;
}

export type PerfectLoopOptions = Omit<PlayCycleOptions, "length" | "loop" | "octaveShift">;

/**
 * A cycle that runs the whole neck, wraps as often as it must, and closes on itself.
 *
 * The cycle is played at its real pitches (true voice leading, true next triad). It
 * runs from one end of the neck toward the other, changing string sets on the way.
 * When the next triad has no playable position left, the whole voicing wraps to the
 * far end (top for descending cycles, bottom for ascending) and the run continues.
 * It stops when the triad that follows the last one is the first triad again, in the
 * very place it started, so playing on simply repeats the loop.
 *
 * Wraps only ever happen when there is no room. To make the first triad come back
 * exactly, the search chooses the start position (among the highest placements of the
 * first chord) and, if it must, which high octave a wrap lands in. Among the loops
 * that close, it prefers the highest start, then the highest landings, then the
 * shortest. Every cycle/inversion/start degree/key tried closes, in 21 or 42 chords.
 */
export function planPerfectCycleLoop(
  scale: Scale,
  cycleId: number,
  fb: Fretboard,
  options: PerfectLoopOptions = {},
): PerfectLoopPlan {
  const { constraints, weights, anchorFret, maxOctaveShift, sweepDirection, ...cycleOptions } = options;
  const down = (sweepDirection ?? (cycleDrift(cycleId) < 0 ? "down" : "up")) === "down";

  // One lap of true voice leading (class c = chord index mod 21) and its drift per lap in octaves.
  const gen = generateCycle(scale, cycleId, { ...cycleOptions, length: CYCLE_LAP + 1 });
  const T = gen.slice(0, CYCLE_LAP).map((s) => s.voicing);
  const D = Math.round((midi(gen[CYCLE_LAP]!.voicing.pitches[0]!) - midi(gen[0]!.voicing.pitches[0]!)) / 12) || 0;

  const failure = (failedStep: number, reason: string): PerfectLoopPlan => ({
    cycle: gen.slice(0, CYCLE_LAP),
    path: { ok: false, failedStep, reason },
    lapLength: CYCLE_LAP,
    laps: 0,
    length: 0,
    wraps: 0,
    startOctavesFromEdge: 0,
    restartJumpOctaves: 0,
  });

  // realizations(class, octave): ways to play that chord moved by `octave` octaves from its lap-1 pitch.
  const memo = new Map<number, GuitarVoicing[]>();
  const realizations = (c: number, o: number): GuitarVoicing[] => {
    const k = c * 1000 + o + 500;
    let r = memo.get(k);
    if (!r) {
      r = realizeVoicing(o === 0 ? T[c]! : shiftVoicingOctaves(T[c]!, o), fb, constraints);
      memo.set(k, r);
    }
    return r;
  };
  const ok = (c: number, o: number) => realizations(c, o).length > 0;
  const range = pitchRange(fb);
  const feasible: number[][] = T.map((v, c) => {
    const ms = v.pitches.map(midi);
    const lo = Math.ceil((range.lowest - Math.min(...ms)) / 12) - 1;
    const hi = Math.floor((range.highest - Math.max(...ms)) / 12) + 1;
    const out: number[] = [];
    for (let o = lo; o <= hi; o++) if (Math.abs(o) <= (maxOctaveShift ?? Infinity) + 8 && ok(c, o)) out.push(o);
    return out;
  });
  const dead = feasible.findIndex((f) => f.length === 0);
  if (dead >= 0) {
    return failure(
      dead,
      `No playable realization for chord ${dead} of the lap (${T[dead]!.triad.symbol}: ${T[dead]!.pitches.map(formatPitch).join(" ")}) under the given constraints`,
    );
  }
  const edge = feasible.map((f) => (down ? Math.max(...f) : Math.min(...f)));
  const meanAt = (c: number, o: number) => meanMidi(o === 0 ? T[c]! : shiftVoicingOctaves(T[c]!, o));

  // Candidate starting placements of the first chord, best first.
  const bestCenterDist = (o: number) =>
    anchorFret === undefined ? 0 : Math.min(...realizations(0, o).map((g) => Math.abs(g.center - anchorFret)));
  const starts = [...feasible[0]!].sort(
    (a, b) =>
      bestCenterDist(a) - bestCenterDist(b) || Math.abs(edge[0]! - a) - Math.abs(edge[0]! - b) || (down ? b - a : a - b),
  );

  interface Walk {
    /** Octave chosen at each wrap, in order. */
    landings: number[];
    dev: number;
    length: number;
  }

  /** Cheapest closed walk from the start state, or null. Dijkstra over landing states. */
  const closeFrom = (o0: number): Walk | null => {
    const keyOf = (c: number, o: number) => `${c},${o}`;
    interface Entry {
      c: number;
      o: number;
      dev: number;
      idx: number;
      landings: number[];
    }
    const best = new Map<string, { dev: number; idx: number }>();
    const queue: Entry[] = [{ c: 0, o: o0, dev: 0, idx: 0, landings: [] }];
    best.set(keyOf(0, o0), { dev: 0, idx: 0 });
    let found: Walk | null = null;
    const better = (dev: number, len: number, w: Walk | null) => !w || dev < w.dev || (dev === w.dev && len < w.length);

    while (queue.length) {
      queue.sort((a, b) => a.dev - b.dev || a.idx - b.idx);
      const cur = queue.shift()!;
      if (found && (cur.dev > found.dev || (cur.dev === found.dev && cur.idx >= found.length))) break;
      const seen = best.get(keyOf(cur.c, cur.o))!;
      if (cur.dev > seen.dev || (cur.dev === seen.dev && cur.idx > seen.idx)) continue;

      // Follow the cycle forward at fixed octave until it runs out of room (or returns to the start).
      let c = cur.c;
      let o = cur.o;
      let idx = cur.idx;
      for (let guard = 0; guard < 1000; guard++) {
        const c1 = (c + 1) % CYCLE_LAP;
        const o1 = c === CYCLE_LAP - 1 ? o + D : o; // the next lap sits D octaves away in theory
        if (ok(c1, o1)) {
          c = c1;
          o = o1;
          idx++;
          if (c === 0 && o === o0) {
            if (better(cur.dev, idx, found)) found = { landings: cur.landings, dev: cur.dev, length: idx };
            break;
          }
          continue;
        }
        // No room: wrap. Land on any playable octave that is genuinely back at the far end.
        const here = meanAt(c, o);
        for (const o2 of feasible[c1]!) {
          const there = meanAt(c1, o2);
          if (down ? there <= here : there >= here) continue;
          const dev = cur.dev + Math.abs(edge[c1]! - o2);
          const nidx = idx + 1;
          const landings = [...cur.landings, o2];
          if (c1 === 0 && o2 === o0) {
            if (better(dev, nidx, found)) found = { landings, dev, length: nidx };
            continue;
          }
          const k = keyOf(c1, o2);
          const prev = best.get(k);
          if (!prev || dev < prev.dev || (dev === prev.dev && nidx < prev.idx)) {
            best.set(k, { dev, idx: nidx });
            queue.push({ c: c1, o: o2, dev, idx: nidx, landings });
          }
        }
        break;
      }
    }
    return found;
  };

  let chosenStart: number | null = null;
  let walk: Walk | null = null;
  for (const o0 of starts) {
    walk = closeFrom(o0);
    if (walk) {
      chosenStart = o0;
      break;
    }
  }
  if (!walk || chosenStart === null) {
    return failure(0, "No closed loop found: the cycle cannot return to its first chord under the given constraints");
  }

  // Replay the winning walk to get the octave of every chord in the loop.
  const length = walk.length;
  const octaves: number[] = [chosenStart];
  {
    let c = 0;
    let o = chosenStart;
    let w = 0;
    for (let idx = 1; idx < length; idx++) {
      const c1 = (c + 1) % CYCLE_LAP;
      const o1 = c === CYCLE_LAP - 1 ? o + D : o;
      o = ok(c1, o1) ? o1 : walk.landings[w++]!;
      c = c1;
      octaves.push(o);
    }
  }

  // Convert to shifts relative to each chord's theoretical pitch, then pick the best fingerings.
  const cycle = generateCycle(scale, cycleId, { ...cycleOptions, length: length + 1 });
  const shifts = octaves.map((o, j) => o - D * Math.floor(j / CYCLE_LAP));
  const path = planGuitarPath(
    cycle.slice(0, length).map((s) => s.voicing),
    fb,
    { constraints, weights, loop: true, octaveShifts: shifts, sweepDirection: down ? "down" : "up" },
  );
  if (!path.ok) return failure(path.failedStep, path.reason);

  const last = path.steps[length - 1]!;
  const next = cycle[length]!.voicing.pitches[0]!;
  // `|| 0` normalizes -0
  const jump = (midi(path.steps[0]!.voicing.pitches[0]!) - (midi(next) + 12 * last.octaveShift)) / 12 || 0;

  return {
    cycle: cycle.slice(0, length),
    path,
    lapLength: CYCLE_LAP,
    laps: length / CYCLE_LAP,
    length,
    wraps: path.steps.filter((s) => s.wrapped).length,
    startOctavesFromEdge: Math.abs(edge[0]! - chosenStart),
    restartJumpOctaves: jump,
  };
}
