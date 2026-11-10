/**
 * The six diatonic cycles (2-7).
 *
 * Cycle N moves a diatonic triad so that its root rises N-1 scale degrees
 * (cycle 5 = root up a 5th, e.g. C → G; cycle 2 = C → Dm, …). The per-role
 * scale-step deltas below come from the reference project, but they are not
 * trusted: `verifyCycleDefinition` proves algebraically that each table maps
 * every diatonic triad to the diatonic triad whose root is N-1 degrees higher,
 * and the test-suite runs that proof for all six.
 *
 * Deltas are applied by the *role the voice currently plays* in the triad, in
 * absolute scale steps, so octaves and voice identity are tracked exactly (the
 * reference re-sorted degree sets and could not do this).
 */
import { MusicTheoryError } from "../errors";
import { mod } from "./pitch";
import { type Scale } from "./scale";
import { type DiatonicTriad, type TriadRole } from "./triad";
import {
  analyzeTriadSteps,
  closeVoicingSteps,
  voicingFromSteps,
  type Inversion,
  type TriadVoicing,
} from "./voicing";

export type CycleId = 2 | 3 | 4 | 5 | 6 | 7;
export const CYCLE_IDS: readonly CycleId[] = [2, 3, 4, 5, 6, 7];

export interface CycleDefinition {
  readonly id: CycleId;
  readonly name: string;
  /** Scale degrees the triad root rises per step (always id - 1). */
  readonly rootMotion: number;
  /** Scale-step delta for the voice that currently holds each chord role. */
  readonly deltas: Readonly<Record<TriadRole, number>>;
}

export const CYCLES: Readonly<Record<CycleId, CycleDefinition>> = {
  2: { id: 2, name: "Cycle 2 (roots up a 2nd)", rootMotion: 1, deltas: { root: -2, third: -1, fifth: -1 } },
  3: { id: 3, name: "Cycle 3 (roots up a 3rd)", rootMotion: 2, deltas: { root: -1, third: 0, fifth: 0 } },
  4: { id: 4, name: "Cycle 4 (roots up a 4th)", rootMotion: 3, deltas: { root: 0, third: 1, fifth: 1 } },
  5: { id: 5, name: "Cycle 5 (roots up a 5th)", rootMotion: 4, deltas: { root: -1, third: -1, fifth: 0 } },
  6: { id: 6, name: "Cycle 6 (roots up a 6th)", rootMotion: 5, deltas: { root: 0, third: 0, fifth: 1 } },
  7: { id: 7, name: "Cycle 7 (roots up a 7th)", rootMotion: 6, deltas: { root: 1, third: 1, fifth: 2 } },
};

export function getCycle(id: number): CycleDefinition {
  const c = (CYCLES as Record<number, CycleDefinition | undefined>)[id];
  if (!c) throw new MusicTheoryError(`Unknown cycle ${id}; valid cycles are 2-7`);
  return c;
}

/**
 * Net pitch drift of a cycle in scale steps per chord (sum of its voice deltas).
 * Negative: the voicing descends as the cycle runs (cycles 2, 3, 5). Positive:
 * it ascends (cycles 4, 6, 7). Derived from the table, so it cannot disagree
 * with it.
 */
export function cycleDrift(id: number): number {
  const d = getCycle(id).deltas;
  return d.root + d.third + d.fifth;
}

/**
 * Apply a cycle to voices given as absolute scale steps. Voice identity is
 * preserved: output[i] is the new step of input voice i.
 */
export function applyCycleToSteps(voiceSteps: readonly number[], cycle: CycleDefinition): number[] {
  const analysis = analyzeTriadSteps(voiceSteps);
  if (!analysis) throw new MusicTheoryError(`Steps [${voiceSteps.join(", ")}] do not form a diatonic triad`);
  return voiceSteps.map((s, i) => s + cycle.deltas[analysis.roles[i]!]);
}

/**
 * Prove that `cycle` is well-formed: for every possible root degree the result
 * is a diatonic triad whose root is `rootMotion` degrees higher. Returns the
 * list of failures (empty = valid).
 */
export function verifyCycleDefinition(cycle: CycleDefinition): string[] {
  const failures: string[] = [];
  if (cycle.rootMotion !== cycle.id - 1) failures.push(`rootMotion must be ${cycle.id - 1}`);
  for (let root = 1; root <= 7; root++) {
    for (const inv of [0, 1, 2] as const) {
      const before = closeVoicingSteps(root, inv);
      const after = analyzeTriadSteps(applyCycleToSteps(before, cycle));
      const expected = mod(root - 1 + cycle.rootMotion, 7) + 1;
      if (!after) failures.push(`root ${root} inv ${inv}: result is not a triad`);
      else if (after.rootDegree !== expected)
        failures.push(`root ${root} inv ${inv}: expected root ${expected}, got ${after.rootDegree}`);
    }
  }
  return failures;
}

export interface CycleStep {
  /** 0-based position in the cycle. */
  readonly index: number;
  readonly voicing: TriadVoicing;
  readonly triad: DiatonicTriad;
  readonly inversion: Inversion;
  /** Steps in stable voice-identity order (voice 0 is the original bass). */
  readonly voiceSteps: readonly number[];
  /** Signed scale-step motion of each voice from the previous step (empty for step 0). */
  readonly voiceMotion: readonly number[];
  /** True if voices swapped relative order this step (identity order != pitch order). */
  readonly voiceCrossing: boolean;
}

export interface GenerateCycleOptions {
  /** Degree 1-7 of the starting triad. Default 1. */
  startDegree?: number;
  /** Starting inversion. Default 0. */
  inversion?: Inversion;
  /** Octave of scale step 0 (the tonic). Default 3. */
  tonicOctave?: number;
  /** Whole-octave shift of the starting voicing, in octaves. Default 0. */
  octave?: number;
  /** Number of triads to produce, including the first. Default 7 (a full orbit). */
  length?: number;
}

/** Generate the triads of one cycle, tracking every voice exactly. */
export function generateCycle(scale: Scale, cycleId: number, options: GenerateCycleOptions = {}): CycleStep[] {
  const cycle = getCycle(cycleId);
  const { startDegree = 1, inversion = 0, tonicOctave = 3, octave = 0, length = 7 } = options;
  if (!Number.isInteger(length) || length < 1) throw new MusicTheoryError("length must be a positive integer");

  let voiceSteps = closeVoicingSteps(startDegree, inversion, octave);
  const out: CycleStep[] = [];
  let previous: number[] | undefined;
  for (let index = 0; index < length; index++) {
    const voicing = voicingFromSteps(scale, tonicOctave, voiceSteps);
    const sortedIds = voiceSteps.map((_, i) => i).sort((a, b) => voiceSteps[a]! - voiceSteps[b]!);
    out.push({
      index,
      voicing,
      triad: voicing.triad,
      inversion: voicing.inversion,
      voiceSteps: [...voiceSteps],
      voiceMotion: previous ? voiceSteps.map((s, i) => s - previous![i]!) : [],
      voiceCrossing: sortedIds.some((id, rank) => id !== rank),
    });
    previous = voiceSteps;
    voiceSteps = applyCycleToSteps(voiceSteps, cycle);
  }
  return out;
}
