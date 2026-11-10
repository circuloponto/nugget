/**
 * Browser playback for the Lab. The sound itself is synthesized by the engine
 * (`synthesizeChord`, a plucked-string model, deterministic); this file only
 * hands the samples to Web Audio. Browsers only allow audio after a user
 * gesture, so the context is created lazily from a click or key press.
 */
import { PLUCK_TONES, synthesizeChord, type PluckOptions, type PluckTone } from "@musical-lab/engine";

export type { PluckOptions, PluckTone };

let ctx: AudioContext | null = null;
let active: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
const cache = new Map<string, AudioBuffer>();

/** Seconds between strings: the softer the tone, the gentler the strum. */
const STRUM: Record<PluckTone, number> = { sine: 0.04, soft: 0.045, mellow: 0.038, bright: 0.028 };

/** What the last chord played, for diagnostics (dev builds expose it as window.__labAudio). */
export const audioDebug = {
  plays: 0,
  lastMidis: [] as number[],
  lastTone: "" as string,
  lastOverrides: {} as Record<string, unknown>,
  lastPeak: 0,
  state: "none" as string,
};

/** Create/resume the audio context. Call from a user gesture. Returns null where Web Audio is unavailable. */
export function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  audioDebug.state = ctx.state;
  return ctx;
}

function bufferFor(c: AudioContext, midis: readonly number[], tone: PluckTone, overrides?: PluckOptions): AudioBuffer {
  const key = `${c.sampleRate}:${tone}:${JSON.stringify(overrides ?? {})}:${midis.join(",")}`;
  let buf = cache.get(key);
  if (!buf) {
    const samples = synthesizeChord(midis, {
      ...PLUCK_TONES[tone],
      ...overrides,
      sampleRate: c.sampleRate,
      seconds: 2.6,
      strumSeconds: STRUM[tone],
    });
    buf = c.createBuffer(1, samples.length, c.sampleRate);
    buf.copyToChannel(new Float32Array(samples), 0);
    cache.set(key, buf);
    if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  }
  return buf;
}

/** Strum a chord (MIDI numbers, bass first). The previous chord is faded out quickly, not cut. */
export function playChord(midis: readonly number[], tone: PluckTone = "sine", overrides?: PluckOptions): boolean {
  const c = ensureAudio();
  if (!c || midis.length === 0) return false;
  const now = c.currentTime;
  if (active) {
    active.gain.gain.cancelScheduledValues(now);
    active.gain.gain.setTargetAtTime(0, now, 0.05);
    active.src.stop(now + 0.35);
  }
  const buf = bufferFor(c, midis, tone, overrides);
  const src = c.createBufferSource();
  const gain = c.createGain();
  gain.gain.value = 0.9;
  src.buffer = buf;
  src.connect(gain).connect(c.destination);
  src.start(now);
  active = { src, gain };

  let peak = 0;
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]!));
  audioDebug.plays++;
  audioDebug.lastMidis = [...midis];
  audioDebug.lastTone = tone;
  audioDebug.lastOverrides = overrides ? { ...overrides } : {};
  audioDebug.lastPeak = peak;
  audioDebug.state = c.state;
  if (process.env.NODE_ENV !== "production") (window as unknown as { __labAudio?: typeof audioDebug }).__labAudio = audioDebug;
  return true;
}
