/**
 * Build a rhythmic chord progression document from a request, entirely in the engine so the
 * UI holds no music logic: key and cycle → voiced, fretted chords (the perfect loop) →
 * MusicIR → rhythm. The same function is what tests and any other front end can call.
 */
import { makeFretboard, STANDARD_TUNING, type Tuning } from "../instrument/fretboard";
import { withDefaults, type PlayabilityConstraints } from "../instrument/playability";
import { planPerfectCycleLoop } from "../instrument/voiceLeading";
import { buildScale, type ScaleType } from "../theory/scale";
import { type Inversion } from "../theory/voicing";
import { frac } from "../time/rational";
import { cycleToIR } from "./adapters";
import { DEFAULT_RHYTHM, rhythmizeIR, type RhythmSpec } from "./rhythmize";
import type { MusicIR } from "./types";

export interface ProgressionRequest {
  tonic: string;
  scale: ScaleType;
  cycle: number;
  startDegree?: number;
  inversion?: Inversion;
  /** How many chords of the cycle's perfect loop to use, or "loop" for all of it. Default 7. */
  chords?: number | "loop";
  /** Length of each chord in quarter-note beats (4 = one bar of 4/4). Default 4. */
  chordBeats?: number;
  /** Beats per minute (quarter notes). Default 90. */
  bpm?: number;
  rhythm?: RhythmSpec;
  constraints?: Partial<PlayabilityConstraints>;
  tuning?: Tuning;
  fretCount?: number;
  anchorFret?: number;
}

export type ProgressionResult =
  | {
      readonly ok: true;
      readonly ir: MusicIR;
      /** Chords in the document. */
      readonly chords: number;
      /** Chords in the cycle's full perfect loop (the document may use fewer). */
      readonly loopChords: number;
      /** True when the document is the whole loop, so its last chord leads back into the first. */
      readonly closed: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** 4/4, counted in quarter notes. */
export const FOUR_FOUR = { groups: [1, 1, 1, 1], unit: "1/4" } as const;

export function buildCycleProgressionIR(request: ProgressionRequest): ProgressionResult {
  const {
    tonic,
    scale: scaleType,
    cycle,
    startDegree = 1,
    inversion = 0,
    chords = 7,
    chordBeats = 4,
    bpm = 90,
    rhythm = DEFAULT_RHYTHM,
    tuning = STANDARD_TUNING,
    fretCount = 22,
    anchorFret,
  } = request;
  const constraints = withDefaults(request.constraints);
  const scale = buildScale(tonic, scaleType);

  const plan = planPerfectCycleLoop(scale, cycle, makeFretboard(tuning, fretCount), {
    startDegree,
    inversion,
    anchorFret,
    constraints,
  });
  if (!plan.path.ok) return { ok: false, reason: plan.path.reason };

  const loopChords = plan.path.steps.length;
  const n = chords === "loop" ? loopChords : Math.max(1, Math.min(chords, loopChords));
  const closed = n === loopChords;
  const steps = plan.path.steps.slice(0, n).map((s) => ({ voicing: s.voicing, guitar: s.guitar }));

  const base = cycleToIR(scale, cycle, steps, {
    chordDuration: frac(chordBeats, 4),
    tempo: { bpm },
    constraints,
    tuning,
    loop: closed,
  });
  const ir = rhythmizeIR({ ...base, meter: { groups: [...FOUR_FOUR.groups], unit: FOUR_FOUR.unit } }, rhythm);
  return { ok: true, ir, chords: n, loopChords, closed };
}
