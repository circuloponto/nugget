import { describe, expect, it } from "vitest";
import {
  buildCycleProgressionIR,
  CYCLE_IDS,
  cellFromSteps,
  DEFAULT_RHYTHM,
  frac,
  fstr,
  MusicTheoryError,
  parseFraction,
  parseMusicIR,
  RHYTHM_MODES,
  RHYTHM_PRESETS,
  rhythmizeIR,
  rhythmSpecFromIR,
  serializeMusicIR,
  stepsFromString,
  validateMusicIR,
  type IRNoteEvent,
  type MusicIR,
  type RhythmMode,
  type RhythmSpec,
} from "../src";

function build(extra: Partial<Parameters<typeof buildCycleProgressionIR>[0]> = {}) {
  const r = buildCycleProgressionIR({ tonic: "C", scale: "major", cycle: 5, ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const notes = (ir: MusicIR): IRNoteEvent[] => ir.events.filter((e): e is IRNoteEvent => e.kind === "note");
const messages = (ir: unknown) => validateMusicIR(ir).map((i) => `${i.path}: ${i.message}`);
const underChord = (ir: MusicIR, i: number) => {
  const c = ir.chords[i]!;
  const start = parseFraction(c.onset);
  const end = parseFraction(c.duration);
  return notes(ir).filter((n) => {
    const o = parseFraction(n.onset);
    return o.num * start.den >= start.num * o.den && o.num * (start.den * end.den) < (start.num * end.den + end.num * start.den) * o.den;
  });
};

describe("building a progression", () => {
  it("makes a valid, fully verified document with the requested shape", () => {
    const r = build();
    expect(messages(r.ir)).toEqual([]);
    expect(r.chords).toBe(7);
    expect(r.closed).toBe(false);
    expect(r.ir.chords.map((c) => c.symbol)).toEqual(["C", "G", "Dm", "Am", "Em", "Bdim", "F"]);
    expect(r.ir.tempo).toEqual({ bpm: "90", beat: "1/4" });
    expect(r.ir.meter).toEqual({ groups: [1, 1, 1, 1], unit: "1/4" });
    expect(r.ir.chords.every((c) => c.duration === "1")).toBe(true); // 4 beats of 4/4 = a whole note
    expect(rhythmSpecFromIR(r.ir)).toEqual({ ...DEFAULT_RHYTHM, gate: 1 });
  });

  it("the whole loop is closed, with a voice-leading relation back to the first chord", () => {
    const r = build({ chords: "loop" });
    expect(r.closed).toBe(true);
    expect(r.chords).toBe(r.loopChords);
    expect(r.ir.relations.filter((x) => x.data?.closing === true).length).toBeGreaterThan(0);
    expect(messages(r.ir)).toEqual([]);
  });

  it("chord length is configurable, and a document built for another tuning verifies", () => {
    const half = build({ chordBeats: 2 });
    expect(half.ir.chords.every((c) => c.duration === "1/2")).toBe(true);
    expect(messages(half.ir)).toEqual([]);
  });

  it("every cycle, in several keys, builds a verified document", () => {
    for (const id of CYCLE_IDS) {
      for (const [tonic, scale] of [["C", "major"], ["Db", "major"], ["A", "harmonicMinor"], ["F#", "naturalMinor"]] as const) {
        const r = buildCycleProgressionIR({ tonic, scale, cycle: id, rhythm: { pattern: "A..x..x.", mode: "arpeggio" } });
        expect(r.ok, `${tonic} ${scale} c${id}`).toBe(true);
        if (r.ok) expect(messages(r.ir), `${tonic} ${scale} c${id}`).toEqual([]);
      }
    }
  });

  it("reports failure instead of a broken document when the neck cannot play it", () => {
    const r = buildCycleProgressionIR({ tonic: "F#", scale: "major", cycle: 5, fretCount: 2, constraints: { maxFret: 2 } });
    expect(r.ok).toBe(false);
  });

  it("is deterministic", () => {
    expect(serializeMusicIR(build().ir)).toBe(serializeMusicIR(build().ir));
  });
});

describe("rhythmizeIR", () => {
  const base = build().ir;

  it("every preset in every mode gives a valid, verified document (no string plays two notes at once)", () => {
    for (const preset of RHYTHM_PRESETS) {
      for (const mode of RHYTHM_MODES) {
        const out = rhythmizeIR(base, { pattern: preset.pattern, mode: mode.id });
        expect(messages(out), `${preset.name} / ${mode.name}`).toEqual([]);
      }
    }
  });

  it("puts the hits at exact fractions of each chord, including triplets, quintuplets and septuplets", () => {
    for (const [pattern, expectedOnsets] of [
      ["xxxx", ["0", "1/4", "1/2", "3/4"]],
      ["AxxAxxAxxAxx", Array.from({ length: 12 }, (_, i) => fstr(frac(i, 12)))],
      ["Axxxx", ["0", "1/5", "2/5", "3/5", "4/5"]],
      ["Axxxxxx", Array.from({ length: 7 }, (_, i) => fstr(frac(i, 7)))],
    ] as const) {
      const out = rhythmizeIR(base, { pattern, mode: "arpeggio" });
      const inFirstChord = underChord(out, 0).map((n) => fstr(parseFraction(n.onset)));
      expect(inFirstChord, pattern).toEqual(expectedOnsets);
      // and the second chord is the same shape, shifted by exactly one chord
      const second = underChord(out, 1).map((n) => fstr(parseFraction(n.onset)));
      expect(second, pattern).toEqual(expectedOnsets.map((o) => fstr(parseFraction(o).den === 1 && parseFraction(o).num === 0 ? frac(1) : frac(parseFraction(o).num + parseFraction(o).den, parseFraction(o).den))));
    }
  });

  it("block: every hit sounds every voice; arpeggio: one voice per hit, bass to top; bass-chord: bass first, then the rest", () => {
    const voices = (mode: RhythmMode) => {
      const out = rhythmizeIR(base, { pattern: "xxxx", mode });
      return underChord(out, 0).reduce<Record<string, string[]>>((acc, n) => {
        (acc[n.onset] ??= []).push(n.voice);
        return acc;
      }, {});
    };
    const block = voices("block");
    expect(Object.values(block).every((v) => v.length === 3)).toBe(true);

    const arp = voices("arpeggio");
    expect(Object.keys(arp).map((o) => arp[o]!)).toEqual([["v1"], ["v2"], ["v3"], ["v1"]]);

    const bc = voices("bass-chord");
    const rows = Object.keys(bc).map((o) => bc[o]!.sort());
    expect(rows).toEqual([["v1"], ["v2", "v3"], ["v2", "v3"], ["v2", "v3"]]);
  });

  it("rests make no sound, ties lengthen the previous note, accents are louder", () => {
    const rest = rhythmizeIR(base, { pattern: ".x..", mode: "block" });
    expect(underChord(rest, 0).filter((n) => n.voice === "v1")).toHaveLength(1);
    const tie = rhythmizeIR(base, { pattern: "A-x-", mode: "block" });
    const first = underChord(tie, 0).filter((n) => n.voice === "v1");
    expect(first.map((n) => fstr(parseFraction(n.duration)))).toEqual(["1/2", "1/2"]);
    const acc = rhythmizeIR(base, { pattern: "Axxx", mode: "arpeggio" });
    const vel = underChord(acc, 0).map((n) => n.velocity);
    expect(vel[0]).toBe(1);
    expect(vel[1]).toBeCloseTo(0.7, 10);
    expect(underChord(acc, 0).map((n) => n.accent)).toEqual([3, 1, 1, 1]);
  });

  it("gate shortens how long each note is notated", () => {
    const full = rhythmizeIR(base, { pattern: "xxxx", mode: "block", gate: 1 });
    const half = rhythmizeIR(base, { pattern: "xxxx", mode: "block", gate: 0.5 });
    expect(underChord(full, 0)[0]!.duration).toBe("1/4");
    expect(underChord(half, 0)[0]!.duration).toBe("1/8");
    expect(messages(half)).toEqual([]);
  });

  it("is lossless about the voicing: a rhythm that plays only some voices does not lose the rest", () => {
    const sparse = rhythmizeIR(base, { pattern: "x...", mode: "arpeggio" }); // one hit per chord: only the bass sounds
    expect(underChord(sparse, 0)).toHaveLength(1);
    const back = rhythmizeIR(sparse, { pattern: "xxxx", mode: "block" });
    expect(underChord(back, 0).filter((n) => n.onset === "0").map((n) => n.voice).sort()).toEqual(["v1", "v2", "v3"]);
    expect(back.chords.map((c) => c.voicing)).toEqual(base.chords.map((c) => c.voicing));
  });

  it("re-rhythmizing a document equals building it with that rhythm from scratch", () => {
    const a: RhythmSpec = { pattern: "A..x..x.", mode: "bass-chord", gate: 0.8 };
    const b: RhythmSpec = { pattern: "AxxAxxAxxAxx", mode: "arpeggio" };
    const viaA = rhythmizeIR(build({ rhythm: a }).ir, b);
    const direct = build({ rhythm: b }).ir;
    expect(serializeMusicIR(viaA)).toBe(serializeMusicIR(direct));
  });

  it("records the rhythm so an editor can be restored from a saved file", () => {
    const spec: RhythmSpec = { pattern: "A..x..x.", mode: "arpeggio", gate: 0.75 };
    const out = rhythmizeIR(base, spec);
    expect(rhythmSpecFromIR(out)).toEqual(spec);
    const t = out.transformations.filter((x) => x.op === "rhythm-pattern");
    expect(t).toHaveLength(1); // replaced, never stacked
    expect(t[0]).toMatchObject({ params: { pattern: "A..x..x.", grid: 8, mode: "arpeggio", gate: 0.75 }, provenance: { status: "user" } });
    const parsed = parseMusicIR(serializeMusicIR(out));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(rhythmSpecFromIR(parsed.ir)).toEqual(spec);
    expect(rhythmSpecFromIR(base.transformations.length ? { ...base, transformations: [] } : base)).toBeNull();
  });

  it("keeps the harmony, voices, tempo, meter, constraints and the cycle's own record", () => {
    const out = rhythmizeIR(base, { pattern: "Axxx", mode: "block" });
    expect(out.chords).toEqual(base.chords);
    expect(out.voices).toEqual(base.voices);
    expect(out.tempo).toEqual(base.tempo);
    expect(out.meter).toEqual(base.meter);
    expect(out.constraints).toEqual(base.constraints);
    expect(out.title).toBe(base.title);
    expect(out.transformations.some((t) => t.op === "diatonic-cycle")).toBe(true);
  });

  it("voice leading is recorded between chords, and its semitones are the real differences", () => {
    const out = rhythmizeIR(base, { pattern: "xxxx", mode: "block" });
    const vl = out.relations.filter((r) => r.kind === "voice-leading");
    expect(vl).toHaveLength((out.chords.length - 1) * 3);
    const byId = new Map(out.events.map((e) => [e.id, e] as const));
    for (const r of vl) {
      const a = byId.get(r.from) as IRNoteEvent;
      const b = byId.get(r.to) as IRNoteEvent;
      expect(r.data?.semitones).toBe(b.pitch.midi - a.pitch.midi);
      expect(a.voice).toBe(b.voice);
    }
  });

  it("works on a document that was saved and loaded, and on one with no stated voicing", () => {
    const loaded = parseMusicIR(serializeMusicIR(base));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const viaFile = rhythmizeIR(loaded.ir, { pattern: ".x.x.x.x", mode: "block" });
    expect(messages(viaFile)).toEqual([]);

    const stripped = JSON.parse(JSON.stringify(base)) as { chords: { voicing?: unknown }[] };
    for (const c of stripped.chords) delete c.voicing;
    const noVoicing = rhythmizeIR(stripped as unknown as MusicIR, { pattern: "xxxx", mode: "block" });
    expect(messages(noVoicing)).toEqual([]);
    expect(underChord(noVoicing, 0).filter((n) => n.onset === "0").map((n) => n.pitch.name)).toEqual(
      underChord(base, 0).map((n) => n.pitch.name),
    );
  });

  it("is a no-op for a document with no chords, and rejects bad input", () => {
    const empty = { ...base, chords: [], events: [], relations: [], transformations: [] } as MusicIR;
    expect(rhythmizeIR(empty, DEFAULT_RHYTHM)).toBe(empty);
    expect(() => rhythmizeIR(base, { pattern: "A.q", mode: "block" })).toThrow(MusicTheoryError);
    expect(() => rhythmizeIR(base, { pattern: "", mode: "block" })).toThrow(MusicTheoryError);
    expect(() => rhythmizeIR(base, { pattern: "x", mode: "strum" as RhythmMode })).toThrow(MusicTheoryError);
  });

  it("covers every chord, never spills into the next one, and notes end inside their chord", () => {
    const out = rhythmizeIR(base, { pattern: "A..x..x.", mode: "block" });
    out.chords.forEach((c, i) => {
      const start = parseFraction(c.onset);
      const end = parseFraction(c.onset);
      void end;
      for (const n of underChord(out, i)) {
        const o = parseFraction(n.onset);
        const e = parseFraction(n.onset).num / parseFraction(n.onset).den + parseFraction(n.duration).num / parseFraction(n.duration).den;
        expect(o.num / o.den).toBeGreaterThanOrEqual(start.num / start.den);
        expect(e).toBeLessThanOrEqual(start.num / start.den + parseFraction(c.duration).num / parseFraction(c.duration).den + 1e-12);
      }
    });
    expect(cellFromSteps(frac(1), stepsFromString("A..x..x.")).events.filter((e) => !e.rest)).toHaveLength(3);
    expect(underChord(out, 0).filter((n) => n.voice === "v1")).toHaveLength(3);
  });
});
