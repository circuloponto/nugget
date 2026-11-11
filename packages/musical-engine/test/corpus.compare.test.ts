import { describe, expect, it } from "vitest";
import { corpus } from "../src";
import { importOk, lineOf, notes, score } from "./corpus.helpers";

describe("cutting a phrase out of a line", () => {
  const line = lineOf([notes("C4:4 D4:4 r:4 E4:4"), notes("F4:4 G4:4 A4:4 B4:4")]);

  it("keeps exact times and pitches, renumbers bars and notes, and leaves the original alone", () => {
    const s = corpus.sliceLine(line, 3, 6); // F4 G4 A4 B4 (bar 2 only)
    expect(s.notes.map((n) => n.midi)).toEqual([65, 67, 69, 71]);
    expect(s.notes.map((n) => `${n.onset.num}/${n.onset.den}`)).toEqual(["1/1", "5/4", "3/2", "7/4"]);
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]!.index).toBe(0);
    expect(s.notes.every((n) => n.bar === 0)).toBe(true);
    expect(s.events.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(line.notes).toHaveLength(7);
    expect(line.bars).toHaveLength(2);
  });

  it("takes a written rest at either edge with the phrase", () => {
    const s = corpus.sliceLine(line, 2, 6); // E4 … B4: the rest before E4 comes along
    expect(s.events[0]!.kind).toBe("rest");
    const t = corpus.sliceLine(line, 0, 1); // C4 D4: the rest after D4 comes along
    expect(t.events[t.events.length - 1]!.kind).toBe("rest");
    expect(t.notes).toHaveLength(2);
  });

  it("does not take a suspected-padding rest", () => {
    const padded = { ...line, events: line.events.map((e) => (e.kind === "rest" ? { ...e, suspect: true } : e)) };
    const t = corpus.sliceLine(padded, 0, 1);
    expect(t.events.every((e) => e.kind === "note")).toBe(true);
  });
});

describe("the development / held-out split", () => {
  const items = [
    ...["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => ({ id, category: "reel" })),
    ...["b1", "b2", "b3", "b4"].map((id) => ({ id, category: "jig" })),
    { id: "c1", category: "lonely" },
  ];
  const split = corpus.splitCorpus(items, 1, 0.3);

  it("puts every piece on exactly one side", () => {
    expect([...split.development, ...split.heldOut].sort()).toEqual(items.map((i) => i.id).sort());
    expect(split.development.filter((x) => split.heldOut.includes(x))).toEqual([]);
  });

  it("is stratified: each category with two or more pieces is on both sides; a category of one stays in development", () => {
    const cat = (id: string) => items.find((i) => i.id === id)!.category;
    for (const c of ["reel", "jig"]) {
      expect(split.heldOut.filter((x) => cat(x) === c).length).toBeGreaterThanOrEqual(1);
      expect(split.development.filter((x) => cat(x) === c).length).toBeGreaterThanOrEqual(1);
    }
    expect(split.development).toContain("c1");
    expect(split.heldOut).toHaveLength(3); // round(6 x 0.3) = 2 reels, round(4 x 0.3) = 1 jig
  });

  it("does not depend on the order the pieces arrive in, and depends on the seed", () => {
    expect(corpus.splitCorpus([...items].reverse(), 1, 0.3)).toEqual(split);
    const others = [2, 3, 4, 5, 6].map((s) => corpus.splitCorpus(items, s, 0.3).heldOut.join());
    expect(new Set([split.heldOut.join(), ...others]).size).toBeGreaterThan(1);
  });
});

describe("sampling the generator", () => {
  const one = corpus.sampleGenerator({ keys: ["C"], seeds: [1] });

  it("returns phrases the corpus analysis can read, with their traits, from the same path the UI uses", () => {
    expect(one).toHaveLength(1);
    const run = one[0]!;
    expect(run.phrases.length).toBeGreaterThanOrEqual(5);
    for (const p of run.phrases) {
      expect(p.line.origin).toBe("generated");
      expect(p.line.notes.length).toBeGreaterThanOrEqual(3);
      expect(p.line.tonal).toMatchObject({ source: "hint" });
      expect(p.chips.length).toBeGreaterThan(0);
    }
    expect(new Set(run.phrases.map((p) => p.line.id)).size).toBe(run.phrases.length);
  });

  it("is reproducible: the same key and seed give the same phrases note for note", () => {
    const again = corpus.sampleGenerator({ keys: ["C"], seeds: [1] });
    const sig = (r: corpus.GeneratorRun[]) => r[0]!.phrases.map((p) => p.line.notes.map((n) => `${n.midi}@${n.onset.num}/${n.onset.den}+${n.duration.num}/${n.duration.den}`).join(" "));
    expect(sig(again)).toEqual(sig(one));
    const other = corpus.sampleGenerator({ keys: ["C"], seeds: [2] });
    expect(sig(other)).not.toEqual(sig(one));
  });
});

describe("comparing the generator with the corpus", () => {
  // four small 4/4 tunes in two 4-bar phrases, each phrase ending on a one-beat note
  const tune = (shift: string[]) =>
    importOk(
      score(
        [
          notes(shift[0]!),
          notes(shift[1]!),
          notes(shift[2]!),
          { body: notes(shift[3]!), right: `<repeat direction="backward"/>` },
          notes(shift[0]!),
          notes(shift[1]!),
          notes(shift[2]!),
          { body: notes(shift[3]!), right: `<repeat direction="backward"/>` },
        ],
        { title: "t" },
      ),
      `tune-${shift[0]!.split(" ")[0]}`,
    ).piece;
  const pieces = [
    tune(["C4:2 D4:2 E4:2 F4:2 G4:2 F4:2 E4:2 D4:2", "E4:4 D4:4 C4:4 D4:4", "G4:2 A4:2 G4:2 F4:2 E4:2 D4:2 E4:2 F4:2", "G4:4 F4:4 E4:4 C4:4"]),
    tune(["D4:2 E4:2 F4:2 G4:2 A4:2 G4:2 F4:2 E4:2", "F4:4 E4:4 D4:4 E4:4", "A4:2 B4:2 A4:2 G4:2 F4:2 E4:2 F4:2 G4:2", "A4:4 G4:4 F4:4 D4:4"]),
    tune(["E4:2 F4:2 G4:2 A4:2 B4:2 A4:2 G4:2 F4:2", "G4:4 F4:4 E4:4 F4:4", "B4:2 C5:2 B4:2 A4:2 G4:2 F4:2 G4:2 A4:2", "B4:4 A4:4 G4:4 E4:4"]),
    tune(["F4:2 G4:2 A4:2 B4:2 C5:2 B4:2 A4:2 G4:2", "A4:4 G4:4 F4:4 G4:4", "C5:2 D5:2 C5:2 B4:2 A4:2 G4:2 A4:2 B4:2", "C5:4 B4:4 A4:4 F4:4"]),
  ];
  // fabricated generator runs: four notes, then a whole note held to the end of the bar
  const heads = ["G4:4 A4:4 F4:4 D4:4", "E4:4 G4:4 A4:4 C5:4", "C5:4 A4:4 G4:4 F4:4"];
  const tails = ["E5:16", "G5:16", "D5:16"];
  const fab = (seed: number): corpus.GeneratorRun => ({
    key: "C",
    mode: "major",
    seed,
    phrases: [0, 1, 2].map((k) => ({ line: { ...lineOf([notes(heads[k]!), notes(tails[k]!)]), id: `f${seed}-${k}` }, traits: {} as never, chips: ["fabricated"] })),
  });
  const runs = [1, 2, 3, 4].map(fab);
  const result = corpus.compareGenerator({ runs, pieces });
  const row = (id: string) => result.rows.find((r) => r.id === id)!;

  it("reports every metric once, finite, with spreads, subsets and a verdict", () => {
    expect(result.rows.map((r) => r.id)).toEqual(corpus.METRICS.map((m) => m.id));
    for (const r of result.rows) {
      for (const v of [r.generator, r.corpus, r.corpusFourFour, r.corpusDevelopment, r.corpusHeldOut, ...(r.generatorSpread ?? []), ...(r.corpusSpread ?? [])]) expect(v === null || Number.isFinite(v), r.id).toBe(true);
      expect(["within", "above", "below", null]).toContain(r.verdict);
    }
    expect(result.sample).toMatchObject({ runs: 4, failedRuns: 0, keys: ["C"], meter: "4/4" });
    expect(result.corpus).toMatchObject({ pieces: 4, fourFourPieces: 4 });
    expect(result.corpus.phrases).toBeGreaterThanOrEqual(8);
    expect(result.corpus.split.development.length + result.corpus.split.heldOut.length).toBe(4);
  });

  it("sees what was built in: every fabricated phrase ends on a held whole note, no corpus phrase does", () => {
    expect(row("finalBeatsMedian").generator).toBe(4);
    expect(row("finalBeatsMedian").verdict).toBe("above");
    expect(row("finalBeatsMedian").corpus).toBeLessThanOrEqual(2);
    expect(row("heldShare").verdict).toBe("above");
    expect(row("finalDecelerates").generator).toBe(1);
    expect(row("burstHoldShare").generator).toBe(0); // no run of three short notes at all in these phrases
    expect(row("notesPerPhrase").generator).toBe(5);
  });

  it("does not call a difference where there is none", () => {
    expect(row("restPhraseShare").generator).toBe(0);
    expect(row("restPhraseShare").verdict).toBe("within");
    expect(row("startsWithRestShare").verdict).toBe("within");
  });

  it("gives plot-ready distributions that sum to one, and exact examples", () => {
    const d = result.distributions.generator;
    const sum = (o: Readonly<Record<string, number>>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(d.durationClasses)).toBeCloseTo(1, 2);
    expect(sum(d.intervals)).toBeCloseTo(1, 2);
    expect(sum(d.contour)).toBeCloseTo(1, 2);
    expect(sum(d.finalBeats)).toBeCloseTo(1, 2);
    expect(d.activityCurve).toHaveLength(10);
    expect(d.finalBeats["2+ beats"]).toBe(1);
    expect(result.examples.generator.length).toBeLessThanOrEqual(6);
    const ex = result.examples.generator[0]!;
    expect(ex.notes[ex.notes.length - 1]).toMatchObject({ len: 1 });
    expect(ex.span).toBeCloseTo(2, 3);
  });

  it("is deterministic and counts failed runs instead of hiding them", () => {
    expect(JSON.stringify(corpus.compareGenerator({ runs, pieces }))).toBe(JSON.stringify(result));
    const withFailure = corpus.compareGenerator({ runs: [...runs, { key: "Z", mode: "major", seed: 9, phrases: [], note: "engine refused" }], pieces });
    expect(withFailure.sample).toMatchObject({ runs: 5, failedRuns: 1 });
  });
});
