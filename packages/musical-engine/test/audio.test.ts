import { describe, expect, it } from "vitest";
import { midiToHz, MusicTheoryError, synthesizeChord, synthesizePluck } from "../src";

const SR = 44100;

/** Fundamental frequency by autocorrelation with parabolic interpolation, on a settled stretch of the note. */
function estimateHz(samples: Float32Array, expectedHz: number): number {
  const start = Math.round(SR * 0.15);
  const len = Math.round(SR * 0.3);
  const seg = samples.subarray(start, start + len + Math.ceil((SR / expectedHz) * 1.3));
  const minLag = Math.floor((SR / expectedHz) * 0.8);
  const maxLag = Math.ceil((SR / expectedHz) * 1.2);
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += seg[i]! * seg[i + lag]!;
    return s;
  };
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ac(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  const y0 = ac(bestLag - 1);
  const y1 = ac(bestLag);
  const y2 = ac(bestLag + 1);
  const shift = (y0 - y2) / (2 * (y0 - 2 * y1 + y2));
  return SR / (bestLag + shift);
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);
const rms = (x: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
};

describe("plucked-string synthesis", () => {
  it("MIDI to Hz is the standard scale", () => {
    expect(midiToHz(69)).toBeCloseTo(440, 10);
    expect(midiToHz(57)).toBeCloseTo(220, 10);
    expect(midiToHz(40)).toBeCloseTo(82.4069, 3); // low E
    expect(midiToHz(64)).toBeCloseTo(329.6276, 3); // high E open
  });

  it("every pitch the guitar can play (E2 to D6) sounds within 3 cents of the right frequency", () => {
    // measured worst case is under 1 cent; a one-sample error in the delay line would be ~11-50 cents
    for (let m = 40; m <= 86; m++) {
      const hz = midiToHz(m);
      const est = estimateHz(synthesizePluck(m, { sampleRate: SR, seconds: 1 }), hz);
      expect(Math.abs(cents(est, hz)), `MIDI ${m} (${hz.toFixed(1)} Hz) measured ${est.toFixed(2)} Hz`).toBeLessThan(3);
    }
  });

  it("is deterministic, and the seed changes the timbre", () => {
    const a = synthesizePluck(52, { seconds: 0.5 });
    const b = synthesizePluck(52, { seconds: 0.5 });
    expect(Array.from(a.subarray(0, 2000))).toEqual(Array.from(b.subarray(0, 2000)));
    const c = synthesizePluck(52, { seconds: 0.5, seed: 1 });
    expect(Array.from(c.subarray(0, 200))).not.toEqual(Array.from(a.subarray(0, 200)));
  });

  it("rings and then dies away, stays in range, has no NaN, and ends without a click", () => {
    const x = synthesizePluck(57, { sampleRate: SR, seconds: 2.5 });
    expect(x).toHaveLength(Math.round(SR * 2.5));
    let peak = 0;
    for (const v of x) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(rms(x, SR * 2, SR * 2.4)).toBeLessThan(rms(x, 0, Math.round(SR * 0.3)) * 0.5);
    expect(Math.abs(x[x.length - 1]!)).toBeLessThan(1e-3);
  });

  it("higher decay rings longer", () => {
    const short = synthesizePluck(57, { seconds: 2, decay: 0.99 });
    const long = synthesizePluck(57, { seconds: 2, decay: 0.999 });
    expect(rms(long, SR * 1.5, SR * 1.9)).toBeGreaterThan(rms(short, SR * 1.5, SR * 1.9));
  });

  it("rejects impossible requests", () => {
    expect(() => synthesizePluck(NaN)).toThrow(MusicTheoryError);
    expect(() => synthesizePluck(60, { decay: 1.2 })).toThrow(MusicTheoryError);
    expect(() => synthesizePluck(120, { sampleRate: 8000 })).toThrow(MusicTheoryError);
  });
});

describe("chord synthesis", () => {
  it("mixes to one bounded buffer of the requested length", () => {
    const x = synthesizeChord([48, 52, 55], { sampleRate: SR, seconds: 1.5 });
    expect(x).toHaveLength(Math.round(SR * 1.5));
    let peak = 0;
    for (const v of x) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeCloseTo(0.85, 6);
  });

  it("strums bass first: a note starts only after its strum offset", () => {
    // two identical notes, the second 0.5 s later: until then the chord IS the first note
    const strum = 0.5;
    const chord = synthesizeChord([60, 60], { sampleRate: SR, seconds: 1.2, strumSeconds: strum });
    const single = synthesizePluck(60, { sampleRate: SR, seconds: 1.2 });
    const n = Math.round(SR * 0.45);
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      dot += chord[i]! * single[i]!;
      a += chord[i]! ** 2;
      b += single[i]! ** 2;
    }
    expect(dot / Math.sqrt(a * b)).toBeGreaterThan(0.9999); // proportional to the lone first note
    // after the offset the second note adds energy, so it is no longer proportional
    let dot2 = 0;
    let a2 = 0;
    let b2 = 0;
    for (let i = Math.round(SR * 0.6); i < Math.round(SR * 1.0); i++) {
      dot2 += chord[i]! * single[i]!;
      a2 += chord[i]! ** 2;
      b2 += single[i]! ** 2;
    }
    expect(dot2 / Math.sqrt(a2 * b2)).toBeLessThan(0.9999);
  });

  it("strumSeconds 0 sounds the notes together; deterministic either way", () => {
    const together = synthesizeChord([40, 47, 52], { seconds: 0.5, strumSeconds: 0 });
    const strummed = synthesizeChord([40, 47, 52], { seconds: 0.5, strumSeconds: 0.05 });
    expect(Array.from(together.subarray(0, 500))).not.toEqual(Array.from(strummed.subarray(0, 500)));
    expect(Array.from(synthesizeChord([40, 47, 52], { seconds: 0.5 }).subarray(0, 3000))).toEqual(
      Array.from(synthesizeChord([40, 47, 52], { seconds: 0.5 }).subarray(0, 3000)),
    );
  });

  it("rejects an empty chord", () => {
    expect(() => synthesizeChord([])).toThrow(MusicTheoryError);
  });
});

// ── tone: how strident / plucky / resonant it sounds ──────────────────────
import { PLUCK_TONES, type PluckTone } from "../src";

const TONES: PluckTone[] = ["bright", "mellow", "soft"];
const PITCHES = [45, 52, 59, 66, 73];
const note = (m: number, tone: PluckTone) => synthesizePluck(m, { ...PLUCK_TONES[tone], sampleRate: SR, seconds: 2.5 });
const at = (s: number) => Math.round(SR * s);
/** High-frequency content: rms of the first difference relative to rms of the signal. */
const brightness = (x: Float32Array) => {
  let d2 = 0;
  let e = 0;
  for (let i = at(0.05) + 1; i < at(0.5); i++) {
    d2 += (x[i]! - x[i - 1]!) ** 2;
    e += x[i]! ** 2;
  }
  return Math.sqrt(d2 / e);
};
/** How much of a spike the first 10 ms is compared with the body of the note. */
const pluckSpike = (x: Float32Array) => rms(x, 0, at(0.01)) / rms(x, at(0.05), at(0.3));
/** How much is still ringing around one second in, relative to the start (1 = no decay). */
const ringing = (x: Float32Array) => rms(x, at(1.0), at(1.4)) / rms(x, at(0.05), at(0.3));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const over = (f: (x: Float32Array) => number, tone: PluckTone) => mean(PITCHES.map((m) => f(note(m, tone))));

describe("tone: softer, less pluck, less resonance", () => {
  it("every tone stays in tune (within 3 cents on every guitar pitch)", () => {
    for (const tone of TONES) {
      for (let m = 40; m <= 86; m += 2) {
        const hz = midiToHz(m);
        const est = estimateHz(note(m, tone), hz);
        expect(Math.abs(cents(est, hz)), `${tone} MIDI ${m}`).toBeLessThan(3);
      }
    }
  });

  it("mellow is clearly less bright than bright, and soft is no brighter than mellow", () => {
    const [b, m, s] = TONES.map((t) => over(brightness, t));
    expect(m!).toBeLessThan(b! * 0.8);
    expect(s!).toBeLessThanOrEqual(m! * 1.05);
  });

  it("less pluck: the attack spike shrinks bright > mellow > soft", () => {
    const [b, m, s] = TONES.map((t) => over(pluckSpike, t));
    expect(m!).toBeLessThan(b! * 0.7);
    expect(s!).toBeLessThan(m! * 0.7);
    expect(s!).toBeLessThan(1.2); // soft has essentially no spike: the body is as loud as the start
  });

  it("less resonance: it rings for less time, bright > mellow > soft", () => {
    const [b, m, s] = TONES.map((t) => over(ringing, t));
    expect(m!).toBeLessThan(b! * 0.7);
    expect(s!).toBeLessThan(m! * 0.8);
  });

  it("the default (no options) is the mellow tone", () => {
    const d = synthesizePluck(52, { sampleRate: SR, seconds: 0.5 });
    const m = synthesizePluck(52, { ...PLUCK_TONES.mellow, sampleRate: SR, seconds: 0.5 });
    expect(Array.from(d.subarray(0, 4000))).toEqual(Array.from(m.subarray(0, 4000)));
  });

  it("the parameters do what they say, one at a time", () => {
    const base = { sampleRate: SR, seconds: 1.5, decay: 0.994 };
    // damping: more damping = less bright
    const lowDamp = brightness(synthesizePluck(55, { ...base, damping: 0.1, hardness: 1 }));
    const highDamp = brightness(synthesizePluck(55, { ...base, damping: 1, hardness: 1 }));
    expect(highDamp).toBeLessThan(lowDamp * 0.7);
    // hardness: softer pluck = smaller attack spike
    const hard = pluckSpike(synthesizePluck(55, { ...base, hardness: 1, attackSeconds: 0 }));
    const round = pluckSpike(synthesizePluck(55, { ...base, hardness: 0, attackSeconds: 0 }));
    expect(round).toBeLessThan(hard);
    // attack fade-in: starts from silence and a longer fade means a softer start
    const abrupt = synthesizePluck(55, { ...base, attackSeconds: 0 });
    const faded = synthesizePluck(55, { ...base, attackSeconds: 0.02 });
    expect(Math.abs(faded[0]!)).toBe(0);
    expect(rms(faded, 0, at(0.005))).toBeLessThan(rms(abrupt, 0, at(0.005)) * 0.5);
    // decay: lower loop gain rings for less time
    expect(ringing(synthesizePluck(55, { ...base, decay: 0.98, seconds: 2.5 }))).toBeLessThan(
      ringing(synthesizePluck(55, { ...base, decay: 0.998, seconds: 2.5 })),
    );
  });

  it("has no DC offset (which would thump), in any tone", () => {
    for (const tone of TONES) {
      const x = note(50, tone);
      let sum = 0;
      for (let i = 0; i < at(0.5); i++) sum += x[i]!;
      expect(Math.abs(sum / at(0.5)), tone).toBeLessThan(0.01);
    }
  });

  it("out-of-range option values are clamped, not allowed to break the string", () => {
    for (const bad of [{ damping: 5 }, { damping: -1 }, { hardness: 9 }, { hardness: -3 }]) {
      const x = synthesizePluck(52, { sampleRate: SR, seconds: 0.3, ...bad });
      for (const v of x) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
