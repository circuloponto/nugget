import { describe, expect, it } from "vitest";
import {
  buildCycleProgressionIR,
  chordIndexAtFrame,
  frac,
  fadd,
  MusicTheoryError,
  parseFraction,
  PLUCK_TONES,
  renderDocument,
  renderEvents,
  scheduleFrames,
  soundingAtFrame,
  synthesizePluck,
  toSampleFrameExact,
  wrapFrame,
  type MusicIR,
  type RenderableEvent,
  type RhythmSpec,
} from "../src";

const SR = 44100;

function build(extra: Partial<Parameters<typeof buildCycleProgressionIR>[0]> = {}): MusicIR {
  const r = buildCycleProgressionIR({ tonic: "C", scale: "major", cycle: 5, ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r.ir;
}
const rhythm = (pattern: string, mode: RhythmSpec["mode"] = "block"): RhythmSpec => ({ pattern, mode });
const firstNonZero = (x: Float32Array, from = 0) => {
  for (let i = from; i < x.length; i++) if (x[i] !== 0) return i;
  return -1;
};

describe("scheduling a document onto sample frames", () => {
  it("chords are exactly one chord-length apart, tile the whole timeline, and never drift", () => {
    // 90 BPM: a beat is 29400 frames at 44.1 kHz; a 4-beat chord is 117600
    const s = scheduleFrames(build({ chords: "loop" }), SR);
    s.chords.forEach((c, k) => {
      expect(c.startFrame).toBe(k * 117600);
      expect(c.endFrame).toBe((k + 1) * 117600);
    });
    expect(s.totalFrames).toBe(s.chords.length * 117600);
    for (let k = 1; k < s.chords.length; k++) expect(s.chords[k]!.startFrame).toBe(s.chords[k - 1]!.endFrame);
  });

  it("every event frame is the exact conversion of its exact position", () => {
    const ir = build({ rhythm: rhythm("A..x..x.", "arpeggio"), bpm: 100 });
    const s = scheduleFrames(ir, SR);
    const bpm = parseFraction(ir.tempo!.bpm);
    const beat = parseFraction(ir.tempo!.beat);
    const notes = ir.events.filter((e) => e.kind === "note");
    expect(s.events).toHaveLength(notes.length);
    for (const ev of s.events) {
      const src = notes.find((n) => n.id === ev.id)!;
      const start = parseFraction(src.onset);
      expect(ev.startFrame, ev.id).toBe(toSampleFrameExact(start, bpm, SR, beat));
      expect(ev.endFrame, ev.id).toBe(Math.max(ev.startFrame + 1, toSampleFrameExact(fadd(start, parseFraction(src.duration)), bpm, SR, beat)));
    }
    for (let i = 1; i < s.events.length; i++) expect(s.events[i]!.startFrame).toBeGreaterThanOrEqual(s.events[i - 1]!.startFrame);
  });

  it("triplets, quintuplets and septuplets land on exact integer frames (120 BPM, 44.1 kHz: a bar is 88200 frames)", () => {
    const starts = (pattern: string) => {
      const s = scheduleFrames(build({ bpm: 120, rhythm: rhythm(pattern, "arpeggio") }), SR);
      return s.events.filter((e) => e.chordId === s.chords[0]!.id).map((e) => e.startFrame);
    };
    expect(starts("xxxxxxxxxxxx")).toEqual(Array.from({ length: 12 }, (_, i) => i * 7350));
    expect(starts("Axxxx")).toEqual([0, 17640, 35280, 52920, 70560]);
    expect(starts("Axxxxxx")).toEqual(Array.from({ length: 7 }, (_, i) => i * 12600));
    expect(starts("A..x..x.")).toEqual([0, 33075, 66150]);
  });

  it("the second chord's pattern is the first one's shifted by exactly one bar of frames", () => {
    const s = scheduleFrames(build({ bpm: 120, rhythm: rhythm("Axxxx", "arpeggio") }), SR);
    const of = (i: number) => s.events.filter((e) => e.chordId === s.chords[i]!.id).map((e) => e.startFrame);
    expect(of(1)).toEqual(of(0).map((f) => f + 88200));
    expect(of(6)).toEqual(of(0).map((f) => f + 6 * 88200));
  });

  it("scales exactly with tempo and sample rate", () => {
    const ir = build({ rhythm: rhythm("Axxxx", "block") });
    const slow = scheduleFrames(ir, SR, { bpm: 60 });
    const fast = scheduleFrames(ir, SR, { bpm: 120 });
    expect(slow.totalFrames).toBe(2 * fast.totalFrames);
    slow.events.forEach((e, i) => expect(e.startFrame).toBe(2 * fast.events[i]!.startFrame));
    const hi = scheduleFrames(ir, 48000, { bpm: 120 });
    expect(hi.chords[1]!.startFrame).toBe(96000); // 4 beats at 120 BPM = 2 s
  });

  it("uses the document's tempo unless told otherwise, and refuses to guess when there is none", () => {
    const ir = build({ bpm: 80 });
    expect(scheduleFrames(ir, SR).chords[0]!.endFrame).toBe(132300); // 4 × 0.75 s × 44100
    const noTempo = { ...ir, tempo: undefined } as unknown as MusicIR;
    expect(() => scheduleFrames(noTempo, SR)).toThrow(MusicTheoryError);
    expect(scheduleFrames(noTempo, SR, { bpm: 80 }).chords[0]!.endFrame).toBe(132300);
  });
});

describe("asking what is sounding at a frame (what the UI follows)", () => {
  const ir = build({ bpm: 120, rhythm: rhythm("Axxx", "arpeggio") });
  const s = scheduleFrames(ir, SR);

  it("names the chord containing a frame, looping past the end", () => {
    expect(chordIndexAtFrame(s, 0)).toBe(0);
    expect(chordIndexAtFrame(s, 88199)).toBe(0);
    expect(chordIndexAtFrame(s, 88200)).toBe(1);
    expect(chordIndexAtFrame(s, 6 * 88200 + 5)).toBe(6);
    expect(chordIndexAtFrame(s, s.totalFrames)).toBe(0); // wraps to the start
    expect(chordIndexAtFrame(s, s.totalFrames + 88200)).toBe(1);
    expect(chordIndexAtFrame(s, -1)).toBe(6); // and backwards
  });

  it("wrapFrame stays inside the document", () => {
    for (const f of [0, 1, s.totalFrames - 1, s.totalFrames, 5 * s.totalFrames + 7, -3]) {
      const w = wrapFrame(s, f);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(s.totalFrames);
    }
  });

  it("a note is sounding from its first frame up to, not including, its end frame", () => {
    const ev = s.events[1]!; // the second hit of the first chord
    expect(soundingAtFrame(s, ev.startFrame - 1).some((e) => e.id === ev.id)).toBe(false);
    expect(soundingAtFrame(s, ev.startFrame).some((e) => e.id === ev.id)).toBe(true);
    expect(soundingAtFrame(s, ev.endFrame - 1).some((e) => e.id === ev.id)).toBe(true);
    expect(soundingAtFrame(s, ev.endFrame).some((e) => e.id === ev.id)).toBe(false);
  });

  it("in an arpeggio exactly one note sounds at a time, and it is the right voice", () => {
    const voices: string[] = [];
    for (let k = 0; k < 4; k++) {
      const now = soundingAtFrame(s, k * 22050 + 100);
      expect(now).toHaveLength(1);
      voices.push(now[0]!.voice);
    }
    expect(voices).toEqual(["v1", "v2", "v3", "v1"]);
  });
});

describe("rendering: every event starts on its exact sample", () => {
  const base = { sampleRate: SR, wrapTail: false, headroom: 100 };

  it("is silent until the start frame, and sound begins on the very next sample", () => {
    const { samples } = renderEvents([{ startFrame: 1000, endFrame: 5000, midi: 60 }], { ...base, totalFrames: 20000 });
    for (let i = 0; i <= 1000; i++) expect(samples[i], `frame ${i}`).toBe(0);
    expect(firstNonZero(samples)).toBe(1001); // the note fades in from silence at its start frame
  });

  it("moving an event by N frames moves the sound by exactly N frames, sample for sample", () => {
    const render = (start: number) => renderEvents([{ startFrame: start, endFrame: start + 4000, midi: 55 }], { ...base, totalFrames: 30000 }).samples;
    const a = render(1000);
    const b = render(2537);
    for (let i = 0; i < 12000; i++) expect(b[i + 1537]).toBe(a[i]);
  });

  it("two events at known frames sound independently (the mix is their exact sum)", () => {
    const e1: RenderableEvent = { startFrame: 500, endFrame: 4000, midi: 48 };
    const e2: RenderableEvent = { startFrame: 3200, endFrame: 9000, midi: 64 };
    const both = renderEvents([e1, e2], { ...base, totalFrames: 20000 }).samples;
    const one = renderEvents([e1], { ...base, totalFrames: 20000 }).samples;
    const two = renderEvents([e2], { ...base, totalFrames: 20000 }).samples;
    for (let i = 0; i < 20000; i += 7) expect(both[i]).toBeCloseTo(one[i]! + two[i]!, 6);
  });

  it("velocity scales the sound linearly", () => {
    const at = (velocity: number) => renderEvents([{ startFrame: 100, endFrame: 3000, midi: 60, velocity }], { ...base, totalFrames: 10000 }).samples;
    const full = at(0.8);
    const half = at(0.4);
    for (let i = 100; i < 6000; i += 13) expect(half[i]).toBeCloseTo(full[i]! * 0.5, 7);
  });

  it("a note sounds for its notated length, then releases smoothly to exactly zero", () => {
    const sr = SR;
    const release = Math.round(0.08 * sr);
    const note = synthesizePluck(60, { ...PLUCK_TONES.sine, sampleRate: sr, seconds: 3 });
    const { samples } = renderEvents([{ startFrame: 1000, endFrame: 6000, midi: 60 }], { ...base, totalFrames: 40000 });
    // during the notated length the note is untouched
    for (let k = 0; k < 5000; k += 11) expect(samples[1000 + k]).toBeCloseTo(note[k]! * 0.8, 6);
    // then a release, and then nothing at all (the natural ring is cut at the notated length)
    for (let i = 6000 + release; i < 6000 + release + 5000; i += 17) expect(samples[i]).toBe(0);
    // the release itself is a smooth fade, not a cut
    expect(Math.abs(samples[6000 + release - 1]!)).toBeLessThan(Math.abs(samples[6000]!) + 1e-9);
    expect(Math.abs(samples[6000 + Math.round(release / 2)]!)).toBeLessThan(0.9);
  });

  it("is deterministic", () => {
    const evs: RenderableEvent[] = [{ startFrame: 10, endFrame: 3000, midi: 52 }, { startFrame: 900, endFrame: 5000, midi: 59 }];
    const a = renderEvents(evs, { ...base, totalFrames: 12000 }).samples;
    const b = renderEvents(evs, { ...base, totalFrames: 12000 }).samples;
    expect(Array.from(a.subarray(0, 4000))).toEqual(Array.from(b.subarray(0, 4000)));
  });

  it("limits a loud mix to the headroom, and reports what it did", () => {
    const evs: RenderableEvent[] = Array.from({ length: 8 }, () => ({ startFrame: 0, endFrame: 5000, midi: 60, velocity: 1 }));
    const r = renderEvents(evs, { sampleRate: SR, totalFrames: 12000, wrapTail: false, headroom: 0.9 });
    expect(r.peak).toBeGreaterThan(0.9);
    expect(r.gain).toBeLessThan(1);
    let peak = 0;
    for (const v of r.samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it("rejects impossible requests", () => {
    expect(() => renderEvents([], { sampleRate: 0, totalFrames: 10 })).toThrow(MusicTheoryError);
    expect(() => renderEvents([], { sampleRate: SR, totalFrames: 0 })).toThrow(MusicTheoryError);
    expect(() => renderEvents([{ startFrame: 10, endFrame: 10, midi: 60 }], { sampleRate: SR, totalFrames: 100 })).toThrow(MusicTheoryError);
  });
});

describe("looping seamlessly", () => {
  const options = { sampleRate: SR, headroom: 100 };

  it("what rings past the end wraps onto the start", () => {
    const total = 20000;
    const late: RenderableEvent = { startFrame: total - 1000, endFrame: total - 500, midi: 57 };
    const wrapped = renderEvents([late], { ...options, totalFrames: total, wrapTail: true }).samples;
    const straight = renderEvents([late], { ...options, totalFrames: total, wrapTail: false }).samples;
    expect(wrapped).toHaveLength(total);
    expect(straight.length).toBeGreaterThan(total);
    const spill = straight.length - total;
    expect(spill).toBeGreaterThan(1000);
    for (let i = 0; i < spill; i += 3) expect(wrapped[i]).toBeCloseTo(straight[total + i]! + (i < total - 1000 ? 0 : 0), 6);
    // nothing is lost or invented: the wrapped loop contains exactly the same total signal
    const sum = (x: Float32Array) => x.reduce((a, b) => a + b, 0);
    expect(sum(wrapped)).toBeCloseTo(sum(straight), 3);
  });

  it("a looped render equals the second lap of the music played twice in a row, sample for sample", () => {
    const ir = build({ chords: 3, bpm: 140, rhythm: rhythm("A..x..x.", "arpeggio") });
    const s = scheduleFrames(ir, SR);
    const loop = renderEvents(s.events, { ...options, totalFrames: s.totalFrames, wrapTail: true }).samples;
    const twice = renderEvents(
      [...s.events, ...s.events.map((e) => ({ ...e, startFrame: e.startFrame + s.totalFrames, endFrame: e.endFrame + s.totalFrames }))],
      { ...options, totalFrames: 2 * s.totalFrames, wrapTail: false },
    ).samples;
    expect(loop).toHaveLength(s.totalFrames);
    let worst = 0;
    for (let i = 0; i < s.totalFrames; i++) worst = Math.max(worst, Math.abs(loop[i]! - twice[s.totalFrames + i]!));
    expect(worst).toBeLessThan(1e-5);
  });
});

describe("a whole document, rendered", () => {
  it("is as long as the document, silent before its first hit, and starts exactly on it", () => {
    const ir = build({ bpm: 90, rhythm: rhythm(".x..", "block") }); // first hit a quarter of a chord in: 29400 frames
    // (no wrap: with a looping buffer the start carries the end's ring-out, tested separately)
    const r = renderDocument(ir, { sampleRate: SR, wrapTail: false });
    expect(r.samples.length).toBeGreaterThanOrEqual(r.schedule.totalFrames);
    const first = r.schedule.events[0]!;
    expect(first.startFrame).toBe(29400);
    let loud = 0;
    for (let i = 0; i <= 29400; i++) if (r.samples[i] !== 0) loud++;
    expect(loud).toBe(0);
    expect(firstNonZero(r.samples)).toBe(29401);
  });

  it("a looping render carries the last chord's ring-out onto the first frames (that is what makes the loop seamless)", () => {
    const ir = build({ bpm: 90, chords: 2, rhythm: rhythm("xxxx", "block") });
    const looped = renderDocument(ir, { sampleRate: SR, wrapTail: true });
    const straight = renderDocument(ir, { sampleRate: SR, wrapTail: false });
    expect(firstNonZero(straight.samples)).toBe(1); // nothing before the first note
    expect(Math.abs(looped.samples[0]!)).toBeGreaterThan(0); // but the loop already has the tail of the end
  });

  it("every voice's note in a block hit begins on the same frame", () => {
    const r = renderDocument(build({ rhythm: rhythm("Axxx", "block") }), { sampleRate: SR });
    const firstHit = r.schedule.events.filter((e) => e.chordId === r.schedule.chords[0]!.id && e.startFrame === 0);
    expect(firstHit).toHaveLength(3);
  });

  it("renders every cycle's loop without clipping or non-finite values", () => {
    const r = renderDocument(build({ chords: "loop", rhythm: rhythm("A..x..x.", "bass-chord") }), { sampleRate: SR });
    let peak = 0;
    let bad = 0;
    for (const v of r.samples) {
      if (!Number.isFinite(v)) bad++;
      peak = Math.max(peak, Math.abs(v));
    }
    expect(bad).toBe(0); // (one assertion: asserting per sample over 2.4 million samples takes a minute)
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(peak).toBeGreaterThan(0.2);
  });

  it("the tone is selectable", () => {
    const ir = build({ rhythm: rhythm("Axxx", "block") });
    const sine = renderDocument(ir, { sampleRate: SR });
    const bright = renderDocument(ir, { sampleRate: SR, tone: PLUCK_TONES.bright });
    expect(Array.from(sine.samples.subarray(5000, 5100))).not.toEqual(Array.from(bright.samples.subarray(5000, 5100)));
    // a string tone really is rendered as a string, not as a sine wearing its settings
    const explicit = renderDocument(ir, { sampleRate: SR, tone: { ...PLUCK_TONES.bright } });
    expect(Array.from(explicit.samples.subarray(5000, 5100))).toEqual(Array.from(bright.samples.subarray(5000, 5100)));
    const defaulted = renderDocument(ir, { sampleRate: SR, tone: PLUCK_TONES.sine });
    expect(Array.from(defaulted.samples.subarray(5000, 5100))).toEqual(Array.from(sine.samples.subarray(5000, 5100)));
  });

  it("frac is exported alongside (smoke check of the public API surface used by the app)", () => {
    expect(frac(1, 4)).toEqual({ num: 1, den: 4 });
  });
});
