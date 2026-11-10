/**
 * Plucked-note synthesis as pure functions over Float32Array. No Web Audio
 * dependency: the Lab (or anything else) wraps the samples in whatever player it
 * has. Deterministic: the same note always yields the same samples, so audio can
 * be tested.
 *
 * Two models
 *  - "string" (Karplus-Strong): a recirculating delay line seeded with a noise burst.
 *    Guitar-like, but the burst is where the pluck and the strident edge come from.
 *  - "sine": a sine wave at the exact pitch with a soft attack and an exponential
 *    decay, plus a controllable trace of the upper partials. This is "almost a
 *    plucked sine wave": perfectly in tune, and purity is a number you set.
 *
 * Softening the "string" model (what each parameter does)
 *  - Pluck edge: `hardness` smooths the noise burst (scaled to the string's period, so
 *    low strings are rounded too) and `attackSeconds` fades the note in.
 *  - Brightness: the loop filter decides how fast high harmonics die. It is the
 *    symmetric 3-tap [a, 1-2a, a], where `damping` runs `a` from 0 (no filtering) to
 *    0.25 (strongest). Symmetric means exactly one sample of delay at every setting,
 *    so tuning does not move with the tone.
 *  - Resonance: `ringSeconds` is how long it rings, the same for every pitch (the
 *    loop gain is worked out per note, allowing for the loop filter). `decay` sets
 *    the raw loop gain instead.
 *
 * Tuning accuracy of the string model: the delay line has a whole number of samples,
 * so a plain Karplus-Strong string is audibly out of tune at high pitches. A
 * first-order all-pass supplies the fractional part of the delay.
 */
import { MusicTheoryError } from "../errors";

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export interface PluckOptions {
  /** "string" = Karplus-Strong (default), "sine" = a plucked sine wave. */
  model?: "string" | "sine";
  /** Default 44100. */
  sampleRate?: number;
  /** Length of the note in seconds. Default 2.5. */
  seconds?: number;
  /**
   * How long the note rings: seconds to fade by 60 dB. The same for every pitch, so a
   * low string no longer rings far longer than a high one. Default 1.8 (string), 1.2 (sine).
   */
  ringSeconds?: number;
  /** Fade-in at the start of the note, in seconds. Default 0.012. */
  attackSeconds?: number;
  /**
   * Sine model only. Level of each upper partial relative to the one below it:
   * 0 = a pure sine wave, 0.12 = a faint trace of 2nd and 3rd harmonic (default 0.12).
   * Upper partials also die away faster than the fundamental.
   */
  brightness?: number;
  /**
   * Sine model only: how much extra definition the LOW register gets, 0..1 (default 1).
   * A pure sine is clear up high but muddy low down: close chord notes sit inside each
   * other's critical band and beat, and with no harmonics the ear cannot tell which pitch
   * is which. Below C4 (MIDI 60), fading in fully by E2 (MIDI 40), this adds upper partials
   * (up to `brightness` 0.45 at the bottom), eases the fundamental back by up to 40% (the
   * boom: equal-strength sines at 80-130 Hz pile up energy where a real guitar is weak, and
   * the harmonics then carry the pitch), shortens the ring by up to 35%, and lengthens the
   * fade-in to at least 1.25 periods. Notes from C4 up are untouched; 0 turns it all off.
   */
  lowEnd?: number;
  /**
   * String model only. Raw loop gain per pass, 0..1. Overrides `ringSeconds` when given.
   * Closer to 1 rings longer, and low pitches ring longer than high ones for the same value.
   */
  decay?: number;
  /** String model only. Loop low-pass amount, 0..1: 1 = mellowest, 0 = brightest. Default 1. */
  damping?: number;
  /** String model only. Hardness of the initial pluck, 0..1: 0 = round, 1 = raw noise burst. Default 0.1. */
  hardness?: number;
  /** String model only. Changes the noise burst (and therefore the exact timbre). Default 0. */
  seed?: number;
}

/** Named tones. `sine` is the Lab's default; `bright` is close to a plain Karplus-Strong pluck. */
export const PLUCK_TONES = {
  /** Almost a plucked sine wave: nearly only the fundamental, soft attack, short ring. */
  sine: { model: "sine", ringSeconds: 1.2, brightness: 0.12, attackSeconds: 0.008, lowEnd: 1 },
  /** Round and short, like a nylon string played with the pad of the finger. */
  soft: { ringSeconds: 1.1, damping: 1, hardness: 0, attackSeconds: 0.025 },
  /** A guitar string, softened: less bright, little pluck, short ring. */
  mellow: { ringSeconds: 1.8, damping: 1, hardness: 0.1, attackSeconds: 0.012 },
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
const LN1000 = Math.log(1000); // 60 dB

/**
 * Peak-normalize to 0.9, fade in (soft start, no click) and out (no click at the end). A
 * "cosine" fade-in has no corner at either end, so it spreads far less energy outside the
 * note's own frequency than a straight ramp does.
 */
function finish(out: Float32Array, sr: number, attack: number, shape: "linear" | "cosine" = "linear"): Float32Array {
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 0.9 / peak : 1;
  const fadeIn = Math.min(out.length, Math.round(sr * attack));
  const fadeOut = Math.min(out.length, Math.round(sr * 0.04));
  for (let i = 0; i < out.length; i++) {
    const tail = out.length - i;
    const x = fadeIn > 0 && i < fadeIn ? i / fadeIn : 1;
    const head = shape === "cosine" ? 0.5 * (1 - Math.cos(Math.PI * x)) : x;
    out[i] = out[i]! * gain * head * (tail < fadeOut ? tail / fadeOut : 1);
  }
  return out;
}

/** 0 from C4 up, rising to 1 at E2 and below. */
const lowness = (midi: number) => clamp01((60 - midi) / 20);

/**
 * A sine at the exact pitch, with a trace of upper partials that die away faster. In the low
 * register (see `lowEnd`) it gets more partials and a shorter ring, and its fade-in is at
 * least 1.25 periods long (a fade shorter than one period of a low note is a click, heard
 * as a thud).
 */
function sinePluck(
  midi: number,
  sr: number,
  seconds: number,
  ring: number,
  brightness: number,
  attack: number,
  lowEnd: number,
): Float32Array {
  const f = midiToHz(midi);
  const low = lowness(midi) * lowEnd;
  const b = brightness + (Math.max(brightness, 0.45) - brightness) * low;
  const t60 = ring * (1 - 0.35 * low);
  const out = new Float32Array(Math.max(1, Math.round(sr * seconds)));
  for (let k = 1; k <= 12; k++) {
    if (k * f >= 0.45 * sr) break; // stay clear of the Nyquist frequency
    const amp = Math.pow(b, k - 1) * (k === 1 ? 1 - 0.4 * low : 1);
    if (amp < 1e-3) break;
    const tau = t60 / k / LN1000; // partial k fades 60 dB in t60/k seconds
    const w = (2 * Math.PI * k * f) / sr;
    for (let i = 0; i < out.length; i++) out[i]! += amp * Math.sin(w * i) * Math.exp(-i / sr / tau);
  }
  return finish(out, sr, Math.max(attack, 1.25 / f), "cosine");
}

/** One plucked note, peak-normalized to 0.9. */
export function synthesizePluck(midi: number, options: PluckOptions = {}): Float32Array {
  const sr = options.sampleRate ?? 44100;
  const seconds = options.seconds ?? 2.5;
  const attack = Math.max(0, options.attackSeconds ?? 0.012);
  if (!Number.isFinite(midi)) throw new MusicTheoryError("pluck needs a finite MIDI number");
  if (options.decay !== undefined && !(options.decay > 0 && options.decay < 1)) {
    throw new MusicTheoryError("decay must be between 0 and 1");
  }
  if (options.ringSeconds !== undefined && !(options.ringSeconds > 0)) {
    throw new MusicTheoryError("ringSeconds must be positive");
  }
  const f = midiToHz(midi);

  if (options.model === "sine") {
    if (f >= 0.45 * sr) throw new MusicTheoryError(`MIDI ${midi} is too high for sample rate ${sr}`);
    return sinePluck(midi, sr, seconds, options.ringSeconds ?? 1.2, clamp01(options.brightness ?? 0.12), attack, clamp01(options.lowEnd ?? 1));
  }

  const damping = clamp01(options.damping ?? 1);
  const hardness = clamp01(options.hardness ?? 0.1);

  // Total loop delay must be sr/f samples = n (buffer) + 1 (symmetric 3-tap filter) + frac
  // (all-pass). A first-order all-pass is accurate for a fractional delay in [0.5, 1.5),
  // so n is chosen to keep frac there.
  const delay = sr / f - 1;
  const n = Math.floor(delay - 0.5);
  if (n < 2) throw new MusicTheoryError(`MIDI ${midi} is too high for sample rate ${sr}`);
  const frac = delay - n;
  const c = (1 - frac) / (1 + frac); // all-pass coefficient for a fractional delay of `frac`
  const a = 0.25 * damping; // loop filter [a, 1-2a, a]

  // Loop gain. For a ring time, work out the gain per pass that fades 60 dB in
  // `ringSeconds` at THIS pitch (f passes per second), and divide out what the loop filter
  // already removes at the fundamental, so every pitch rings for the same time.
  const filterAtF0 = 1 - 2 * a + 2 * a * Math.cos((2 * Math.PI * f) / sr);
  const decay =
    options.decay ?? Math.min(0.99995, Math.pow(10, -3 / (f * (options.ringSeconds ?? 1.8))) / filterAtF0);

  // The pluck: noise, rounded off by repeated smoothing, with no DC (which would thump).
  // How much to round it scales with the string's period: a fixed handful of samples
  // would leave low strings (hundreds of samples long) with a raw noise burst.
  const rand = mulberry32(Math.round(midi * 1000) + (options.seed ?? 0) * 7919);
  let line = new Float32Array(n);
  for (let i = 0; i < n; i++) line[i] = rand() - 0.5;
  const passes = Math.round((1 - hardness) * (8 + n * 0.12));
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
  return finish(out, sr, attack);
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
