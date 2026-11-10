import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHRASE_REQUEST,
  generatePhrase,
  midi,
  notesOf,
  parsePhraseRequest,
  phraseSpecFromRequest,
  phraseToIR,
  targetOptions,
  validateMusicIR,
  type PhraseRequest,
} from "../src";
import { acceptanceSpec } from "./grammar.helpers";

const titles = (spec: Parameters<typeof generatePhrase>[0]) => {
  const r = generatePhrase(spec);
  if (!r.ok) throw new Error(r.reason);
  return r.candidates.map((c) => `${c.summary}|${c.choices.pitches.map(midi).join()}|${c.choices.rhythm.id}`);
};

describe("the Phrase Constructor's request", () => {
  it("the default request is the acceptance experiment", () => {
    expect(titles(phraseSpecFromRequest(DEFAULT_PHRASE_REQUEST))).toEqual(titles(acceptanceSpec()));
  });

  it("builds valid documents for the minor ii–V–i too, with a half-diminished ii", () => {
    const req: PhraseRequest = { ...DEFAULT_PHRASE_REQUEST, tonic: "A", mode: "minor", targetDegree: "5", candidates: 3 };
    const spec = phraseSpecFromRequest(req);
    expect(spec.progression.map((p) => p.chord.symbol)).toEqual(["Bm7b5", "E7", "Am7"]);
    const r = generatePhrase(spec);
    if (!r.ok) throw new Error(r.reason);
    for (const c of r.candidates) {
      expect(validateMusicIR(phraseToIR(c, spec)), c.summary).toEqual([]);
      expect(notesOf(c.events as never).at(-1)!.functions.harmonic).toEqual(["fifth"]);
    }
  });

  it("lists the degrees the final chord can be targeted on, spelled for the key", () => {
    const c = targetOptions("C", "major");
    expect(c.chord).toBe("Cmaj7");
    expect(c.options.find((o) => o.degree === "3")).toEqual({ degree: "3", note: "E", role: "third", kind: "chord-tone" });
    expect(c.options.map((o) => o.degree)).toEqual(expect.arrayContaining(["1", "3", "5", "7", "9", "#11", "13"]));
    expect(targetOptions("Eb", "major").options.find((o) => o.degree === "7")!.note).toBe("D");
    expect(targetOptions("A", "minor").chord).toBe("Am7");
  });

  it("restores a stored request, and treats a damaged one as untrusted", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_PHRASE_REQUEST));
    const ok = parsePhraseRequest(stored);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.request).toEqual(DEFAULT_PHRASE_REQUEST);

    const bad = parsePhraseRequest({ ...stored, tonic: "H", bpm: 9000, register: [80, 60], maxLeap: 0, outline: { direction: "sideways", counts: [] }, embellishment: { kind: "wobble", step: "x" }, candidates: 99 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.issues.join(" | ");
      for (const word of ["tonic", "bpm", "register", "maxLeap", "outline.direction", "outline.counts", "embellishment.kind", "embellishment.step", "candidates"]) expect(text).toContain(word);
    }
    for (const junk of [null, 5, "x", [], {}, { tonic: "C" }]) {
      expect(() => parsePhraseRequest(junk)).not.toThrow();
      expect(parsePhraseRequest(junk).ok).toBe(false);
    }
  });

  it("asks for as many candidates as the user wants, up to the limit, and they are distinct", () => {
    const r = generatePhrase(phraseSpecFromRequest({ ...DEFAULT_PHRASE_REQUEST, candidates: 30 }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.candidates).toHaveLength(30);
    expect(new Set(r.candidates.map((c) => c.choices.pitches.map(midi).join() + c.choices.rhythm.id)).size).toBe(30);
    expect(parsePhraseRequest({ ...DEFAULT_PHRASE_REQUEST, candidates: 41 }).ok).toBe(false);
  });

  it("ignores unknown fields instead of carrying them along", () => {
    const r = parsePhraseRequest({ ...JSON.parse(JSON.stringify(DEFAULT_PHRASE_REQUEST)), surprise: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect("surprise" in r.request).toBe(false);
  });
});
