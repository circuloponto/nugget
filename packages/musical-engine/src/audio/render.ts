/**
 * Offline rendering of scheduled notes into one buffer. Every note is placed at its exact
 * integer start frame by copying the synthesized note into the output at that index, so
 * timing is sample-accurate by construction and independent of any timer or of how busy the
 * main thread is. Playing the result with a single Web Audio buffer source (at the context's
 * own sample rate, so nothing is resampled) puts every event on its exact frame.
 *
 * A note sounds for its notated length and then releases over a short, smooth fade, so the
 * length in the score is what you hear. When `wrapTail` is on (the default) the release of
 * notes near the end wraps around to the start, so a looping buffer is seamless: the sound
 * at the loop point is exactly what it would be if the music simply carried on.
 */
import { MusicTheoryError } from "../errors";
import { PLUCK_TONES, synthesizePluck, type PluckOptions } from "./pluck";

export interface RenderableEvent {
  readonly startFrame: number;
  /** One past the last frame of the notated length. */
  readonly endFrame: number;
  readonly midi: number;
  /** 0..1, default 0.8. */
  readonly velocity?: number;
}

export interface RenderOptions {
  sampleRate: number;
  /** Loop length in frames. */
  totalFrames: number;
  /** Tone of every note, used as given. Default: the sine tone. */
  tone?: PluckOptions;
  /** Smooth fade after a note's notated length, in seconds. Default 0.08. */
  releaseSeconds?: number;
  /** Wrap what rings past the end back onto the start (a seamless loop). Default true. */
  wrapTail?: boolean;
  /** Longest a single note can ring, in seconds. Default 3. */
  maxNoteSeconds?: number;
  /** Peak the mix is limited to. Default 0.9. */
  headroom?: number;
}

export interface RenderResult {
  readonly samples: Float32Array;
  /** Peak of the mix before limiting. */
  readonly peak: number;
  /** Gain applied to keep the mix under `headroom` (1 = untouched). */
  readonly gain: number;
}

/** Mix the events into a mono buffer. Deterministic: the same input gives the same samples. */
export function renderEvents(events: readonly RenderableEvent[], options: RenderOptions): RenderResult {
  const { sampleRate, totalFrames } = options;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new MusicTheoryError("sampleRate must be a positive integer");
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) throw new MusicTheoryError("totalFrames must be a positive integer");
  const wrapTail = options.wrapTail ?? true;
  const release = Math.max(1, Math.round((options.releaseSeconds ?? 0.08) * sampleRate));
  const headroom = options.headroom ?? 0.9;
  // A tone is used exactly as given (merging it over the sine preset would leak the sine
  // model and its brightness into every other tone). Only an absent tone defaults to sine.
  const tone: PluckOptions = options.tone ?? PLUCK_TONES.sine;

  const notes = new Map<number, Float32Array>();
  const noteFor = (midi: number): Float32Array => {
    let buf = notes.get(midi);
    if (!buf) {
      buf = synthesizePluck(midi, { ...tone, sampleRate, seconds: options.maxNoteSeconds ?? 3 });
      notes.set(midi, buf);
    }
    return buf;
  };

  // without wrapping, leave room for the last notes' release instead of cutting it off
  const length = wrapTail ? totalFrames : Math.max(totalFrames, ...events.map((e) => e.endFrame + release));
  const out = new Float32Array(length);
  for (const e of events) {
    if (e.startFrame < 0 || e.endFrame <= e.startFrame) throw new MusicTheoryError(`Bad event frames ${e.startFrame}-${e.endFrame}`);
    const buf = noteFor(e.midi);
    const velocity = e.velocity ?? 0.8;
    const held = e.endFrame - e.startFrame;
    const n = Math.min(held + release, buf.length);
    for (let k = 0; k < n; k++) {
      const env = k < held ? 1 : 0.5 * (1 + Math.cos((Math.PI * (k - held)) / release)); // raised-cosine release
      const at = e.startFrame + k;
      const i = wrapTail ? at % length : at;
      if (i < length) out[i]! += buf[k]! * velocity * env;
    }
  }

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > headroom ? headroom / peak : 1;
  if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! * gain;
  return { samples: out, peak, gain };
}
