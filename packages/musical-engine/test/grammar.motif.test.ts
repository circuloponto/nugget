import { describe, expect, it } from "vitest";
import {
  augment,
  buildScale,
  compareMotifs,
  diminish,
  displaceMotif,
  extendMotif,
  feq,
  fitMotifToTarget,
  formatPitch,
  fragment,
  fadd,
  frac,
  fsum,
  invertMotif,
  midi,
  motifFromNotes,
  parsePitch,
  pitchesOf,
  realizeMotif,
  repeatMotif,
  retrograde,
  RHYTHMIC_GESTURES,
  rhythmPlans,
  sequenceMotif,
  shiftMotifInScale,
  syncopationOf,
  transposeMotif,
  varyIntervals,
  varyRhythm,
  fstr,
  type Motif,
} from "../src";


const base: Motif = motifFromNotes(
  "m1",
  [
    { pitch: parsePitch("D4"), onset: frac(0), duration: frac(1, 8), accent: 2 },
    { pitch: parsePitch("F4"), onset: frac(1, 8), duration: frac(1, 8), accent: 1 },
    { pitch: parsePitch("E4"), onset: frac(1, 4), duration: frac(1, 4), accent: 1 },
  ],
  { name: "turn" },
);
const names = (m: Motif) => pitchesOf(m).map(formatPitch).join(" ");
const durs = (m: Motif) => m.notes.map((n) => fstr(n.duration)).join(" ");
const offs = (m: Motif) => m.notes.map((n) => fstr(n.offset)).join(" ");
const last = (m: Motif) => m.lineage[m.lineage.length - 1]!;
const ALL = ["intervals", "contour", "rhythm", "accents", "length", "start-pitch", "delay"].sort();
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("motifs: identity is separable, and every transformation says what it kept", () => {
  it("a motif is built from notes: spelled intervals, exact rhythm, accents, length", () => {
    expect(names(base)).toBe("D4 F4 E4");
    expect(base.notes.map((n) => n.interval.semitones)).toEqual([0, 3, -1]);
    expect(offs(base)).toBe("0 1/8 1/4");
    expect(durs(base)).toBe("1/8 1/8 1/4");
    expect(fstr(base.length)).toBe("1/2");
  });

  it("transpose: same shape and rhythm, new pitch level", () => {
    const m = transposeMotif(base, { steps: 1, semitones: 2 });
    expect(names(m)).toBe("E4 G4 F#4");
    expect(sorted(last(m).preserved)).toEqual(sorted(["intervals", "contour", "rhythm", "accents", "length", "delay"]));
    expect(last(m).transformed).toEqual(["start-pitch"]);
  });

  it("invert: the same rhythm, mirrored intervals", () => {
    const m = invertMotif(base);
    expect(names(m)).toBe("D4 B3 C4");
    expect(m.notes.map((n) => n.interval.semitones)).toEqual([0, -3, 1]);
    expect(last(m).preserved).toEqual(expect.arrayContaining(["rhythm", "accents", "length", "start-pitch"]));
    expect(last(m).transformed).toEqual(expect.arrayContaining(["intervals", "contour"]));
    expect(invertMotif(m).notes.map((n) => n.interval.semitones)).toEqual([0, 3, -1]);
  });

  it("retrograde: the notes and the rhythm run backwards, inside the same span", () => {
    const m = retrograde(base);
    expect(names(m)).toBe("E4 F4 D4");
    expect(durs(m)).toBe("1/4 1/8 1/8");
    expect(offs(m)).toBe("0 1/4 3/8");
    expect(fstr(m.length)).toBe("1/2");
    expect(last(m).preserved).toContain("length");
    expect(last(m).transformed).toEqual(expect.arrayContaining(["rhythm", "intervals", "start-pitch"]));
    expect(names(retrograde(m))).toBe(names(base));
    expect(offs(retrograde(m))).toBe(offs(base));
  });

  it("augmentation keeps the intervals, changes every time value; diminution undoes it exactly", () => {
    const a = augment(base);
    expect(durs(a)).toBe("1/4 1/4 1/2");
    expect(offs(a)).toBe("0 1/4 1/2");
    expect(fstr(a.length)).toBe("1");
    expect(names(a)).toBe(names(base));
    expect(last(a).preserved).toEqual(expect.arrayContaining(["intervals", "contour", "accents", "start-pitch"]));
    expect(last(a).transformed).toEqual(expect.arrayContaining(["rhythm", "length"]));
    const back = diminish(a);
    expect(durs(back)).toBe(durs(base));
    expect(offs(back)).toBe(offs(base));
    expect(durs(augment(base, frac(3, 2)))).toBe("3/16 3/16 3/8");
    expect(() => augment(base, frac(0))).toThrow(RangeError);
  });

  it("fragment keeps a slice, rebased to zero", () => {
    const m = fragment(base, 1, 3);
    expect(names(m)).toBe("F4 E4");
    expect(offs(m)).toBe("0 1/8");
    expect(fstr(m.length)).toBe("3/8");
    expect(() => fragment(base, 2, 2)).toThrow(RangeError);
  });

  it("extension adds notes after the motif", () => {
    const m = extendMotif(base, [{ interval: { steps: 2, semitones: 3 }, duration: frac(1, 4) }]);
    expect(names(m)).toBe("D4 F4 E4 G4");
    expect(fstr(m.length)).toBe("3/4");
    expect(last(m).transformed).toContain("length");
    expect(last(m).preserved).toContain("start-pitch");
  });

  it("rhythmic displacement moves the onsets but nothing else", () => {
    const m = displaceMotif(base, frac(1, 8));
    expect(realizeMotif(m, frac(1)).map((n) => fstr(n.onset))).toEqual(["9/8", "5/4", "11/8"]);
    expect(names(m)).toBe(names(base));
    expect(last(m).transformed).toEqual(["delay"]);
    expect(() => displaceMotif(base, frac(-1, 8))).toThrow(RangeError);
  });

  it("variation with retained identity: same rhythm new intervals, or same intervals new rhythm", () => {
    const r = varyIntervals(base, [
      { steps: 1, semitones: 2 },
      { steps: -1, semitones: -2 },
    ]);
    expect(names(r)).toBe("D4 E4 D4");
    expect(last(r).preserved).toEqual(expect.arrayContaining(["rhythm", "accents", "length", "start-pitch"]));
    expect(last(r).transformed).toContain("intervals");
    const v = varyRhythm(base, [frac(1, 4), frac(1, 16), frac(1, 16)]);
    expect(durs(v)).toBe("1/4 1/16 1/16");
    expect(names(v)).toBe(names(base));
    expect(last(v).preserved).toEqual(expect.arrayContaining(["intervals", "contour", "start-pitch"]));
    expect(last(v).transformed).toContain("rhythm");
    expect(() => varyRhythm(base, [frac(1, 4)])).toThrow(RangeError);
  });

  it("a real sequence restates the motif a step lower each time, with the same rhythm", () => {
    const m = sequenceMotif(base, { steps: -1, semitones: -2 }, 3);
    expect(names(m)).toBe("D4 F4 E4 C4 Eb4 D4 Bb3 Db4 C4");
    expect(offs(m)).toBe("0 1/8 1/4 1/2 5/8 3/4 1 9/8 5/4");
    expect(fstr(m.length)).toBe("3/2");
    expect(m.notes.map((n) => fstr(n.duration)).join(" ")).toBe("1/8 1/8 1/4 1/8 1/8 1/4 1/8 1/8 1/4");
  });

  it("a diatonic shift moves the start by scale steps", () => {
    const space = { scale: buildScale("C", "major").notes };
    expect(names(shiftMotifInScale(base, 2, space))).toBe("F4 Ab4 G4");
    expect(names(shiftMotifInScale(base, -1, space))).toBe("C4 Eb4 D4");
  });

  it("repetition states the same pitches again", () => {
    const m = repeatMotif(base, 2);
    expect(names(m)).toBe("D4 F4 E4 D4 F4 E4");
    expect(offs(m)).toBe("0 1/8 1/4 1/2 5/8 3/4");
    expect(() => repeatMotif(base, 0)).toThrow(RangeError);
  });

  it("transformations compose and keep their whole history", () => {
    const m = transposeMotif(augment(base), { steps: 2, semitones: 4 });
    expect(m.lineage.map((s) => s.op)).toEqual(["augment", "transpose"]);
    expect(names(m)).toBe("F#4 A4 G#4");
    expect(durs(m)).toBe("1/4 1/4 1/2");
  });

  it("claims are verified: the recorded aspects equal an independent comparison of before and after", () => {
    const space = { scale: buildScale("C", "major").notes };
    const cases: [Motif, Motif][] = [
      [base, transposeMotif(base, { steps: 4, semitones: 7 })],
      [base, invertMotif(base)],
      [base, retrograde(base)],
      [base, augment(base)],
      [base, fragment(base, 0, 2)],
      [base, displaceMotif(base, frac(1, 16))],
      [base, shiftMotifInScale(base, 1, space)],
    ];
    for (const [before, after] of cases) {
      const { preserved, transformed } = compareMotifs(before, after);
      expect(sorted(preserved)).toEqual(sorted(last(after).preserved));
      expect(sorted([...preserved, ...transformed])).toEqual(ALL);
    }
  });

  it("fits a motif to a target: the last note IS the target, and it starts exactly at the arrival time", () => {
    const { motif, onset } = fitMotifToTarget(base, parsePitch("G4"), frac(2));
    expect(formatPitch(pitchesOf(motif)[2]!)).toBe("G4");
    const placed = realizeMotif(motif, onset);
    expect(fstr(placed[2]!.onset)).toBe("2");
    expect(fstr(onset)).toBe("7/4");
    expect(names(motif)).toBe("F4 Ab4 G4"); // the shape is kept; the pitch level moves
    expect(motif.notes.map((n) => n.interval.semitones)).toEqual([0, 3, -1]);
    expect(() => fitMotifToTarget(base, parsePitch("G4"), frac(1, 8))).toThrow(RangeError);
  });
});

describe("rhythmic vocabulary", () => {
  const tiles = (span: ReturnType<typeof frac>, plan: ReturnType<typeof rhythmPlans>[number]) => {
    let at = frac(0);
    for (const s of plan.slots) {
      if (!feq(s.offset, at)) return false;
      at = fadd(at, s.duration);
    }
    return feq(at, span);
  };

  it("fills a span exactly, with exactly the requested number of notes, and nothing overlaps or is left over", () => {
    for (const [span, hits] of [
      [frac(1), 5],
      [frac(1), 6],
      [frac(3, 4), 4],
      [frac(1, 2), 3],
      [frac(5, 4), 6],
    ] as const) {
      const plans = rhythmPlans(span, hits);
      expect(plans.length, `${fstr(span)} with ${hits}`).toBeGreaterThan(0);
      for (const p of plans) {
        expect(p.hits).toBe(hits);
        expect(tiles(span, p), p.id).toBe(true);
        expect(feq(fsum(p.slots.map((s) => s.duration)), span)).toBe(true);
      }
    }
  });

  it("says so when it cannot: no plan fits seven notes into one beat", () => {
    expect(rhythmPlans(frac(1, 4), 7)).toEqual([]);
  });

  it("is deterministic and its plans are distinct", () => {
    const a = rhythmPlans(frac(1), 6);
    const b = rhythmPlans(frac(1), 6);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(new Set(a.map((p) => p.id)).size).toBe(a.length);
  });

  it("triplets are exact thirds of a beat, not rounded", () => {
    const plans = rhythmPlans(frac(1, 2), 6, { feel: "triplet" });
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) for (const s of p.slots) expect(["1/12", "1/6"]).toContain(fstr(s.duration));
    const t = RHYTHMIC_GESTURES.find((g) => g.id === "eighth-triplet")!;
    expect(fstr(t.length)).toBe("1/4");
    expect(t.slots.map((s) => fstr(s.offset))).toEqual(["0", "1/12", "1/6"]);
  });

  it("respects an instruction not to use rests, and offers rests otherwise", () => {
    expect(rhythmPlans(frac(1), 4, { rests: false }).every((p) => p.slots.every((s) => !s.rest))).toBe(true);
    expect(rhythmPlans(frac(1), 4, { rests: true }, 200).some((p) => p.slots.some((s) => s.rest))).toBe(true);
  });

  it("accelerating plans never slow down; decelerating ones never speed up", () => {
    const density = (id: string) => {
      const g = RHYTHMIC_GESTURES.find((x) => x.id === id)!;
      return g.slots.filter((s) => !s.rest).length / (Number(g.length.num) / Number(g.length.den) * 4);
    };
    const acc = rhythmPlans(frac(1), 7, { shape: "accelerating" }, 5);
    expect(acc.length).toBeGreaterThan(0);
    for (const p of acc.slice(0, 3)) {
      const d = p.gestures.map(density);
      expect(d.every((x, i) => i === 0 || x >= d[i - 1]!)).toBe(true);
    }
    const dec = rhythmPlans(frac(1), 7, { shape: "decelerating" }, 5);
    for (const p of dec.slice(0, 3)) {
      const d = p.gestures.map(density);
      expect(d.every((x, i) => i === 0 || x <= d[i - 1]!)).toBe(true);
    }
  });

  it("a syncopation preference changes what ranks first", () => {
    const plain = rhythmPlans(frac(1), 5, { syncopation: 0 })[0]!;
    const synco = rhythmPlans(frac(1), 5, { syncopation: 1 })[0]!;
    expect(syncopationOf(synco)).toBeGreaterThan(syncopationOf(plain));
  });

  it("midi of every pitch in a realized motif is an integer (no float leakage)", () => {
    for (const p of pitchesOf(augment(base))) expect(Number.isInteger(midi(p))).toBe(true);
  });
});
