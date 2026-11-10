/**
 * Tempo and metric modulation. Symbolic time stays exact; seconds are a float
 * produced only here, for playback.
 */
import { MusicTheoryError } from "../errors";
import { fadd, fdiv, ffloor, fmul, frac, fnum, type Fraction } from "./rational";

const QUARTER: Fraction = frac(1, 4);

/** Seconds from the start for a symbolic position (fraction of a whole note) at `bpm` of `beat` notes per minute. */
export function toSeconds(position: Fraction, bpm: number, beat: Fraction = QUARTER): number {
  if (!(bpm > 0) || !Number.isFinite(bpm)) throw new MusicTheoryError("bpm must be a positive number");
  if (beat.num <= 0) throw new MusicTheoryError("beat must be a positive duration");
  return (fnum(position) / fnum(beat)) * (60 / bpm);
}

/**
 * The audio sample frame at which a symbolic position falls, computed entirely in exact
 * rational arithmetic and rounded ONCE at the end. Because nothing is accumulated in
 * floating point, position n·(1/4) at 120 BPM and 44.1 kHz is exactly frame n·22050 however
 * large n gets, and three triplets in a beat land on exact thirds. `bpm` is the tempo in
 * beats (of `beat`) per minute, as an exact fraction.
 */
export function toSampleFrameExact(position: Fraction, bpm: Fraction, sampleRate: number, beat: Fraction = QUARTER): number {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new MusicTheoryError("sampleRate must be a positive integer");
  if (bpm.num <= 0 || beat.num <= 0) throw new MusicTheoryError("bpm and beat must be positive");
  // frames = position / beat × 60 / bpm × sampleRate
  const exact = fdiv(fmul(fdiv(position, beat), frac(60 * sampleRate)), bpm);
  return ffloor(fadd(exact, frac(1, 2))); // round half up
}

export interface MetricModulationInput {
  /** Tempo before the modulation, in beats per minute (exact). */
  oldBpm: Fraction | number;
  /** The beat unit that tempo is counted in, e.g. 1/4. */
  oldBeat: Fraction;
  /** A span of old time (fraction of a whole note) that becomes ONE beat of the new tempo. */
  span: Fraction;
}

/**
 * Metric modulation: a span of the old tempo is reinterpreted as the new beat.
 * Returns the exact new tempo in beats per minute.
 *
 * Example (from the project notes): three quarter-note triplets fill two old
 * quarter-note beats, and each triplet becomes the new quarter-note beat. One
 * triplet-quarter is 1/6 of a whole note, so 90 BPM (quarter) → 135 BPM.
 */
export function metricModulation({ oldBpm, oldBeat, span }: MetricModulationInput): Fraction {
  if (oldBeat.num <= 0 || span.num <= 0) throw new MusicTheoryError("beat and span must be positive durations");
  const bpm = typeof oldBpm === "number" ? frac(oldBpm) : oldBpm;
  if (bpm.num <= 0) throw new MusicTheoryError("oldBpm must be positive");
  // seconds for the span = span / (bpm × oldBeat) × 60 ; new bpm = 60 / seconds = bpm × oldBeat / span
  return fdiv(fmul(bpm, oldBeat), span);
}
