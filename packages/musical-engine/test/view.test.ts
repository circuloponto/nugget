import { describe, expect, it } from "vitest";
import {
  buildCycleProgressionIR,
  chordViewAtFrame,
  irTuning,
  MusicTheoryError,
  parseMusicIR,
  requirePositions,
  scheduleFrames,
  serializeMusicIR,
  soundingAtFrame,
  voiceOrder,
  type MusicIR,
  type RhythmSpec,
} from "../src";

const SR = 44100;
function build(rhythm: RhythmSpec, extra = {}): MusicIR {
  const r = buildCycleProgressionIR({ tonic: "C", scale: "major", cycle: 5, bpm: 120, rhythm, ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r.ir;
}

describe("the chord and fretted notes at a moment", () => {
  const ir = build({ pattern: "Axxx", mode: "arpeggio" });
  const s = scheduleFrames(ir, SR);

  it("names the chord and lists its voices lowest first, with where each is played", () => {
    const v = chordViewAtFrame(ir, s, 100)!;
    expect(v.index).toBe(0);
    expect(v.chord.symbol).toBe("C");
    expect(v.positions).toHaveLength(3);
    expect(v.positions.map((p) => p.midi)).toEqual([...v.positions.map((p) => p.midi)].sort((a, b) => a - b));
    expect(v.positions.map((p) => p.role)).toEqual(["root", "third", "fifth"]);
    requirePositions(v); // every voice has a string and fret
    // the fret really produces the pitch under the document's tuning
    const open = irTuning(ir)!;
    expect(open).toEqual(["E2", "A2", "D3", "G3", "B3", "E4"]);
  });

  it("marks exactly the voices that are sounding at that frame, following the arpeggio", () => {
    const sounding = (frame: number) => chordViewAtFrame(ir, s, frame)!.positions.filter((p) => p.sounding).map((p) => p.voice);
    expect(sounding(100)).toEqual(["v1"]);
    expect(sounding(22050 + 100)).toEqual(["v2"]);
    expect(sounding(2 * 22050 + 100)).toEqual(["v3"]);
    expect(sounding(3 * 22050 + 100)).toEqual(["v1"]);
  });

  it("agrees, at every frame we try, with the schedule's own answer", () => {
    for (let f = 0; f < s.totalFrames; f += 9973) {
      const v = chordViewAtFrame(ir, s, f)!;
      const fromSchedule = new Set(soundingAtFrame(s, f).map((e) => `${e.voice}|${e.midi}`));
      for (const p of v.positions) expect(p.sounding, `frame ${f} ${p.pitch}`).toBe(fromSchedule.has(`${p.voice}|${p.midi}`));
    }
  });

  it("follows the playhead into later chords and around the loop", () => {
    expect(chordViewAtFrame(ir, s, 88200 * 2 + 5)!.chord.symbol).toBe("Dm");
    expect(chordViewAtFrame(ir, s, s.totalFrames + 5)!.index).toBe(0);
  });

  it("in a block rhythm all voices light together; in a rest nothing sounds", () => {
    const block = build({ pattern: "Axxx", mode: "block" });
    const sb = scheduleFrames(block, SR);
    expect(chordViewAtFrame(block, sb, 100)!.positions.every((p) => p.sounding)).toBe(true);
    const rest = build({ pattern: ".x..", mode: "block" });
    const sr = scheduleFrames(rest, SR);
    expect(chordViewAtFrame(rest, sr, 100)!.positions.some((p) => p.sounding)).toBe(false); // the rest
    expect(chordViewAtFrame(rest, sr, 22050 + 100)!.positions.every((p) => p.sounding)).toBe(true);
  });

  it("works identically on a document that went through a file", () => {
    const parsed = parseMusicIR(serializeMusicIR(ir));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s2 = scheduleFrames(parsed.ir, SR);
    for (const f of [0, 22050, 100000, 400000]) {
      expect(chordViewAtFrame(parsed.ir, s2, f)).toEqual(chordViewAtFrame(ir, s, f));
    }
  });
});

describe("document helpers", () => {
  it("voiceOrder lists voices lowest first", () => {
    expect(voiceOrder(build({ pattern: "A---", mode: "block" }))).toEqual(["v1", "v2", "v3"]);
  });

  it("irTuning is null when no voice states one; requirePositions complains about unfretted notes", () => {
    const ir = build({ pattern: "A---", mode: "block" });
    const bare = { ...ir, voices: ir.voices.map((v) => ({ ...v, instrument: undefined })) } as unknown as MusicIR;
    expect(irTuning(bare)).toBeNull();
    const s = scheduleFrames(ir, SR);
    const v = chordViewAtFrame(ir, s, 0)!;
    expect(() => requirePositions({ ...v, positions: [{ ...v.positions[0]!, string: undefined, fret: undefined }] })).toThrow(MusicTheoryError);
  });

  it("a frame outside every chord yields null", () => {
    const ir = build({ pattern: "A---", mode: "block" });
    const s = scheduleFrames(ir, SR);
    const gap = { ...s, chords: [] };
    expect(chordViewAtFrame(ir, gap, 10)).toBeNull();
  });
});
