/**
 * Plucked-string synthesis (Karplus-Strong) as pure functions over Float32Array.
 * No Web Audio dependency: the Lab (or anything else) wraps the samples in
 * whatever player it has. Deterministic: the same note always yields the same
 * samples, so audio can be tested.
 *
 * What makes the classic algorithm sound "strident", and what is done about it
 *  - Pluck edge: the string starts from a burst of noise. `hardness` smooths that
 *    burst (less hardness = rounder, less percussive attack) and `attackSeconds`
 *    fades the note in so there is no click.
 *  - Brightness: the loop filter decides how fast high harmonics die. The filter
 *    here is the symmetric 3-tap [a, 1-2a, a], where `damping` runs `a` from 0
 *    (no filtering, very bright) to 0.25 (strongest smoothing, mellow). Symmetric
 *    means its delay is exactly one sample at every setting, so tuning does not
 *    move when you change the tone.
 *  - Resonance: `decay` is the loop gain; lower rings for less time.
 *
 * Tuning accuracy: the delay line has a whole number of samples, so a plain
 * Karplus-Strong string is audibly out of tune at high pitches. A first-order
 * all-pass supplies the fractional part of the delay, keeping every guitar pitch
 * within a cent or so.
 */
import { MusicTheoryError } from "../errors";

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export interface PluckOptions {
  /** Default 44100. */
  sampleRate?: number;
  /** Length of the note in seconds. Default 2.5. */
  seconds?: number;
  /** Loop gain per pass, 0..1: closer to 1 rings longer. Default 0.993. */
  decay?: number;
  /** Loop low-pass amount, 0..1: 1 = mellowest (high harmonics die fast), 0 = brightest. Default 1. */
  damping?: number;
  /** Hardness of the initial pluck, 0..1: 0 = round and soft, 1 = raw noise burst. Default 0.35. */
  hardness?: number;
  /** Fade-in at the start of the note, in seconds. Default 0.006. */
  attackSeconds?: number;
  /** Changes the noise burst (and therefore the exact timbre). Default 0. */
  seed?: number;
}

/** Named tones. `mellow` is the default; `bright` is close to a plain Karplus-Strong pluck. */
export const PLUCK_TONES = {
  /** Round and short, like a nylon string played with the pad of the finger. */
  soft: { decay: 0.99, damping: 1, hardness: 0, attackSeconds: 0.015 },
  /** The default: softer than a plain pluck, still clearly a guitar. */
  mellow: { decay: 0.993, damping: 1, hardness: 0.35, attackSeconds: 0.006 },
  /** Closest to the original strident sound. */
  bright: { decay: 0.996, damping: 0.5, hardness: 1, attackSeconds: 0.001 },
} as const satisfies Record<string, PluckOptions>;

export type PluckTone = keyof typeof PLUCK_TONES;

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** One plucked note, peak-normalized to 0.9. */
export function synthesizePluck(midi: number, options: PluckOptions = {}): Float32Array {
  const sr = options.sampleRate ?? 44100;
  const seconds = options.seconds ?? 2.5;
  const decay = options.decay ?? 0.993;
  const damping = clamp01(options.damping ?? 1);
  const hardness = clamp01(options.hardness ?? 0.35);
  const attack = Math.max(0, options.attackSeconds ?? 0.006);
  if (!Number.isFinite(midi)) throw new MusicTheoryError("pluck needs a finite MIDI number");
  if (!(decay > 0 && decay < 1)) throw new MusicTheoryError("decay must be between 0 and 1");

  const f = midiToHz(midi);
  // Total loop delay must be sr/f samples = n (buffer) + 1 (symmetric 3-tap filter) + frac
  // (all-pass). A first-order all-pass is accurate for a fractional delay in [0.5, 1.5),
  // so n is chosen to keep frac there.
  const delay = sr / f - 1;
  const n = Math.floor(delay - 0.5);
  if (n < 2) throw new MusicTheoryError(`MIDI ${midi} is too high for sample rate ${sr}`);
  const frac = delay - n;
  const c = (1 - frac) / (1 + frac); // all-pass coefficient for a fractional delay of `frac`
  const a = 0.25 * damping; // loop filter [a, 1-2a, a]

  // The pluck: noise, rounded off by repeated smoothing, with no DC (which would thump).
  const rand = mulberry32(Math.round(midi * 1000) + (options.seed ?? 0) * 7919);
  let line = new Float32Array(n);
  for (let i = 0; i < n; i++) line[i] = rand() - 0.5;
  const passes = Math.round((1 - hardness) * 10);
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) next[i] = 0.25 * line[(i + n - 1) % n]! + 0.5 * line[i]! + 0.25 * line[(i + 1) % n]!;
    line = next;
  }
  let mean = 0;
  for (const v of line) mean += v;
  mean /= n;
  for (let i = 0; i < n; i++) line[i] = line[i]! - mean;

  const out = new Float32Array(Math.max(1, Math.round(sr * seconds)));
  let idx = 0;
  let last = 0; // output sample i-1
  let last2 = 0; // output sample i-2
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < out.length; i++) {
    const cur = line[idx]!;
    out[i] = cur;
    const x = decay * (a * cur + (1 - 2 * a) * last + a * last2); // centred on i-1: exactly one sample of delay
    last2 = last;
    last = cur;
    const y = c * x + prevX - c * prevY; // all-pass: (c + z⁻¹) / (1 + c·z⁻¹)
    prevX = x;
    prevY = y;
    line[idx] = y;
    idx = (idx + 1) % n;
  }

  // normalize; fade in (no click, softer attack) and out (no click at the end)
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 0.9 / peak : 1;
  const fadeIn = Math.min(out.length, Math.round(sr * attack));
  const fadeOut = Math.min(out.length, Math.round(sr * 0.04));
  for (let i = 0; i < out.length; i++) {
    const tail = out.length - i;
    const head = fadeIn > 0 && i < fadeIn ? i / fadeIn : 1;
    out[i] = out[i]! * gain * head * (tail < fadeOut ? tail / fadeOut : 1);
  }
  return out;
}

export interface ChordSynthOptions extends PluckOptions {
  /** Delay between successive strings, bass first. Default 0.03 s. 0 = all together. */
  strumSeconds?: number;
}

/** Several notes strummed bass-first and mixed to one buffer (peak 0.85). `midis` are in voice order, bass first. */
export function synthesizeChord(midis: readonly number[], options: ChordSynthOptions = {}): Float32Array {
  if (midis.length === 0) throw new MusicTheoryError("synthesizeChord needs at least one note");
  const sr = options.sampleRate ?? 44100;
  const seconds = options.seconds ?? 2.5;
  const strum = options.strumSeconds ?? 0.03;
  const total = Math.max(1, Math.round(sr * seconds));
  const out = new Float32Array(total);
  midis.forEach((m, i) => {
    const note = synthesizePluck(m, { ...options, sampleRate: sr, seconds });
    const offset = Math.round(i * strum * sr);
    for (let k = 0; k + offset < total && k < note.length; k++) out[k + offset]! += note[k]! / midis.length;
  });
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i]! / peak) * 0.85;
  return out;
}
