import { describe, expect, it } from "vitest";
import { midiToHz, MusicTheoryError, synthesizeChord, synthesizePluck } from "../src";

const SR = 44100;

/**
 * Fundamental frequency by phase tracking. Demodulate the note at the expected pitch over a
 * series of windows; if the true pitch differs, the phase drifts steadily from window to
 * window, and the slope of that drift is the error in Hz. Each window is a Hann-weighted
 * four periods long, which keeps the mirror-image frequency from leaking into the phase.
 * A note that is fading quickly does not bias it (a spectral peak or an autocorrelation over
 * a fast-fading low note does: up to 11 cents at a 0.4 s ring on the low E).
 */
function estimateHz(samples: Float32Array, expectedHz: number): number {
  const len = Math.round((4 * SR) / expectedHz);
  const w = (2 * Math.PI * expectedHz) / SR;
  const phases: number[] = [];
  const times: number[] = [];
  for (let j = 0; j < 8; j++) {
    const centre = Math.round(SR * (0.12 + j * 0.04));
    const from = centre - Math.floor(len / 2);
    if (from < 0 || from + len > samples.length) continue;
    let re = 0;
    let im = 0;
    for (let k = 0; k < len; k++) {
      const i = from + k;
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * (k + 0.5)) / len));
      re += hann * samples[i]! * Math.cos(w * i);
      im -= hann * samples[i]! * Math.sin(w * i);
    }
    phases.push(Math.atan2(im, re));
    times.push(centre / SR);
  }
  // unwrap, then least-squares slope of phase against time
  const un = [phases[0]!];
  for (let j = 1; j < phases.length; j++) {
    let d = phases[j]! - phases[j - 1]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    un.push(un[j - 1]! + d);
  }
  const tm = times.reduce((a, b) => a + b, 0) / times.length;
  const pm = un.reduce((a, b) => a + b, 0) / un.length;
  let num = 0;
  let den = 0;
  for (let j = 0; j < un.length; j++) {
    num += (times[j]! - tm) * (un[j]! - pm);
    den += (times[j]! - tm) ** 2;
  }
  return expectedHz + num / den / (2 * Math.PI);
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

  it("the pitch estimator itself is trustworthy: it recovers a known detuning of a fading sine to 0.2 cent", () => {
    for (const [midi, detune, fadeSeconds] of [[40, 0, 0.4], [40, 7, 0.4], [40, -12, 0.3], [64, 5, 1], [64, -9, 0.4], [86, 3, 0.5]] as const) {
      const hz = midiToHz(midi);
      const actual = hz * Math.pow(2, detune / 1200);
      const x = new Float32Array(SR);
      for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * actual * i) / SR) * Math.exp(-i / SR / (fadeSeconds / 6.9));
      expect(Math.abs(cents(estimateHz(x, hz), actual)), `MIDI ${midi} detuned ${detune}c, fading in ${fadeSeconds}s`).toBeLessThan(0.2);
    }
  });

  it("every pitch the guitar can play (E2 to D6) sounds within half a cent of the right frequency", () => {
    // measured worst case is under 1 cent; a one-sample error in the delay line would be ~11-50 cents
    for (let m = 40; m <= 86; m++) {
      const hz = midiToHz(m);
      const est = estimateHz(synthesizePluck(m, { sampleRate: SR, seconds: 1 }), hz);
      expect(Math.abs(cents(est, hz)), `MIDI ${m} (${hz.toFixed(1)} Hz) measured ${est.toFixed(2)} Hz`).toBeLessThan(0.5);
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
const ALL_TONES: PluckTone[] = ["sine", "soft", "mellow", "bright"];
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
  it("every tone stays in tune (within half a cent on every guitar pitch)", () => {
    for (const tone of ALL_TONES) {
      for (let m = 40; m <= 86; m += 2) {
        const hz = midiToHz(m);
        const est = estimateHz(note(m, tone), hz);
        expect(Math.abs(cents(est, hz)), `${tone} MIDI ${m}`).toBeLessThan(0.5);
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

// ── "almost a plucked sine wave" ──────────────────────────────────────────
/**
 * Purity: the share of ALL the power (noise and every partial included) that sits at the
 * fundamental, over the first 60 ms where a pluck's character lives. The window is a whole
 * number of periods so nothing leaks.
 */
function purity(x: Float32Array, hz: number): number {
  const per = SR / hz;
  const from = Math.round(SR * 0.01);
  const to = Math.round(from + Math.floor((SR * 0.06) / per) * per);
  let re = 0;
  let im = 0;
  let total = 0;
  const w = (2 * Math.PI * hz) / SR;
  for (let i = from; i < to; i++) {
    re += x[i]! * Math.cos(w * i);
    im += x[i]! * Math.sin(w * i);
    total += x[i]! ** 2;
  }
  const n = to - from;
  return ((2 / n) ** 2 * (re * re + im * im)) / 2 / (total / n);
}
const timeToMinus20 = (x: Float32Array) => {
  const ref = rms(x, at(0.2), at(0.3));
  for (let s = 0.3; s < 2.4; s += 0.025) if (rms(x, at(s), at(s + 0.05)) < ref * 0.1) return s - 0.25;
  return Infinity;
};

describe("the sine tone: almost a plucked sine wave", () => {
  const sine = (m: number, extra = {}) => synthesizePluck(m, { ...PLUCK_TONES.sine, sampleRate: SR, seconds: 2.5, ...extra });

  it("is nearly pure: 97%+ of the power is the fundamental, from C4 up (the low register is deliberately richer)", () => {
    for (let m = 60; m <= 84; m += 3) {
      expect(purity(sine(m), midiToHz(m)), `MIDI ${m}`).toBeGreaterThan(0.97);
    }
    // and with the low-end treatment switched off it is pure all the way down
    for (let m = 40; m <= 58; m += 3) {
      expect(purity(sine(m, { lowEnd: 0 }), midiToHz(m)), `MIDI ${m} lowEnd 0`).toBeGreaterThan(0.97);
    }
  });

  it("is far purer than any of the string tones, which start as noise", () => {
    for (const m of [43, 52, 61, 70]) {
      const s = purity(sine(m), midiToHz(m));
      for (const tone of TONES) expect(s, `${tone} MIDI ${m}`).toBeGreaterThan(purity(note(m, tone), midiToHz(m)) * 2);
    }
  });

  it("brightness is the dial: 0 is a pure sine, and more brightness means more upper partials", () => {
    const p0 = purity(sine(64, { brightness: 0 }), midiToHz(64));
    const p12 = purity(sine(64, { brightness: 0.12 }), midiToHz(64));
    const p40 = purity(sine(64, { brightness: 0.4 }), midiToHz(64));
    // (a fading sine is not a perfectly thin line, so even 0 is a hair under 1 in this measure)
    expect(p0).toBeGreaterThan(0.985);
    expect(p12).toBeLessThan(p0 - 0.003);
    expect(p12).toBeGreaterThan(0.97);
    expect(p40).toBeLessThan(p12 - 0.03);
  });

  it("is exactly in tune (the pitch is set directly, not by a delay line): within 0.5 cent", () => {
    for (let m = 40; m <= 86; m++) {
      const hz = midiToHz(m);
      expect(Math.abs(cents(estimateHz(sine(m), hz), hz)), `MIDI ${m}`).toBeLessThan(0.5);
    }
  });

  it("starts softly (no click) and rings out", () => {
    const x = sine(57);
    expect(x[0]).toBe(0);
    expect(rms(x, 0, at(0.002))).toBeLessThan(rms(x, at(0.05), at(0.1)) * 0.3);
    expect(rms(x, at(2.0), at(2.4))).toBeLessThan(rms(x, at(0.05), at(0.3)) * 0.05);
    expect(Math.abs(x[x.length - 1]!)).toBeLessThan(1e-3);
    let peak = 0;
    for (const v of x) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it("rings for the same time at every pitch (a low note does not outlast a high one) when lowEnd is off", () => {
    // ringSeconds is the time to fade 60 dB, so 20 dB takes a third of it
    const expected = 1.2 / 3;
    for (const m of [40, 52, 64, 76, 84]) {
      const t = timeToMinus20(sine(m, { lowEnd: 0 }));
      expect(t, `MIDI ${m}`).toBeGreaterThan(expected * 0.85);
      expect(t, `MIDI ${m}`).toBeLessThan(expected * 1.15);
    }
  });

  it("with lowEnd, notes below C4 ring shorter (up to 35% at E2) and notes from C4 up are unchanged", () => {
    for (const m of [40, 46, 52, 58]) {
      const expected = (1.2 * (1 - 0.35 * Math.min(1, (60 - m) / 20))) / 3;
      const t = timeToMinus20(sine(m));
      expect(t, `MIDI ${m}`).toBeGreaterThan(expected * 0.85);
      expect(t, `MIDI ${m}`).toBeLessThan(expected * 1.15);
    }
    for (const m of [60, 64, 76]) {
      const t = timeToMinus20(sine(m));
      expect(t, `MIDI ${m}`).toBeGreaterThan((1.2 / 3) * 0.85);
      expect(t, `MIDI ${m}`).toBeLessThan((1.2 / 3) * 1.15);
    }
  });

  it("the string tones now ring for the same time at every pitch too", () => {
    for (const [tone, ring] of [["mellow", 1.8], ["soft", 1.1]] as const) {
      const times = [43, 52, 61, 70, 78].map((m) => timeToMinus20(note(m, tone)));
      for (const t of times) {
        expect(t, tone).toBeGreaterThan((ring / 3) * 0.75);
        expect(t, tone).toBeLessThan((ring / 3) * 1.25);
      }
    }
  });

  it("rings shorter than the mellow string, and a longer ringSeconds really rings longer", () => {
    expect(timeToMinus20(sine(55))).toBeLessThan(timeToMinus20(note(55, "mellow")));
    expect(timeToMinus20(sine(55, { ringSeconds: 3 }))).toBeGreaterThan(timeToMinus20(sine(55, { ringSeconds: 0.6 })) * 4);
  });

  it("works in chords, deterministically, and never lets a partial pass the Nyquist frequency", () => {
    const chord = synthesizeChord([48, 52, 55], { ...PLUCK_TONES.sine, seconds: 1 });
    expect(chord).toHaveLength(44100);
    expect(Array.from(chord.subarray(0, 2000))).toEqual(
      Array.from(synthesizeChord([48, 52, 55], { ...PLUCK_TONES.sine, seconds: 1 }).subarray(0, 2000)),
    );
    // MIDI 96 (2093 Hz) at a low sample rate: the upper partials are dropped, not aliased
    const high = synthesizePluck(96, { model: "sine", sampleRate: 11025, seconds: 0.3, brightness: 0.5 });
    for (const v of high) expect(Number.isFinite(v)).toBe(true);
    expect(() => synthesizePluck(110, { model: "sine", sampleRate: 8000 })).toThrow(MusicTheoryError);
  });

  it("lowEnd leaves C4 and above exactly as they were, and 0 switches it off everywhere", () => {
    for (const m of [60, 64, 72, 84]) {
      expect(Array.from(sine(m, { lowEnd: 1 }).subarray(0, 3000)), `MIDI ${m}`).toEqual(Array.from(sine(m, { lowEnd: 0 }).subarray(0, 3000)));
    }
    expect(Array.from(sine(45, { lowEnd: 1 }).subarray(0, 3000))).not.toEqual(Array.from(sine(45, { lowEnd: 0 }).subarray(0, 3000)));
  });

  it("low notes get progressively richer the lower they are (more upper partials), so the ear can tell the pitch", () => {
    const p = [40, 46, 52, 58].map((m) => purity(sine(m), midiToHz(m)));
    for (let i = 1; i < p.length; i++) expect(p[i]!, `step ${i}`).toBeGreaterThan(p[i - 1]!);
    expect(p[3]!).toBeLessThan(purity(sine(64), midiToHz(64))); // MIDI 58 is already (slightly) richer than C4 and up
    expect(p[0]!).toBeLessThan(0.85); // MIDI 40 is clearly richer than the 0.98 of the high register
    expect(p[0]!).toBeGreaterThan(0.5); // ...but still mostly sine, not a different instrument
  });

  it("the extra partials are an attack: they die away much faster than the fundamental", () => {
    const hz = midiToHz(43);
    const x = sine(43);
    const upper = (from: number, to: number) => {
      let re = 0;
      let im = 0;
      const w = (4 * Math.PI * hz) / SR; // 2nd partial
      for (let i = at(from); i < at(to); i++) {
        re += x[i]! * Math.cos(w * i);
        im += x[i]! * Math.sin(w * i);
      }
      return Math.hypot(re, im) / (at(to) - at(from));
    };
    const fundamental = (from: number, to: number) => {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * hz) / SR;
      for (let i = at(from); i < at(to); i++) {
        re += x[i]! * Math.cos(w * i);
        im += x[i]! * Math.sin(w * i);
      }
      return Math.hypot(re, im) / (at(to) - at(from));
    };
    const early = upper(0.03, 0.13) / fundamental(0.03, 0.13);
    const late = upper(0.5, 0.6) / fundamental(0.5, 0.6);
    expect(early).toBeGreaterThan(0.3);
    expect(late).toBeLessThan(early * 0.25);
  });

  it("low notes fade in over at least 1.25 periods with a smooth (cosine) ramp, so there is no thud", () => {
    const early = (m: number) => rms(sine(m), 0, at(0.005)) / rms(sine(m), at(0.05), at(0.1));
    // the 82 Hz note takes ~15 ms to fade in, the 330 Hz note 8 ms: its first 5 ms are far quieter
    expect(early(40)).toBeLessThan(early(64) * 0.7);
    // smooth: the fade is a raised cosine, so it starts flat (no corner) rather than as a straight ramp
    const x = sine(40);
    const periods125 = Math.round((1.25 * SR) / midiToHz(40));
    expect(Math.abs(x[Math.round(periods125 / 20)]!)).toBeLessThan(0.02);
  });

  it("easing the fundamental back reduces the boom: less of the low-note energy sits in the lowest octave", () => {
    const hz = midiToHz(40);
    const share = (x: Float32Array) => {
      const a = at(0.02);
      const b = at(0.12);
      const bin = (f: number) => {
        let re = 0;
        let im = 0;
        const w = (2 * Math.PI * f) / SR;
        for (let i = a; i < b; i++) {
          re += x[i]! * Math.cos(w * i);
          im += x[i]! * Math.sin(w * i);
        }
        return re * re + im * im;
      };
      return bin(hz) / (bin(hz) + bin(2 * hz) + bin(3 * hz) + bin(4 * hz));
    };
    // the fundamental's share of the first four partials drops by about a sixth (0.99 -> 0.82)
    expect(share(sine(40, { lowEnd: 1 }))).toBeLessThan(share(sine(40, { lowEnd: 0 })) * 0.9);
  });

  it("rejects bad ring times and clamps odd brightness values", () => {
    expect(() => synthesizePluck(60, { model: "sine", ringSeconds: 0 })).toThrow(MusicTheoryError);
    expect(() => synthesizePluck(60, { ringSeconds: -1 })).toThrow(MusicTheoryError);
    for (const b of [-1, 5]) {
      for (const v of synthesizePluck(60, { model: "sine", seconds: 0.2, brightness: b })) expect(Number.isFinite(v)).toBe(true);
      for (const v of synthesizePluck(45, { model: "sine", seconds: 0.2, lowEnd: b })) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
