import { describe, expect, it } from "vitest";
import {
  buildScale,
  defaultGenerationSpace,
  developRequest,
  DEFAULT_PHRASE_REQUEST,
  explorePhrases,
  generationSpaceFromRequest,
  midi,
  parsePhraseRequest,
  progressionFor,
  targetOptions,
  type PhraseRequest,
} from "../src";

const keys = (r: ReturnType<typeof explorePhrases>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.candidates.map((c) => `${c.choices.pitches.map(midi).join()}|${c.choices.rhythm.id}`);
};

describe("the Phrase Constructor's request", () => {
  it("the default request explores every target and returns seven phrases", () => {
    const gs = generationSpaceFromRequest(DEFAULT_PHRASE_REQUEST);
    expect(gs.targets.mode).toBe("explore");
    expect(gs.count).toBe(7);
    expect(gs.seed).toBe(1);
    const direct = defaultGenerationSpace(progressionFor("C", "major"), { scale: buildScale("C", "major").notes });
    expect(keys(explorePhrases(gs))).toEqual(keys(explorePhrases(direct)));
  });

  it("builds the minor ii–V–i, with a half-diminished ii", () => {
    const gs = generationSpaceFromRequest({ ...DEFAULT_PHRASE_REQUEST, tonic: "A", mode: "minor" });
    expect(gs.progression.map((p) => p.chord.symbol)).toEqual(["Bm7b5", "E7", "Am7"]);
  });

  it("Focus mode and the per-dimension choices reach the space", () => {
    const req: PhraseRequest = {
      ...DEFAULT_PHRASE_REQUEST,
      exploration: { ...DEFAULT_PHRASE_REQUEST.exploration, mode: "focus", focusDegree: "5", bands: ["mid"], strategies: ["scale-run"], rhythms: ["triplet"], count: 4, seed: 9 },
    };
    const gs = generationSpaceFromRequest(req);
    expect(gs.targets).toEqual({ mode: "focus", degree: "5" });
    expect(gs.bands).toEqual(["mid"]);
    expect(gs.strategies).toEqual(["scale-run"]);
    expect(gs.rhythms).toEqual(["triplet"]);
    expect([gs.count, gs.seed]).toEqual([4, 9]);
  });

  it("lists the degrees the final chord can be targeted on, spelled for the key", () => {
    const c = targetOptions("C", "major");
    expect(c.chord).toBe("Cmaj7");
    expect(c.options.find((o) => o.degree === "3")).toEqual({ degree: "3", note: "E", role: "third", kind: "chord-tone" });
    expect(c.options.map((o) => o.degree)).toEqual(expect.arrayContaining(["1", "3", "5", "7", "9", "#11", "13"]));
    expect(targetOptions("Eb", "major").options.find((o) => o.degree === "7")!.note).toBe("D");
  });
});

describe("developing a phrase from the request", () => {
  const first = (() => {
    const r = explorePhrases(generationSpaceFromRequest(DEFAULT_PHRASE_REQUEST));
    if (!r.ok) throw new Error(r.reason);
    return r.candidates[0]!;
  })();

  it("locking the target switches to Focus on that degree and octave, and advances the seed", () => {
    const next = developRequest(DEFAULT_PHRASE_REQUEST, first, ["target"]);
    expect(next.exploration.mode).toBe("focus");
    expect(next.exploration.focusDegree).toBe(first.traits.targetDegree);
    expect(next.exploration.bands).toEqual([first.traits.band]);
    expect(next.exploration.locks?.targetPitch).toBe(first.traits.targetPitch);
    expect(next.exploration.seed).toBe(DEFAULT_PHRASE_REQUEST.exploration.seed + 1);
  });

  it("locking the rhythm and contour stores them exactly, and they survive a trip through JSON", () => {
    const next = developRequest(DEFAULT_PHRASE_REQUEST, first, ["rhythm", "contour"]);
    expect(next.exploration.locks?.rhythmPlan).toEqual(first.choices.rhythm);
    expect(next.exploration.locks?.contourShape).toBe(first.traits.shape);
    const back = parsePhraseRequest(JSON.parse(JSON.stringify(next)));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.request).toEqual(next);
    const r = explorePhrases(generationSpaceFromRequest(back.ok ? back.request : next));
    expect(r.ok).toBe(true);
  });

  it("developing with nothing locked just moves to a new seed", () => {
    const next = developRequest(DEFAULT_PHRASE_REQUEST, first, []);
    expect(next.exploration.seed).toBe(2);
    expect(next.exploration.locks).toBeUndefined();
  });
});

describe("a request stored in a file is untrusted", () => {
  it("restores a stored request exactly", () => {
    const ok = parsePhraseRequest(JSON.parse(JSON.stringify(DEFAULT_PHRASE_REQUEST)));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.request).toEqual(DEFAULT_PHRASE_REQUEST);
  });

  it("reports every damaged field, by name", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_PHRASE_REQUEST));
    const bad = parsePhraseRequest({
      ...stored,
      tonic: "H",
      bpm: 9000,
      register: [80, 60],
      maxLeap: 0,
      exploration: { ...stored.exploration, mode: "wander", count: 99, seed: -1, strategies: ["no-such"], bands: ["basement"], locks: { targetPitch: 3, contourShape: "xyz", rhythmPlan: { id: 5 } } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.issues.join(" | ");
      for (const word of ["tonic", "bpm", "register", "maxLeap", "exploration.mode", "exploration.count", "exploration.seed", "exploration.strategies", "exploration.bands", "locks.targetPitch", "locks.contourShape", "locks.rhythmPlan"]) expect(text).toContain(word);
    }
  });

  it("never throws on junk, and ignores unknown fields", () => {
    for (const junk of [null, 5, "x", [], {}, { tonic: "C" }, { ...DEFAULT_PHRASE_REQUEST, exploration: 3 }]) {
      expect(() => parsePhraseRequest(junk)).not.toThrow();
      expect(parsePhraseRequest(junk).ok).toBe(false);
    }
    const r = parsePhraseRequest({ ...JSON.parse(JSON.stringify(DEFAULT_PHRASE_REQUEST)), surprise: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect("surprise" in r.request).toBe(false);
  });

  it("migrates a request saved by the earlier single-target build into a Focus request", () => {
    const old = { tonic: "Eb", mode: "major", bpm: 120, targetDegree: "7", outline: { direction: "any", counts: [3, 4] }, embellishment: { kind: "enclosure", step: "chromatic" }, rhythm: {}, register: [55, 84], maxLeap: 9, maxFret: 15, soft: {}, candidates: 5 };
    const r = parsePhraseRequest(old);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.exploration).toMatchObject({ mode: "focus", focusDegree: "7", count: 7, seed: 1 });
    expect(r.request.tonic).toBe("Eb");
    expect(parsePhraseRequest({ ...old, targetDegree: undefined }).ok).toBe(false);
  });
});
