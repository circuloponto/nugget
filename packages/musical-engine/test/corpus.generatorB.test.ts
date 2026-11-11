import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { corpus, DEFAULT_PHRASE_REQUEST, fnum, PLUCK_TONES, renderDocument, validateMusicIR } from "../src";
import { importOk, notes, score } from "./corpus.helpers";

/** Phase 3H.5: the original generator is untouched, and Generator B really is steered by a development-only profile. */

const sig = (runs: readonly corpus.GeneratorRun[]) =>
  runs.map((r) => `${r.key}${r.seed}:${r.phrases.map((p) => p.line.notes.map((n) => `${n.midi}@${n.onset.num}/${n.onset.den}+${n.duration.num}/${n.duration.den}`).join(" ")).join("|")}`).join("\n");

describe("Generator A is unchanged", () => {
  it("produces exactly what it produced before Generator B existed (golden fingerprint)", () => {
    const runs = corpus.sampleGenerator({ keys: ["C", "Eb"], seeds: [1, 2] });
    expect(runs).toHaveLength(4);
    expect(runs.reduce((a, r) => a + r.phrases.length, 0)).toBe(28);
    expect(createHash("sha256").update(sig(runs)).digest("hex")).toBe("1e1867b24ba2e655c0c4fd41cecde0e9b899e3f7d8965e64455fa50d60a45783");
    expect(runs.every((r) => r.generator === undefined)).toBe(true); // A is not relabelled
  });
});

// four small tunes with several phrases each
const tune = (m: string[]) =>
  importOk(score([notes(m[0]!), notes(m[1]!), notes(m[2]!), { body: notes(m[3]!), right: `<repeat direction="backward"/>` }, notes(m[0]!), notes(m[1]!), notes(m[2]!), notes(m[3]!)], { title: "t" }), `tune-${m[0]!.split(" ")[0]}`).piece;
const pieces = [
  tune(["C4:2 D4:2 E4:2 F4:2 G4:2 F4:2 E4:2 D4:2", "E4:4 D4:4 C4:4 D4:4", "G4:2 A4:2 G4:2 F4:2 E4:2 D4:2 E4:2 F4:2", "G4:4 F4:4 E4:4 C4:4"]),
  tune(["D4:2 E4:2 F4:2 G4:2 A4:2 G4:2 F4:2 E4:2", "F4:4 E4:4 D4:4 E4:4", "A4:2 B4:2 A4:2 G4:2 F4:2 E4:2 F4:2 G4:2", "A4:4 G4:4 F4:4 D4:4"]),
  tune(["E4:2 F4:2 G4:2 A4:2 B4:2 A4:2 G4:2 F4:2", "G4:4 F4:4 E4:4 F4:4", "B4:2 C5:2 B4:2 A4:2 G4:2 F4:2 G4:2 A4:2", "B4:4 A4:4 G4:4 E4:4"]),
  tune(["F4:2 G4:2 A4:2 B4:2 C5:2 B4:2 A4:2 G4:2", "A4:4 G4:4 F4:4 G4:4", "C5:2 D5:2 C5:2 B4:2 A4:2 G4:2 A4:2 B4:2", "C5:4 B4:4 A4:4 F4:4"]),
];
const split = corpus.splitCorpus(pieces.map((p) => ({ id: p.id, category: p.provenance.catalog.category ?? "" })));

describe("the corpus profile", () => {
  const profile = corpus.deriveCorpusProfile(pieces, split, "test corpus");

  it("is derived from the development pieces only", () => {
    expect(profile.source.pieceIds.length).toBe(split.development.length);
    for (const id of profile.source.pieceIds) expect(split.development).toContain(id);
    for (const id of split.heldOut) expect(profile.source.pieceIds).not.toContain(id);
    expect(profile.source.corpus).toBe("test corpus");
  });

  it("changes when the development set changes, so it is read from the data", () => {
    const other = corpus.deriveCorpusProfile(pieces, { ...split, development: [split.heldOut[0]!] }, "x");
    expect(other.source.pieceIds).toEqual([split.heldOut[0]]);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(profile));
  });

  it("holds numbers about phrases, not pitches or melodies", () => {
    const text = JSON.stringify({ ...profile, source: { ...profile.source, pieceIds: [] } }); // the fixture ids themselves contain note names
    expect(text).not.toMatch(/midi|pitch|"notes"|C4|D4|E4/);
    const total = (o: Readonly<Record<string, number>>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(total(profile.relations)).toBeCloseTo(1, 1);
    expect(total(profile.activityShapes)).toBeCloseTo(1, 1);
    expect(profile.finalBeats.length).toBe(profile.source.phrases);
  });

  it("refuses to derive anything from an empty development half", () => {
    expect(() => corpus.deriveCorpusProfile(pieces, { ...split, development: [] }, "x")).toThrow(RangeError);
  });
});

const fabricated = (over: Partial<corpus.CorpusProfile> = {}): corpus.CorpusProfile => ({
  schema: corpus.PROFILE_SCHEMA,
  version: 1,
  source: { corpus: "fabricated", pieceIds: ["a"], phrases: 1, pairs: 0 },
  finalBeats: [1],
  phraseBeats: [8],
  notesPerBeat: [1.8],
  activityShapes: { even: 1 },
  contours: { arch: 1 },
  relations: { exact: 0, modifiedEnding: 0, rhythmKept: 0, melodyKept: 0, none: 1 },
  rhythm: { restPhraseShare: 0, dottedShare: 0.1, tripletShare: 0, syncopatedShare: 0.05 },
  ...over,
});

describe("Generator B", () => {
  const profile = corpus.deriveCorpusProfile(pieces, split, "test corpus");
  const opts = { keys: ["C"], seeds: [1, 2] };
  const runs = corpus.sampleGeneratorB(profile, opts);

  it("is deterministic and depends on the seed", () => {
    expect(sig(corpus.sampleGeneratorB(profile, opts))).toBe(sig(runs));
    expect(sig(corpus.sampleGeneratorB(profile, { keys: ["C"], seeds: [5, 6] }))).not.toBe(sig(runs));
  });

  it("makes phrases that are independently valid and playable, in the same register and leap limits as A", () => {
    const [lo, hi] = DEFAULT_PHRASE_REQUEST.register;
    const phrases = runs.flatMap((r) => r.phrases);
    expect(phrases.length).toBeGreaterThanOrEqual(4);
    for (const p of phrases) {
      expect(p.ir).toBeDefined();
      expect(validateMusicIR(p.ir!)).toEqual([]);
      const midis = p.line.notes.map((n) => n.midi);
      for (const m of midis) expect(m >= lo && m <= hi).toBe(true);
      for (let i = 1; i < midis.length; i++) expect(Math.abs(midis[i]! - midis[i - 1]!)).toBeLessThanOrEqual(DEFAULT_PHRASE_REQUEST.maxLeap);
    }
    expect(runs.every((r) => r.generator === "B")).toBe(true);
  });

  it("draws the length of the final note from the profile: it is not held to the end of the chord", () => {
    const short = corpus.sampleGeneratorB(fabricated({ finalBeats: [0.5] }), opts).flatMap((r) => r.phrases);
    const long = corpus.sampleGeneratorB(fabricated({ finalBeats: [4] }), opts).flatMap((r) => r.phrases);
    const last = (p: corpus.GeneratedPhrase) => p.line.notes[p.line.notes.length - 1]!.duration;
    expect(short.length).toBeGreaterThan(0);
    for (const p of short) expect(`${last(p).num}/${last(p).den}`).toBe("1/8");
    for (const p of long) expect(`${last(p).num}/${last(p).den}`).toBe("1/1");
    for (const p of short) expect(p.sampled!.finalBeats).toBe(0.5);
  });

  it("gives a phrase the length the profile asks for, final note included, so B is not shorter just because it stops holding", () => {
    const beats = (p: corpus.GeneratedPhrase) => (fnum(p.line.events[p.line.events.length - 1]!.end) - fnum(p.line.events[0]!.onset)) * 4;
    const near = (phraseBeats: number) =>
      corpus.sampleGeneratorB(fabricated({ phraseBeats: [phraseBeats], finalBeats: [1], relations: { exact: 0, modifiedEnding: 0, rhythmKept: 0, melodyKept: 0, none: 1 } }), opts).flatMap((r) => r.phrases).map(beats);
    const long = near(8);
    const short = near(3);
    expect(long.length).toBeGreaterThan(0);
    expect(short.length).toBeGreaterThan(0);
    const mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
    expect(mean(long)).toBeGreaterThan(mean(short) + 2);
  });

  it("offers only the rhythms the corpus uses: no triplets or written rests when the profile has none", () => {
    const some = corpus.sampleGeneratorB(fabricated(), { keys: ["C", "D"], seeds: [1, 2, 3] }).flatMap((r) => r.phrases);
    expect(some.length).toBeGreaterThan(4);
    for (const p of some) {
      expect(p.traits.rhythmTags).not.toContain("triplet");
      expect(p.line.events.some((e) => e.kind === "rest" && !e.suspect)).toBe(false);
    }
    expect(corpus.allowedCharacters(fabricated(), ["flowing", "triplet", "breathing", "hesitating", "lilting"])).toEqual(["flowing", "lilting"]);
  });

  it("develops a phrase from the one before in the proportions of the profile", () => {
    const keep = corpus.sampleGeneratorB(fabricated({ relations: { exact: 0, modifiedEnding: 0, rhythmKept: 0, melodyKept: 1, none: 0 } }), { keys: ["C", "D", "E"], seeds: [1, 2, 3] });
    let developed = 0;
    for (const r of keep) {
      r.phrases.forEach((p, i) => {
        if (p.sampled!.relation !== "melodyKept") return;
        developed++;
        const parent = r.phrases[i - 1]!;
        expect(p.sampled!.parent).toBe(i - 1);
        expect(p.line.notes.map((n) => n.midi)).toEqual(parent.line.notes.map((n) => n.midi)); // the template keeps the pitches
        expect(p.traits.rhythmSignature).not.toBe(parent.traits.rhythmSignature); // and only the rhythm is new
      });
    }
    expect(developed).toBeGreaterThan(0);

    const rhythm = corpus.sampleGeneratorB(fabricated({ relations: { exact: 0, modifiedEnding: 0, rhythmKept: 1, melodyKept: 0, none: 0 } }), { keys: ["C", "D", "E"], seeds: [1, 2, 3] });
    let kept = 0;
    for (const r of rhythm) {
      r.phrases.forEach((p, i) => {
        if (p.sampled!.relation !== "rhythmKept") return;
        kept++;
        expect(p.traits.rhythmSignature).toBe(r.phrases[i - 1]!.traits.rhythmSignature);
      });
    }
    expect(kept).toBeGreaterThan(0);
  });

  it("never returns a duplicate phrase within a run, and says so when it makes fewer than asked", () => {
    for (const r of runs) {
      const keys = r.phrases.map((p) => p.line.notes.map((n) => `${n.midi}@${n.onset.num}/${n.onset.den}+${n.duration.num}/${n.duration.den}`).join(" "));
      expect(new Set(keys).size).toBe(keys.length);
      if (r.phrases.length < 4) expect(r.note).toMatch(/not padded/);
    }
  });
});

describe("the blind A/B study", () => {
  const profile = corpus.deriveCorpusProfile(pieces, split, "test corpus");
  const keys = ["C", "D"];
  const seeds = [1, 2];
  const A = corpus.sampleGenerator({ keys, seeds, count: 4 });
  const B = corpus.sampleGeneratorB(profile, { keys, seeds });
  const { study, key } = corpus.buildAbStudy(A, B, { pairs: 6, seed: 3, keys, seeds });

  it("pairs phrases of the two generators from the same key, mode and seed, with the same harmony", () => {
    expect(study.pairs.length).toBeGreaterThanOrEqual(4);
    for (const p of study.pairs) expect(JSON.stringify(p.x.ir.chords)).toBe(JSON.stringify(p.y.ir.chords));
    expect(new Set(study.pairs.map((p) => p.key)).size).toBeGreaterThan(1); // spread over keys, not one run
  });

  it("names the generator nowhere that can be read from the study", () => {
    const text = JSON.stringify(study);
    for (const tell of ["phrase-generate", "generator", "provenance", "semantics", "t-phrase", "gesture", "transformations\":[{", "-B", "new idea", "kept", "score"]) expect(text, tell).not.toContain(tell);
    for (const p of study.pairs) {
      expect(p.x.ir.title).toBe("Example");
      expect(p.x.ir.id).toBe(`${p.id}-x`);
      expect(p.y.ir.id).toBe(`${p.id}-y`);
    }
  });

  it("gives every document a valid, playable form", () => {
    for (const p of study.pairs) {
      for (const side of [p.x, p.y]) {
        expect(validateMusicIR(side.ir)).toEqual([]);
        const r = renderDocument(side.ir, { sampleRate: 8000, tone: PLUCK_TONES.sine });
        expect(r.samples.length).toBeGreaterThan(8000 * 0.5);
        expect(r.samples.some((v) => Math.abs(v) > 0.01)).toBe(true);
      }
    }
  });

  it("keeps the answer in a separate key, with both orders used", () => {
    expect(key.studyId).toBe(study.id);
    expect(Object.keys(key.pairs).sort()).toEqual(study.pairs.map((p) => p.id).sort());
    const firsts = new Set(Object.values(key.pairs).map((m) => m.X));
    expect(firsts.size).toBe(2); // A is X in some pairs and Y in others
    for (const m of Object.values(key.pairs)) expect([m.X, m.Y].sort()).toEqual(["A", "B"]);
  });

  it("is reproducible, and a different coin seed changes only the order, not the content", () => {
    const again = corpus.buildAbStudy(A, B, { pairs: 6, seed: 3, keys, seeds });
    expect(again.study.id).toBe(study.id);
    expect(JSON.stringify(again.key)).toBe(JSON.stringify(key));
    const other = corpus.buildAbStudy(A, B, { pairs: 6, seed: 4, keys, seeds });
    expect(JSON.stringify(other.key.pairs)).not.toBe(JSON.stringify(key.pairs));
  });

  it("turns judgements into counts per generator only through the key", () => {
    const allX: Record<string, Record<string, "X" | "Y" | "same">> = {};
    for (const p of study.pairs) allX[p.id] = { musical: "X", coherent: "same" };
    const t = corpus.tallyAb(key, allX);
    const musical = t.find((x) => x.question === "musical")!;
    expect(musical.A + musical.B).toBe(study.pairs.length);
    expect(musical.A).toBe(Object.values(key.pairs).filter((m) => m.X === "A").length);
    expect(t.find((x) => x.question === "coherent")!.noDifference).toBe(study.pairs.length);
    expect(corpus.tallyAb(key, {})[0]).toMatchObject({ A: 0, B: 0, noDifference: 0 });
  });
});
