import { describe, expect, it } from "vitest";
import { corpus } from "../src";
import { importOk, lineOf, notes, score } from "./corpus.helpers";

/** Phase 3H.4.2: matched subsets, phrase development, streaks, rest ownership, absent values, dynamic caveats. */

const phraseLine = (id: string, measures: string[]) => ({ ...lineOf(measures.map(notes)), id });
const runOf = (seed: number, phrases: string[][]): corpus.GeneratorRun => ({
  key: "C",
  mode: "major",
  seed,
  phrases: phrases.map((m, k) => ({ line: phraseLine(`r${seed}-${k}`, m), traits: {} as never, chips: ["fabricated"] })),
});
const threeRuns = (phrases: string[][]) => [1, 2, 3].map((s) => runOf(s, phrases));

const tune = (m: string[]) =>
  importOk(score([notes(m[0]!), notes(m[1]!), notes(m[2]!), { body: notes(m[3]!), right: `<repeat direction="backward"/>` }, notes(m[0]!), notes(m[1]!), notes(m[2]!), notes(m[3]!)], { title: "t" }), `tune-${m[0]!.split(" ")[0]}`).piece;
const pieces = [
  tune(["C4:2 D4:2 E4:2 F4:2 G4:2 F4:2 E4:2 D4:2", "E4:4 D4:4 C4:4 D4:4", "G4:2 A4:2 G4:2 F4:2 E4:2 D4:2 E4:2 F4:2", "G4:4 F4:4 E4:4 C4:4"]),
  tune(["D4:2 E4:2 F4:2 G4:2 A4:2 G4:2 F4:2 E4:2", "F4:4 E4:4 D4:4 E4:4", "A4:2 B4:2 A4:2 G4:2 F4:2 E4:2 F4:2 G4:2", "A4:4 G4:4 F4:4 D4:4"]),
  tune(["E4:2 F4:2 G4:2 A4:2 B4:2 A4:2 G4:2 F4:2", "G4:4 F4:4 E4:4 F4:4", "B4:2 C5:2 B4:2 A4:2 G4:2 F4:2 G4:2 A4:2", "B4:4 A4:4 G4:4 E4:4"]),
  tune(["F4:2 G4:2 A4:2 B4:2 C5:2 B4:2 A4:2 G4:2", "A4:4 G4:4 F4:4 G4:4", "C5:2 D5:2 C5:2 B4:2 A4:2 G4:2 A4:2 B4:2", "C5:4 B4:4 A4:4 F4:4"]),
];
const row = (r: corpus.GeneratorComparison, id: string) => r.rows.find((x) => x.id === id)!;

describe("a written rest between two phrases is counted once", () => {
  const line = lineOf([notes("C4:4 D4:4 r:4 E4:4"), notes("F4:4 G4:4 A4:4 B4:4")]);
  const rests = (l: corpus.MelodyLine) => l.events.filter((e) => e.kind === "rest").length;

  it("goes with the earlier phrase when the later one does not take a leading rest", () => {
    const first = corpus.sliceLine(line, 0, 1, { leading: true });
    const second = corpus.sliceLine(line, 2, 6, { leading: false });
    expect(rests(first)).toBe(1);
    expect(rests(second)).toBe(0);
    // the default still takes it on both sides, for context
    expect(rests(corpus.sliceLine(line, 2, 6))).toBe(1);
  });

  it("does not inflate the silence of a corpus tune: its one rest is in one phrase only", () => {
    const withRest = importOk(score([notes("C4:4 D4:4 E4:4 F4:4"), notes("G4:4 A4:4 B4:4 r:4"), notes("C5:4 B4:4 A4:4 G4:4"), notes("F4:4 E4:4 D4:4 C4:4")], { title: "r" }), "rest-tune").piece;
    const result = corpus.compareGenerator({ runs: threeRuns([["C4:4 D4:4 E4:4 F4:4"], ["G4:4 A4:4 B4:4 C5:4"]]), pieces: [withRest] });
    expect(result.corpus.writtenRests).toBe(1);
    // a rest cannot both end one phrase and open the next
    expect(row(result, "startsWithRestShare").corpus === 0 || row(result, "endsWithRestShare").corpus === 0).toBe(true);
  });
});

describe("uninterrupted note streaks", () => {
  it("do not depend on the note length: a run of quarter notes (not short) is counted", () => {
    const r = corpus.compareGenerator({ runs: threeRuns([["C4:4 D4:4 E4:4 F4:4"], ["G4:4 A4:4 B4:4 C5:4"]]), pieces });
    expect(row(r, "longestStreakNotes").generator).toBe(8);
    expect(row(r, "longestStreakBeats").generator).toBe(8);
    expect(row(r, "longestRun").generator).toBe(0); // no short notes at all, so the short-note metric sees nothing
  });

  it("are broken by a written rest, including one at a phrase end", () => {
    const r = corpus.compareGenerator({ runs: threeRuns([["C4:4 D4:4 E4:4 r:4"], ["G4:4 A4:4 B4:4 C5:4"]]), pieces });
    expect(row(r, "longestStreakNotes").generator).toBe(4);
  });
});

describe("how a phrase relates to the one before it", () => {
  const A = "C4:4 D4:4 E4:4 G4:4";
  const cases: { name: string; second: string; metric: string }[] = [
    { name: "exact repetition (also transposed)", second: "D4:4 E4:4 F#4:4 A4:4", metric: "adjExact" },
    { name: "rhythm repeated, melody varied", second: "C4:4 G4:4 F4:4 D4:4", metric: "adjRhythmKept" },
    { name: "melody recurs, rhythm varied", second: "C4:8 D4:2 E4:2 G4:4", metric: "adjMelodyKept" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = corpus.compareGenerator({ runs: threeRuns([[A], [c.second]]), pieces });
      const others = ["adjExact", "adjRhythmKept", "adjMelodyKept", "adjModifiedEnding"].filter((m) => m !== c.metric);
      expect(row(r, c.metric).generator, c.metric).toBe(1);
      for (const m of others) expect(row(r, m).generator, m).toBe(0);
    });
  }

  it("modified ending: the same phrase except its last note", () => {
    const first = "C4:2 D4:2 E4:2 F4:2 G4:2 F4:2 E4:2 D4:2";
    const second = "C4:2 D4:2 E4:2 F4:2 G4:2 F4:2 E4:2 G4:2";
    const r = corpus.compareGenerator({ runs: threeRuns([[first], [second]]), pieces });
    expect(row(r, "adjModifiedEnding").generator).toBe(1);
    expect(row(r, "adjExact").generator).toBe(0);
  });

  it("unrelated phrases are none of them, and a single phrase has no neighbours at all", () => {
    const r = corpus.compareGenerator({ runs: threeRuns([[A], ["F4:2 A4:2 C5:4 B4:8"]]), pieces });
    for (const m of ["adjExact", "adjRhythmKept", "adjMelodyKept", "adjModifiedEnding"]) expect(row(r, m).generator, m).toBe(0);
    const single = corpus.compareGenerator({ runs: threeRuns([[A]]), pieces });
    expect(row(single, "adjExact").generator).toBeNull(); // not 0: there was nothing to measure
    expect(row(single, "adjExact").verdict).toBeNull();
  });
});

describe("matched subsets, small samples and absent values", () => {
  const r = corpus.compareGenerator({ runs: threeRuns([["C4:4 D4:4 E4:4 F4:4"], ["G4:4 A4:4 B4:4 C5:4"]]), pieces });

  it("reports the size of every subset, and the length range used to match", () => {
    expect(r.subsets.all.pieces).toBe(4);
    expect(r.subsets.fourFour.pieces).toBe(4);
    expect(r.matchRange).toEqual([4, 4]); // the generator's phrases are one bar (4 beats)
    expect(Object.keys(r.subsets).sort()).toEqual([...corpus.SUBSETS].sort());
  });

  it("gives null, not a made-up value or verdict, where a subset is empty", () => {
    expect(r.subsets.matched.phrases).toBe(0); // the corpus phrases are 4 bars long
    for (const x of r.rows) {
      expect(x.corpusMatched, x.id).toBeNull();
      expect(x.verdicts.matched, x.id).toBeNull();
      expect(x.verdicts.matchedFourFour, x.id).toBeNull();
    }
  });

  it("labels each metric stable, repertoire-dependent or unclear from the control subsets that could be judged", () => {
    for (const x of r.rows) expect(["stable", "stable-within", "repertoire", "unclear"]).toContain(x.stability);
    const judged = (x: corpus.MetricRow) => (["all", "fourFour", "matched", "matchedFourFour"] as const).filter((s) => x.verdicts[s] !== null).length;
    for (const x of r.rows) if (judged(x) < 2) expect(x.stability).toBe("unclear");
    expect(r.rows.some((x) => x.stability !== "unclear")).toBe(true);
  });
});

describe("caveats are written from the data", () => {
  const r = corpus.compareGenerator({ runs: threeRuns([["C4:4 D4:4 E4:4 F4:4"]]), pieces, corpusName: "My test corpus" });
  const text = r.caveats.join("\n");

  it("name the corpus and its real size, not a fixed one", () => {
    expect(text).toContain("My test corpus: 4 pieces");
    expect(text).not.toContain("23");
    expect(text).not.toMatch(/Nottingham/);
    expect(text).toContain("4 in 4/4");
  });

  it("warn about small subsets by their actual numbers, and say nothing has been listened to", () => {
    expect(text).toMatch(/Only 4 corpus tunes are in 4\/4/);
    expect(text).toMatch(/Only 0 corpus phrases fall in the generator's length range/);
    expect(text).toMatch(/no listening evaluation/);
  });

  it("report the written rests actually found", () => {
    expect(text).toContain(`${r.corpus.writtenRests} written rest`);
  });
});
