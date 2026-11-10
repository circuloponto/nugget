import { describe, expect, it } from "vitest";
import {
  buildScale,
  chordTimeline,
  closeVoicing,
  CYCLE_IDS,
  cyclePlanToIR,
  cycleToIR,
  formatPitch,
  frac,
  fstr,
  generateCycle,
  irChordPitches,
  irEnd,
  makeFretboard,
  midi,
  MUSIC_IR_VERSION,
  normalizeMusicIR,
  openStringMidi,
  parseFraction,
  parseMusicIR,
  planCycleOnGuitar,
  planPerfectCycleLoop,
  realizeVoicing,
  scheduleFromIR,
  serializeMusicIR,
  STANDARD_TUNING,
  triadVoicingToIR,
  validateMusicIR,
  withDefaults,
  type IRNoteEvent,
  type MusicIR,
} from "../src";

const fb = makeFretboard(STANDARD_TUNING, 22);
const C = withDefaults();
const cMajor = buildScale("C", "major");

/** A small valid document to mutate in the negative tests. */
function base(): MusicIR {
  return JSON.parse(JSON.stringify(triadVoicingToIR(closeVoicing(cMajor, 1, 0, 3), { key: cMajor, tempo: { bpm: 120 } })));
}
const messages = (ir: unknown) => validateMusicIR(ir).map((i) => `${i.path}: ${i.message}`);

describe("MusicIR from the harmonic engine", () => {
  it("a triad voicing becomes a valid document with exact pitches, roles and chord annotation", () => {
    const v = closeVoicing(cMajor, 1, 1, 3); // C major, first inversion: E3 G3 C4
    const ir = triadVoicingToIR(v, { key: cMajor });
    expect(validateMusicIR(ir)).toEqual([]);
    expect(ir.version).toBe(MUSIC_IR_VERSION);
    const notes = ir.events.filter((e): e is IRNoteEvent => e.kind === "note");
    expect(notes.map((n) => n.pitch.name)).toEqual(["E3", "G3", "C4"]);
    expect(notes.map((n) => n.pitch.midi)).toEqual(v.pitches.map(midi));
    expect(notes.map((n) => n.roles?.harmonic)).toEqual(["third", "fifth", "root"]);
    expect(ir.chords[0]).toMatchObject({ symbol: "C", roman: "I", quality: "major", root: "C", tones: ["C", "E", "G"], inversion: 1 });
    expect(ir.voices.map((x) => x.role)).toEqual(["bass", "inner", "upper"]);
  });

  it("spelling survives: F# major's E#m-type chords and G# harmonic minor's F## keep their names", () => {
    const gs = buildScale("G#", "harmonicMinor");
    const v = closeVoicing(gs, 7, 0, 3); // F##dim
    const ir = triadVoicingToIR(v, { key: gs });
    expect(validateMusicIR(ir)).toEqual([]);
    expect(ir.chords[0]!.tones).toEqual(["F##", "A#", "C#"]);
    expect(ir.events.map((e) => (e.kind === "note" ? e.pitch.name : ""))).toEqual(v.pitches.map(formatPitch));
  });

  it("a guitar realization is recorded as string/fret and reproduces the same sounding pitches", () => {
    const v = closeVoicing(cMajor, 1, 0, 3);
    const guitar = realizeVoicing(v, fb, C)[0]!;
    const ir = triadVoicingToIR(v, { key: cMajor, guitar, tuning: STANDARD_TUNING });
    expect(validateMusicIR(ir)).toEqual([]);
    for (const e of ir.events) {
      if (e.kind !== "note") continue;
      expect(e.instrument).toBeDefined();
      expect(openStringMidi(fb, e.instrument!.string) + e.instrument!.fret).toBe(e.pitch.midi);
    }
    expect(ir.voices[0]!.instrument?.tuning).toEqual(["E2", "A2", "D3", "G3", "B3", "E4"]);
  });

  it("every cycle's perfect loop maps to a valid document that reads back to the engine's own pitches", () => {
    for (const id of CYCLE_IDS) {
      for (const [tonic, type] of [["C", "major"], ["F#", "major"], ["A", "harmonicMinor"], ["Eb", "naturalMinor"]] as const) {
        const scale = buildScale(tonic, type);
        const plan = planPerfectCycleLoop(scale, id, fb);
        expect(plan.path.ok).toBe(true);
        const ir = cyclePlanToIR(scale, id, plan, { tuning: STANDARD_TUNING, constraints: C });
        const ctx = `${tonic} ${type} c${id}`;
        expect(validateMusicIR(ir), ctx).toEqual([]);
        expect(ir.chords).toHaveLength(plan.length);
        expect(ir.events).toHaveLength(plan.length * 3);
        if (!plan.path.ok) continue;
        plan.path.steps.forEach((s, i) => {
          // compatibility: the IR gives back exactly the voicing the harmonic engine played
          const back = irChordPitches(ir, `chord-${i}`);
          expect(back.map(formatPitch), `${ctx} chord ${i}`).toEqual(s.voicing.pitches.map(formatPitch));
          expect(back.map(midi)).toEqual(s.guitar.notes.map((n) => n.midi));
        });
      }
    }
  });

  it("records voice leading between chords, including the closing move of a loop", () => {
    const plan = planPerfectCycleLoop(cMajor, 5, fb);
    const ir = cyclePlanToIR(cMajor, 5, plan, { constraints: C, tuning: STANDARD_TUNING });
    const vl = ir.relations.filter((r) => r.kind === "voice-leading");
    expect(vl).toHaveLength(3 * (plan.length - 1) + 3); // between chords, plus 3 closing
    expect(vl.filter((r) => r.data?.closing === true)).toHaveLength(3);
    const byId = new Map(ir.events.map((e) => [e.id, e] as const));
    for (const r of vl) {
      const a = byId.get(r.from) as IRNoteEvent;
      const b = byId.get(r.to) as IRNoteEvent;
      expect(r.data?.semitones).toBe(b.pitch.midi - a.pitch.midi);
      expect(a.voice).toBe(b.voice); // voice identity is preserved
    }
  });

  it("documents the producing transformation and the (approximate) playability constraint", () => {
    const plan = planCycleOnGuitar(cMajor, 5, fb, { length: 7 });
    const ir = cyclePlanToIR(cMajor, 5, plan, { constraints: C, tuning: STANDARD_TUNING });
    expect(ir.transformations[0]).toMatchObject({ op: "diatonic-cycle", params: { cycle: 5, key: "C major", chords: 7 } });
    expect(ir.transformations[0]!.outputs).toEqual(ir.chords.map((c) => c.id));
    expect(ir.transformations[0]!.provenance.status).toBe("generated");
    const c = ir.constraints[0]!;
    expect(c.kind).toBe("guitar-playability");
    expect(c.params.maxFretSpan).toBe(C.maxFretSpan);
    expect(c.note).toMatch(/approximation/i);
    expect(c.note).toMatch(/not a guarantee/i);
  });

  it("falls back to the theoretical voicings when a plan failed, and still validates", () => {
    const tiny = makeFretboard(STANDARD_TUNING, 2);
    const plan = planCycleOnGuitar(cMajor, 5, tiny, { length: 4, constraints: { maxFret: 2 }, octaveShift: "none" });
    expect(plan.path.ok).toBe(false);
    const ir = cyclePlanToIR(cMajor, 5, plan);
    expect(validateMusicIR(ir)).toEqual([]);
    expect(ir.events.every((e) => e.kind === "rest" || e.instrument === undefined)).toBe(true);
    expect(ir.constraints).toEqual([]);
  });
});

describe("exact time inside the document", () => {
  it("chord segments tile the timeline with exact fractions", () => {
    const steps = generateCycle(cMajor, 5, { length: 7 }).map((s) => ({ voicing: s.voicing }));
    const dotted = frac(3, 8);
    const ir = cycleToIR(cMajor, 5, steps, { chordDuration: dotted });
    expect(validateMusicIR(ir)).toEqual([]);
    expect(ir.chords.map((c) => c.onset)).toEqual(["0", "3/8", "3/4", "9/8", "3/2", "15/8", "9/4"]);
    expect(ir.chords.every((c) => c.duration === "3/8")).toBe(true);
    expect(fstr(irEnd(ir))).toBe("21/8");
  });

  it("scheduling converts to seconds through the temporal engine", () => {
    const steps = generateCycle(cMajor, 5, { length: 4 }).map((s) => ({ voicing: s.voicing }));
    const ir = cycleToIR(cMajor, 5, steps, { tempo: { bpm: 120 } });
    const sched = scheduleFromIR(ir);
    expect(sched).toHaveLength(12);
    expect(sched.map((n) => n.start)).toEqual([0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1.5, 1.5, 1.5]);
    expect(sched.every((n) => n.duration === 0.5)).toBe(true);
    expect(chordTimeline(ir).map((c) => c.start)).toEqual([0, 0.5, 1, 1.5]);
    // an explicit tempo overrides the document's
    expect(scheduleFromIR(ir, { bpm: 60 }).at(-1)!.start).toBe(3);
    // no tempo anywhere is an error, not a guess
    const noTempo = cycleToIR(cMajor, 5, steps);
    expect(() => scheduleFromIR(noTempo)).toThrow();
  });

  it("a triplet-subdivided timeline stays exact (three notes in a quarter)", () => {
    const ir = base();
    const third = frac(1, 12);
    const events = [0, 1, 2].map((i) => ({
      id: `t${i}`,
      kind: "note" as const,
      voice: "v1",
      pitch: { name: "C3", midi: 48 }, roles: { harmonic: "root" },
      onset: fstr(frac(i, 12)),
      duration: fstr(third),
    }));
    const doc: MusicIR = normalizeMusicIR({ ...ir, events: [...ir.events.filter((e) => e.voice !== "v1"), ...events] });
    expect(messages(doc)).toEqual([]);
    expect(fstr(irEnd({ ...doc, events: events }))).toBe("1/4");
  });
});

describe("validation", () => {
  it("accepts a good document and rejects non-objects", () => {
    expect(messages(base())).toEqual([]);
    expect(messages(null).length).toBeGreaterThan(0);
    expect(messages("hello").length).toBeGreaterThan(0);
    expect(messages([]).length).toBeGreaterThan(0);
  });

  it("rejects the wrong version", () => {
    expect(messages({ ...base(), version: 2 }).join()).toMatch(/unsupported version/);
  });

  it("rejects duplicate ids anywhere in the document", () => {
    const ir = base();
    const dup = { ...ir, events: [...ir.events, { ...ir.events[0]! }] };
    expect(messages(dup).join()).toMatch(/duplicate id/);
    const dup2 = { ...ir, chords: [{ ...ir.chords[0]!, id: ir.voices[0]!.id }] };
    expect(messages(dup2).join()).toMatch(/duplicate id/);
  });

  it("rejects unknown voices, bad times and inconsistent pitches", () => {
    const ir = base();
    const note = ir.events[0] as IRNoteEvent;
    const swap = (patch: Partial<IRNoteEvent>): MusicIR => ({ ...ir, events: [{ ...note, ...patch }, ...ir.events.slice(1)] });
    expect(messages(swap({ voice: "nope" })).join()).toMatch(/unknown voice/);
    expect(messages(swap({ onset: "-1/4" })).join()).toMatch(/negative/);
    expect(messages(swap({ duration: "0" })).join()).toMatch(/positive/);
    expect(messages(swap({ onset: "0.25" })).join()).toMatch(/exact fraction/);
    expect(messages(swap({ duration: "1/0" as string })).join()).toMatch(/exact fraction/);
    expect(messages(swap({ pitch: { name: "C3", midi: 61 } })).join()).toMatch(/is MIDI 48/);
    expect(messages(swap({ pitch: { name: "H3", midi: 50 } })).join()).toMatch(/Invalid pitch/);
    expect(messages(swap({ velocity: 1.5 })).join()).toMatch(/velocity/);
    expect(messages(swap({ instrument: { string: 1.5, fret: -1 } })).join()).toMatch(/instrument/);
  });

  it("enforces canonical event order, and normalizeMusicIR fixes it", () => {
    const plan = planCycleOnGuitar(cMajor, 5, fb, { length: 3 });
    const ir = cyclePlanToIR(cMajor, 5, plan);
    const shuffled: MusicIR = { ...ir, events: [...ir.events].reverse() };
    expect(messages(shuffled).join()).toMatch(/canonical order/);
    expect(validateMusicIR(normalizeMusicIR(shuffled))).toEqual([]);
    expect(normalizeMusicIR(shuffled).events).toEqual(ir.events);
  });

  it("a single-line voice cannot overlap itself, but a polyphonic voice can", () => {
    const ir = base();
    const mk = (id: string, onset: string): IRNoteEvent => ({
      id, kind: "note", voice: "v1", pitch: { name: "C4", midi: 60 }, onset, duration: "1/2",
    });
    const overlapping: MusicIR = { ...ir, events: [mk("a", "1"), mk("b", "5/4")] };
    expect(messages(overlapping).join()).toMatch(/overlaps/);
    const poly: MusicIR = { ...overlapping, voices: ir.voices.map((v) => (v.id === "v1" ? { ...v, polyphonic: true } : v)) };
    expect(messages(poly)).toEqual([]);
  });

  it("chord segments must be sorted, positive and non-overlapping", () => {
    const ir = base();
    const c = ir.chords[0]!;
    expect(messages({ ...ir, chords: [c, { ...c, id: "c2", onset: "1/8" }] }).join()).toMatch(/must not overlap/);
    expect(messages({ ...ir, chords: [{ ...c, duration: "0" }] }).join()).toMatch(/positive/);
    expect(messages({ ...ir, chords: [{ ...c, tones: [] }] }).join()).toMatch(/chord tones/);
  });

  it("relations and transformations may only reference things that exist", () => {
    const ir = base();
    const rel = { id: "r", kind: "voice-leading" as const, from: ir.events[0]!.id, to: "ghost" };
    expect(messages({ ...ir, relations: [rel] }).join()).toMatch(/unknown id "ghost"/);
    const t = { id: "t", op: "x", params: {}, outputs: ["ghost"], provenance: { status: "generated" as const } };
    expect(messages({ ...ir, transformations: [t] }).join()).toMatch(/unknown id "ghost"/);
    expect(messages({ ...ir, transformations: [{ ...t, outputs: [], provenance: { status: "bogus" } }] }).join()).toMatch(/provenance/);
  });

  it("validates tempo and meter", () => {
    const ir = base();
    expect(messages({ ...ir, tempo: { bpm: "0", beat: "1/4" } }).join()).toMatch(/tempo.bpm/);
    expect(messages({ ...ir, tempo: { bpm: "90", beat: "x" } }).join()).toMatch(/tempo.beat/);
    expect(messages({ ...ir, tempo: { bpm: "400/3", beat: "1/4" } })).toEqual([]);
    expect(messages({ ...ir, meter: { groups: [2, 2, 3], unit: "1/8" } })).toEqual([]);
    expect(messages({ ...ir, meter: { groups: [], unit: "1/8" } }).join()).toMatch(/meter.groups/);
  });

  it("reports every problem at once, with paths, never throwing", () => {
    const issues = validateMusicIR({ version: 9, id: "", voices: "no", events: [], chords: [], relations: [], constraints: [], transformations: [] });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.every((i) => typeof i.path === "string" && i.message.length > 0)).toBe(true);
  });
});

describe("serialization", () => {
  it("round-trips losslessly through canonical JSON", () => {
    const plan = planPerfectCycleLoop(buildScale("Db", "major"), 6, fb);
    const ir = cyclePlanToIR(buildScale("Db", "major"), 6, plan, { tuning: STANDARD_TUNING, constraints: C, tempo: { bpm: 90 } });
    const text = serializeMusicIR(ir);
    const back = parseMusicIR(text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.ir).toEqual(normalizeMusicIR(ir));
      expect(serializeMusicIR(back.ir)).toBe(text); // stable text
    }
  });

  it("serializes the same input to byte-identical text (deterministic)", () => {
    const make = () => {
      const plan = planPerfectCycleLoop(cMajor, 5, fb);
      return serializeMusicIR(cyclePlanToIR(cMajor, 5, plan, { tuning: STANDARD_TUNING, constraints: C }));
    };
    expect(make()).toBe(make());
  });

  it("contains no floating point times: every onset and duration is an exact fraction string", () => {
    const plan = planPerfectCycleLoop(cMajor, 3, fb);
    const ir = cyclePlanToIR(cMajor, 3, plan, { chordDuration: frac(1, 6) });
    for (const e of [...ir.events, ...ir.chords]) {
      expect(typeof e.onset).toBe("string");
      expect(typeof e.duration).toBe("string");
      expect(() => parseFraction(e.onset)).not.toThrow();
      expect(() => parseFraction(e.duration)).not.toThrow();
    }
  });

  it("parseMusicIR reports bad JSON and invalid documents instead of throwing", () => {
    const notJson = parseMusicIR("{ nope");
    expect(notJson.ok).toBe(false);
    const invalid = parseMusicIR(JSON.stringify({ version: 1 }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues.length).toBeGreaterThan(0);
  });
});
