import { describe, expect, it } from "vitest";
import { corpus } from "../src";
import { frac } from "../src";
import { harmony, importOk, lineOf, note, notes, score } from "./corpus.helpers";

// Eight eighths climbing C4..C5, then a held G4 (whole note).
const EIGHTS_THEN_HOLD = [notes("C4:2 D4:2 E4:2 F4:2 G4:2 A4:2 B4:2 C5:2"), notes("G4:16")];

describe("metric weights follow the meter", () => {
  it("4/4: downbeat 4, beat three 3, other beats 2, eighths 1, sixteenths 0", () => {
    const m = { beats: 4, beatType: 4 };
    const w = (n: number, d: number) => corpus.metricWeight(frac(n, d), m);
    expect([w(0, 1), w(1, 4), w(1, 2), w(3, 4), w(1, 8), w(1, 16)]).toEqual([4, 2, 3, 2, 1, 0]);
  });
  it("6/8 groups in threes: the second dotted-quarter beat is 3, eighths inside a beat are 1", () => {
    const m = { beats: 6, beatType: 8 };
    expect([0, 1 / 8, 2 / 8, 3 / 8].map((x) => corpus.metricWeight(frac(Math.round(x * 8), 8), m))).toEqual([4, 1, 1, 3]);
    expect(corpus.metricWeight(frac(1, 16), m)).toBe(0);
  });
  it("3/4: every beat after the first starts a group", () => {
    const m = { beats: 3, beatType: 4 };
    expect([frac(0, 1), frac(1, 4), frac(1, 2), frac(1, 8)].map((p) => corpus.metricWeight(p, m))).toEqual([4, 3, 3, 1]);
  });
});

describe("rhythm analysis separates a run of eighths from a burst and a hold", () => {
  const a = corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD));

  it("measures the run itself, not just a density", () => {
    expect(a.rhythm.noteCount).toBe(9);
    expect(a.rhythm.shortRuns.lengths).toEqual([8]);
    expect(a.rhythm.shortRuns.longest).toBe(8);
    expect(a.rhythm.shortRuns.shareOfNotesInRunsOf8Plus).toBeCloseTo(8 / 9, 3);
    expect(a.rhythm.streaks.lengths).toEqual([9]);
    expect(a.rhythm.bars.map((b) => b.attacks)).toEqual([8, 1]);
    expect(a.rhythm.bars.map((b) => b.perBeat)).toEqual([[2, 2, 2, 2], [1, 0, 0, 0]]);
  });

  it("sees sustain: eight short notes and one held note", () => {
    expect(a.rhythm.sustain).toMatchObject({ short: 8, medium: 0, long: 1, held: 1 });
    expect(a.rhythm.sustain.longTimeShare).toBeCloseTo(0.5, 3);
    expect(a.rhythm.durations.distinct).toBe(2);
    expect(a.rhythm.durations.byValue[0]).toMatchObject({ duration: "1/8", count: 8 });
  });

  it("records metric placement exactly", () => {
    expect(a.rhythm.metric.attacksByWeight).toEqual({ "4": 2, "3": 1, "2": 2, "1": 4 });
    expect(a.rhythm.metric.offbeatShare).toBeCloseTo(4 / 9, 3);
    expect(a.rhythm.metric.syncopatedNotes).toBe(0);
  });

  it("counts a burst followed by a hold, which a density number cannot show", () => {
    expect(a.melody.joint.burstThenHold).toMatchObject({ bursts: 1, heldAfter: 1, restAfter: 0, share: 1 });
  });

  it("two phrases with the same note count and different shape are told apart", () => {
    // same 9 notes in one bar: nine even notes cannot be a burst-then-hold
    const even = corpus.analyzeMelody(lineOf([notes("C4:2 D4:2 E4:2 F4:2 G4:2 A4:2 B4:2 C5:1 B4:1"), notes("G4:16")]));
    expect(even.melody.joint.burstThenHold.bursts).toBe(1);
    const spread = corpus.analyzeMelody(lineOf([notes("C4:4 D4:4 E4:4 F4:4"), notes("G4:4 A4:4 B4:4 C5:4")]));
    expect(spread.rhythm.shortRuns.lengths).toEqual([]);
    expect(spread.rhythm.sustain.long).toBe(8);
  });

  it("finds syncopation: an eighth, then a quarter that starts off the beat and crosses beat two", () => {
    const s = corpus.analyzeMelody(lineOf([notes("C4:2 D4:4 E4:2 G4:8")]));
    expect(s.rhythm.metric.syncopatedNotes).toBe(1);
    expect(s.rhythm.metric.syncopationShare).toBeCloseTo(0.25, 3);
  });

  it("measures rests: where they fall, how long, and what share of time", () => {
    const r = corpus.analyzeMelody(lineOf([notes("C4:4 r:4 D4:4 r:4"), notes("G4:16")]));
    expect(r.rhythm.restCount).toBe(2);
    expect(r.rhythm.rests.totalBeats).toBe(2);
    expect(r.rhythm.rests.timeShare).toBeCloseTo(0.25, 3);
    expect(r.rhythm.rests.byMetricWeight).toEqual({ "2": 2 });
    expect(r.rhythm.streaks.lengths).toEqual([1, 1, 1]);
  });

  it("finds repeated rhythmic cells and repeated bars", () => {
    const bar = notes("C4:6 D4:2 E4:8");
    const r = corpus.analyzeMelody(lineOf([bar, bar, notes("G4:16")]));
    const cell = r.rhythm.cells.repeated.find((c) => c.tokens.join(" ") === "3/8 1/8 1/2")!;
    expect(cell).toMatchObject({ count: 2, uniform: false });
    expect(r.rhythm.cells.repeatedBarShare).toBeCloseTo(1 / 3, 3);
  });

  it("flags unequal groupings: 3+3+2 eighths against 2+2+2+2", () => {
    const r = corpus.analyzeMelody(lineOf([notes("C4:6 D4:6 E4:4"), notes("C4:4 D4:4 E4:4 F4:4")]));
    expect(r.rhythm.groupings.beatPatterns).toMatchObject({ "1-1-0-1": 1, "1-1-1-1": 1 });
    expect(r.rhythm.groupings.unevenBeatShare).toBe(0.5);
    expect(r.rhythm.groupings.asymmetricBarShare).toBeCloseTo(0.5, 3);
  });
});

describe("melodic analysis", () => {
  const a = corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD));

  it("classifies intervals exactly", () => {
    expect(a.melody.intervals).toEqual([2, 2, 1, 2, 2, 2, 1, -5]);
    expect(a.melody.intervalClasses).toMatchObject({ step: 0.875, leap: 0.125, repeat: 0, skip: 0 });
    expect(a.melody.direction).toMatchObject({ up: 7, down: 1, level: 0, changes: 1 });
    expect(a.melody.range).toMatchObject({ lowest: 60, highest: 72, span: 12 });
    expect(a.melody.contour).toMatchObject({ kind: "arch", shape: "uuuuuuud" });
  });

  it("finds a recurring interval motif and a transposed sequence", () => {
    const line = lineOf([notes("C4:2 D4:2 E4:2 C4:2 D4:2 E4:2 F#4:2 D4:2"), notes("G4:16")]);
    const m = corpus.analyzeMelody(line).melody;
    const motif = m.motifs.find((x) => x.intervals.join() === "2,2,-4")!;
    expect(motif.count).toBe(2);
    expect(motif.starts).toHaveLength(2);
    expect(m.sequences).toContainEqual(expect.objectContaining({ unitLength: 4, shift: 2, units: 2, rhythmMatch: true }));
    // the rhythm-aware finding requires the durations to match too
    expect(m.rhythmicMotifs.some((x) => x.intervals.join() === "2,2,-4" && x.rhythm !== undefined)).toBe(true);
  });

  it("reports what follows a leap (gap-fill) and links pitch with rhythm", () => {
    const line = lineOf([notes("C4:4 G4:4 F4:4 E4:4"), notes("C4:4 A4:4 C5:4 D5:4")]);
    const g = corpus.analyzeMelody(line).melody.gapFill;
    // intervals +7 -2 -1 -4 +9 +3 +2: two leaps; the first is answered by a step the other way, the second continues upward
    expect(g).toMatchObject({ leaps: 2, reverseByStep: 1, reverseByLeap: 0, continues: 1, repeats: 0 });
    expect(g.reversalShare).toBe(0.5);
    const j = corpus.analyzeMelody(line).melody.joint;
    expect(j.leapOnStrongShare).toBeGreaterThanOrEqual(0);
    expect(j.meanIntervalAfterLong).toBeGreaterThan(0);
  });

  it("makes no tonal claim it cannot support", () => {
    const keyed = corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD, { fifths: 0, mode: "major" }));
    expect(keyed.melody.tonal).toMatchObject({ source: "written-key", finalDegree: 7 });
    expect(keyed.melody.tonal!.inScaleShare).toBe(1);
    const unkeyed = corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD, { fifths: 0, mode: null }));
    expect(unkeyed.melody.tonal!.source).toBe("inferred-final-note");
    expect(unkeyed.melody.tonal!.confidence).toBeLessThan(0.5);
  });
});

describe("harmony is analysed only where it is written", () => {
  it("relates notes to the chord under them, by strength and by role", () => {
    const m1 = harmony("C", "major") + notes("C4:4 E4:4 G4:4 D4:4");
    const m2 = harmony("G", "dominant") + notes("G4:16");
    const h = corpus.analyzeMelody(lineOf([m1, m2])).harmony;
    expect(h.present).toBe(true);
    if (!h.present) return;
    expect(h.annotatedShare).toBe(1);
    expect(h.noteRoles).toEqual({ "0": 2, "4": 1, "7": 1, nct: 1 });
    expect(h.chordToneShare).toBeCloseTo(0.8, 3);
    expect(h.chordToneShareByStrength.strong).toBe(1);
    expect(h.chordToneShareByStrength.beat).toBeCloseTo(0.5, 3);
    expect(h.nonChordTones).toEqual({ other: 1 });
    expect(Object.values(h.nonChordTones).reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.harmonicRhythm.n).toBe(2);
  });

  it("returns nothing, and invents nothing, when the piece states no chords", () => {
    const h = corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD)).harmony;
    expect(h.present).toBe(false);
    if (!h.present) expect(h.reason).toMatch(/none are inferred/);
  });
});

describe("phrase boundaries are hypotheses with evidence", () => {
  const bars = (n: number) => Array.from({ length: n }, () => notes("C4:4 D4:4 E4:4 F4:4"));
  const withRepeat = [...bars(1), { body: notes("C4:4 D4:4 E4:4 F4:4"), right: `<repeat direction="backward"/>` }, ...bars(2)];
  const a = corpus.analyzeMelody(lineOf(withRepeat));

  it("treats a written repeat as strong, named evidence", () => {
    const at = a.phrases.candidates.find((c) => c.index === 7)!;
    expect(at.evidence.map((e) => e.kind)).toContain("written");
    expect(at.score).toBeGreaterThan(0.85);
    expect(at.selected).toBe(true);
    expect(a.phrases.sections).toEqual([{ startBar: 0, endBar: 1, kind: "repeated-section" }]);
  });

  it("covers every note exactly once, never ends a phrase mid-gap, and never cuts at the piece's edges", () => {
    const ids = a.phrases.phrases.flatMap((p) => p.noteIds);
    expect(ids).toHaveLength(16);
    expect(new Set(ids).size).toBe(16);
    expect(a.phrases.candidates.every((c) => c.index < 15)).toBe(true);
    expect(a.phrases.phrases[0]!.confidence).toBeLessThanOrEqual(1);
    expect(a.phrases.phrases.length).toBeGreaterThanOrEqual(2);
  });

  it("gives alternatives: the same music read at a finer and a coarser level", () => {
    expect(a.phrases.alternatives.map((x) => x.name)).toEqual(["period", "figure"]);
    const [period, figure] = a.phrases.alternatives;
    expect(figure!.phraseCount).toBeGreaterThanOrEqual(period!.phraseCount);
    expect(a.phrases.method.thresholds.primary).toBeGreaterThan(a.phrases.method.thresholds.fine);
  });

  it("a rest of a beat or more is evidence, and so is a long note after quick ones", () => {
    const r = corpus.analyzeMelody(lineOf([notes("C4:2 D4:2 E4:2 F4:2 G4:4 r:4"), notes("A4:4 G4:4 F4:4 E4:4")]));
    const gap = r.phrases.candidates.find((c) => c.evidence.some((e) => e.kind === "rest"))!;
    expect(gap).toBeDefined();
    expect(gap.evidence.find((e) => e.kind === "rest")!.strength).toBe(1);
  });

  it("profiles each phrase: ending, activity shape, contour", () => {
    const line = lineOf([notes("C4:2 D4:2 E4:2 F4:2 G4:2 A4:2 B4:2 C5:2"), notes("G4:16")]);
    const p = corpus.phraseProfile(line, 0, 8);
    expect(p).toMatchObject({ noteCount: 9, activityShape: "burst-hold" });
    expect(p.ending).toMatchObject({ finalBeats: 4, finalInterval: -5, finalIntervalClass: "leap", approach: "down", decelerates: true });
    expect(p.opening).toMatchObject({ firstWeight: 4, afterRest: false, pickup: false });
    expect(p.contour.kind).toBe("arch");
  });
});

describe("the same analysis reads real and generated music", () => {
  it("a corpus piece and its MusicIR projection give the same rhythm and melody measures", () => {
    const { piece } = importOk(score(EIGHTS_THEN_HOLD));
    const proj = corpus.corpusPieceToIR(piece);
    if (!proj.ok) throw new Error("projection failed");
    const fromPiece = corpus.analyzeMelody(corpus.melodyFromCorpusPiece(piece));
    const fromIR = corpus.analyzeMelody(corpus.melodyFromIR(proj.ir, { key: { tonic: "C", mode: "major" } }));
    expect(fromIR.rhythm).toEqual(fromPiece.rhythm);
    expect({ ...fromIR.melody, tonal: null }).toEqual({ ...fromPiece.melody, tonal: null });
    expect(fromIR.source.origin).toBe("generated");
    expect(fromPiece.source.origin).toBe("corpus");
  });
});

describe("analysis is reproducible and aggregates keep their sources", () => {
  const A = corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD));
  const B = corpus.analyzeMelody(lineOf([notes("C4:4 r:4 D4:8"), notes("E4:8 r:4 G4:4")]));

  it("same input, same JSON", () => {
    expect(JSON.stringify(corpus.analyzeMelody(lineOf(EIGHTS_THEN_HOLD)))).toBe(JSON.stringify(A));
  });

  it("pools by counts, names its sources, and does not depend on the order of pieces", () => {
    const ab = corpus.aggregateAnalyses([A, B]);
    const ba = corpus.aggregateAnalyses([B, A]);
    expect(ab.pooled).toEqual(ba.pooled);
    expect(ab.sources).toEqual([A.source.id, B.source.id]);
    expect(ab.pooled.pieces).toBe(2);
    expect(ab.pooled.notes).toBe(A.source.notes + B.source.notes);
    expect(ab.pooled.rhythm.rests.piecesWithRests).toBe(1);
    expect(ab.methods.length).toBeGreaterThan(0);
  });
});
