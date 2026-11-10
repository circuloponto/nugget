/**
 * Abstract triad voicings: exact, octave-qualified pitches with a derived
 * inversion. Nothing here knows about guitars.
 *
 * A voicing is stored as absolute *scale steps* (see scale.ts). Because steps
 * increase monotonically with pitch inside a diatonic scale, sorting steps
 * sorts pitches, and the inversion is simply the chord role of the lowest step.
 */
import { MusicTheoryError } from "../errors";
import { mod, midi, type Pitch } from "./pitch";
import { pitchAtStep, type Scale } from "./scale";
import { triadAt, TRIAD_ROLES, type DiatonicTriad, type TriadRole } from "./triad";

/** 0 = root position, 1 = first inversion (3rd in bass), 2 = second (5th in bass). */
export type Inversion = 0 | 1 | 2;

export const INVERSION_NAMES = ["root position", "first inversion", "second inversion"] as const;

/** Chord role of each step, by scale-degree distance from the triad root. */
const ROLE_BY_OFFSET: Readonly<Record<number, TriadRole>> = { 0: "root", 2: "third", 4: "fifth" };

export interface TriadAnalysis {
  /** Degree 1-7 of the triad root. */
  readonly rootDegree: number;
  /** Role of each input voice, in input order. */
  readonly roles: readonly TriadRole[];
}

/**
 * Identify which voice is root/third/fifth from absolute steps. The steps must
 * be exactly one root, one third and one fifth of a single diatonic triad
 * (any octaves, any order). Returns null if they are not.
 */
export function analyzeTriadSteps(steps: readonly number[]): TriadAnalysis | null {
  if (steps.length !== 3) return null;
  const degrees = steps.map((s) => mod(s, 7));
  for (let r = 0; r < 7; r++) {
    const roles = degrees.map((d) => ROLE_BY_OFFSET[mod(d - r, 7)]);
    if (roles.every((x): x is TriadRole => x !== undefined) && new Set(roles).size === 3) {
      return { rootDegree: r + 1, roles: roles as TriadRole[] };
    }
  }
  return null;
}

/** Inversion implied by the lowest step. */
export function inversionOfSteps(steps: readonly number[]): Inversion {
  const analysis = analyzeTriadSteps(steps);
  if (!analysis) throw new MusicTheoryError("Steps do not form a diatonic triad");
  const bass = steps.indexOf(Math.min(...steps));
  const role = analysis.roles[bass]!;
  return role === "root" ? 0 : role === "third" ? 1 : 2;
}

/**
 * Close-position steps for a triad rooted on `rootDegree` in the given
 * inversion. `octave` shifts the whole voicing by whole octaves (7 steps).
 */
export function closeVoicingSteps(rootDegree: number, inversion: Inversion, octave = 0): number[] {
  if (!Number.isInteger(rootDegree) || rootDegree < 1 || rootDegree > 7) {
    throw new MusicTheoryError(`rootDegree must be 1-7, got ${rootDegree}`);
  }
  if (inversion !== 0 && inversion !== 1 && inversion !== 2) {
    throw new MusicTheoryError(`inversion must be 0, 1 or 2, got ${String(inversion)}`);
  }
  const s = rootDegree - 1 + 7 * octave;
  switch (inversion) {
    case 0:
      return [s, s + 2, s + 4];
    case 1:
      return [s + 2, s + 4, s + 7];
    case 2:
      return [s + 4, s + 7, s + 9];
  }
}

export interface TriadVoicing {
  readonly triad: DiatonicTriad;
  /** Ascending absolute scale steps, bass first. */
  readonly steps: readonly number[];
  /** Exact spelled pitches, ascending, bass first. */
  readonly pitches: readonly Pitch[];
  readonly inversion: Inversion;
}

/** Build a voicing from absolute steps (any order); throws if not a triad. */
export function voicingFromSteps(scale: Scale, tonicOctave: number, steps: readonly number[]): TriadVoicing {
  const analysis = analyzeTriadSteps(steps);
  if (!analysis) throw new MusicTheoryError(`Steps [${steps.join(", ")}] do not form a diatonic triad`);
  const sorted = [...steps].sort((a, b) => a - b);
  return {
    triad: triadAt(scale, analysis.rootDegree),
    steps: sorted,
    pitches: sorted.map((s) => pitchAtStep(scale, s, tonicOctave)),
    inversion: inversionOfSteps(sorted),
  };
}

/** Close-position voicing of the triad on `degree`, in `inversion`. */
export function closeVoicing(
  scale: Scale,
  degree: number,
  inversion: Inversion,
  tonicOctave: number,
  octave = 0,
): TriadVoicing {
  return voicingFromSteps(scale, tonicOctave, closeVoicingSteps(degree, inversion, octave));
}

/** Shift a voicing by whole octaves, keeping spelling and inversion. */
export function shiftVoicingOctaves(v: TriadVoicing, octaves: number): TriadVoicing {
  return {
    ...v,
    steps: v.steps.map((s) => s + 7 * octaves),
    pitches: v.pitches.map((p) => ({ ...p, octave: p.octave + octaves })),
  };
}

/** Sum of absolute semitone motion between two same-size pitch lists, voice by voice. */
export function totalSemitoneMotion(a: readonly Pitch[], b: readonly Pitch[]): number {
  if (a.length !== b.length) throw new MusicTheoryError("Voicings must have the same number of voices");
  return a.reduce((sum, p, i) => sum + Math.abs(midi(p) - midi(b[i]!)), 0);
}

export { TRIAD_ROLES };
