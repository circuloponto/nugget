import { describe, expect, it } from "vitest";
import {
  analyzeVoices,
  classifyMotion,
  consonanceOf,
  describePhrase,
  findImitation,
  frac,
  fstr,
  generatePhrase,
  phraseToIR,
  relatePhrases,
  validateMusicIR,
  voicingTransition,
  withPhraseRelations,
  type VoiceEvent,
} from "../src";
import { acceptanceSpec, melodyDoc } from "./grammar.helpers";

const voice = (id: string, notes: [midi: number, onset: string, duration: string][]): VoiceEvent[] =>
  notes.map(([midi, onset, duration], i) => {
    const [n, d = "1"] = onset.split("/");
    const [dn, dd = "1"] = duration.split("/");
    return { id: `${id}${i}`, midi, onset: frac(Number(n), Number(d)), duration: frac(Number(dn), Number(dd)) };
  });

describe("counterpoint: motion between two voices", () => {
  it.each([
    [60, 62, 48, 50, "parallel"],
    [60, 62, 48, 53, "similar"],
    [60, 62, 48, 46, "contrary"],
    [60, 60, 48, 50, "oblique"],
    [60, 62, 48, 48, "oblique"],
    [60, 60, 48, 48, "static"],
    [72, 71, 60, 62, "contrary"],
  ] as const)("(%i→%i over %i→%i) is %s", (a0, a1, b0, b1, expected) => {
    expect(classifyMotion(a0, a1, b0, b1)).toBe(expected);
  });

  it("classifies vertical intervals, including compound and negative ones", () => {
    expect(consonanceOf(0)).toBe("perfect-consonance");
    expect(consonanceOf(7)).toBe("perfect-consonance");
    expect(consonanceOf(19)).toBe("perfect-consonance");
    for (const n of [3, 4, 8, 9, 15, -16]) expect(consonanceOf(n)).toBe("imperfect-consonance");
    expect(consonanceOf(5)).toBe("contextual");
    for (const n of [1, 2, 6, 10, 11, -1, 13]) expect(consonanceOf(n)).toBe("dissonance");
  });
});

describe("counterpoint: analysing two voices", () => {
  it("flags parallel perfect intervals, and only those", () => {
    const top = voice("t", [[72, "0", "1/4"], [74, "1/4", "1/4"], [76, "1/2", "1/4"]]);
    const bottom = voice("b", [[60, "0", "1/4"], [62, "1/4", "1/4"], [64, "1/2", "1/4"]]);
    const a = analyzeVoices(top, bottom);
    expect(a.moments.map((m) => m.interval)).toEqual([12, 12, 12]);
    expect(a.motions.map((m) => m.motion)).toEqual(["parallel", "parallel"]);
    expect(a.motions.every((m) => m.parallelPerfect)).toBe(true);
    const thirds = analyzeVoices(voice("t", [[64, "0", "1/4"], [65, "1/4", "1/4"]]), voice("b", [[60, "0", "1/4"], [61, "1/4", "1/4"]]));
    expect(thirds.motions[0]).toMatchObject({ motion: "parallel", parallelPerfect: false });
  });

  it("measures how independent the voices are", () => {
    const together = analyzeVoices(voice("t", [[72, "0", "1/4"], [74, "1/4", "1/4"], [76, "1/2", "1/4"]]), voice("b", [[60, "0", "1/4"], [62, "1/4", "1/4"], [64, "1/2", "1/4"]]));
    expect(together.independence).toEqual({ contraryOrOblique: 0, rhythmic: 0 });
    const free = analyzeVoices(voice("t", [[72, "0", "1/4"], [71, "1/4", "1/4"], [72, "1/2", "1/4"]]), voice("b", [[60, "0", "1/4"], [62, "1/4", "1/4"], [60, "1/2", "1/4"]]));
    expect(free.independence.contraryOrOblique).toBe(1);
    const offset = analyzeVoices(voice("t", [[72, "0", "1/2"], [74, "1/2", "1/2"]]), voice("b", [[60, "1/4", "1/2"], [62, "3/4", "1/2"]]));
    expect(offset.independence.rhythmic).toBe(1);
  });

  it("detects a voice exchange", () => {
    const a = analyzeVoices(voice("t", [[67, "0", "1/4"], [64, "1/4", "1/4"]]), voice("b", [[64, "0", "1/4"], [67, "1/4", "1/4"]]));
    expect(a.voiceExchanges).toHaveLength(1);
    expect(fstr(a.voiceExchanges[0]!.from)).toBe("0");
    expect(fstr(a.voiceExchanges[0]!.to)).toBe("1/4");
    expect(a.motions[0]!.motion).toBe("contrary");
  });

  it("detects imitation: the same intervals and rhythm, later and transposed", () => {
    const lead = voice("a", [[60, "0", "1/4"], [64, "1/4", "1/4"], [67, "1/2", "1/4"], [72, "3/4", "1/4"]]);
    const answer = voice("b", [[67, "1/2", "1/4"], [71, "3/4", "1/4"], [74, "1", "1/4"]]);
    const im = findImitation(lead, answer);
    expect(im).not.toBeNull();
    expect(fstr(im!.delay)).toBe("1/2");
    expect(im!.transposition).toBe(7);
    expect(im!.length).toBe(3);
    expect(analyzeVoices(lead, answer).imitation).toEqual(im);
    expect(findImitation(lead, voice("c", [[67, "1/2", "1/4"], [70, "3/4", "1/4"], [74, "1", "1/4"]]))).toBeNull();
  });

  it("describes how one voicing becomes the next, voice by voice", () => {
    const t = voicingTransition([48, 52, 55], [48, 53, 57]);
    expect(t.moves).toEqual([0, 1, 2]);
    expect(t.commonTones).toEqual([48]);
    expect(t.retainedVoices).toEqual([0]);
    expect(t.totalMotion).toBe(3);
    expect(voicingTransition([55, 48, 52], [52, 55, 59]).moves).toEqual([4, 3, 4]);
  });
});

describe("phrase structure: described, with evidence, never assumed", () => {
  const chords: [string, string, string][] = [["Cmaj7", "0", "3"]];

  it("describes a generated phrase: its contour, climax, silences and the way it ends", () => {
    const spec = acceptanceSpec();
    const r = generatePhrase(spec);
    if (!r.ok) throw new Error(r.reason);
    const ir = phraseToIR(r.candidates[0]!, spec);
    const d = describePhrase(ir, undefined, "melody");
    expect(d.notes.length).toBeGreaterThanOrEqual(5);
    expect(d.ending.kind).toBe("arrival"); // the E arrives by step on a downbeat
    expect(d.ending.onChordTone).toBe(true);
    expect(d.ending.metric).toBe("downbeat");
    expect(d.tension).toHaveLength(d.notes.length);
    const last = d.tension[d.tension.length - 1]!.value;
    expect(last).toBeLessThanOrEqual(Math.max(...d.tension.map((t) => t.value)));
    for (const t of d.tension) expect(t.value).toBeGreaterThanOrEqual(0);
  });

  it("silence is part of the structure: gaps between notes are reported with exact lengths", () => {
    const d = describePhrase(melodyDoc(chords, [["C4", "0", "1/4"], ["E4", "1/4", "1/4"], ["G4", "3/4", "1/4"]]));
    expect(d.silences.map((s) => [fstr(s.onset), fstr(s.duration)])).toEqual([["1/2", "1/4"]]);
  });

  it("distinguishes an arrival, an open ending and an interruption", () => {
    const arrival = describePhrase(melodyDoc(chords, [["F4", "3/4", "1/8"], ["E4", "1", "1/2"]]));
    expect(arrival.ending.kind).toBe("arrival");
    const open = describePhrase(melodyDoc(chords, [["C4", "0", "1/4"], ["G4", "1/4", "1/4"]]));
    expect(open.ending.kind).toBe("open");
    const interrupted = describePhrase(melodyDoc(chords, [["C4", "0", "1/4"], ["E4", "1/4", "1/4"], ["F4", "1/2", "1/8"]]));
    expect(interrupted.ending.kind).toBe("interrupted");
    expect(interrupted.ending.evidence.join(" ")).toMatch(/not a tone of the sounding chord/);
  });

  it("finds the climax: the highest note, and whether it is unique", () => {
    const d = describePhrase(melodyDoc(chords, [["C4", "0", "1/4"], ["G4", "1/4", "1/4"], ["C5", "1/2", "1/4"], ["E4", "3/4", "1/4"]]));
    expect(d.climax).toMatchObject({ note: "m3", index: 2, unique: true });
    expect(d.climax.position).toBeCloseTo(2 / 3);
    const tie = describePhrase(melodyDoc(chords, [["C5", "0", "1/4"], ["G4", "1/4", "1/4"], ["C5", "1/2", "1/4"]]));
    expect(tie.climax.unique).toBe(false);
  });

  it("accepts phrases of any length, with no four-bar assumption", () => {
    expect(() => describePhrase(melodyDoc(chords, [["C4", "0", "1/4"]]))).not.toThrow();
    const long = Array.from({ length: 23 }, (_, i): [string, string, string] => [i % 2 ? "E4" : "C4", `${i}/8`, "1/8"]);
    expect(describePhrase(melodyDoc([["Cmaj7", "0", "4"]], long)).notes).toHaveLength(23);
    expect(() => describePhrase(melodyDoc(chords, []))).toThrow(RangeError);
  });

  const rel = (a: [string, string, string][], b: [string, string, string][]) => relatePhrases(describePhrase(melodyDoc(chords, a)), describePhrase(melodyDoc(chords, b)));
  const A: [string, string, string][] = [["C4", "0", "1/8"], ["E4", "1/8", "1/8"], ["G4", "1/4", "1/4"]];

  it("repetition, repetition with variation, and no relation for unrelated phrases", () => {
    const same = rel(A, A.map(([n, o, d]) => [n, o, d] as [string, string, string]));
    expect(same.map((r) => r.kind)).toContain("repetition");
    const varied = rel(A, [["C4", "0", "1/8"], ["E4", "1/8", "1/8"], ["A4", "1/4", "1/4"]]);
    expect(varied.map((r) => r.kind)).toContain("repetition-with-variation");
    expect(varied.map((r) => r.kind)).not.toContain("repetition");
    const odd = rel(A, [["C4", "0", "1/16"], ["D4", "1/16", "1/16"], ["E4", "1/8", "1/16"], ["F4", "3/16", "1/16"], ["G4", "1/4", "1/2"]]);
    expect(odd.map((r) => r.kind)).not.toContain("repetition");
    expect(odd.map((r) => r.kind)).not.toContain("repetition-with-variation");
  });

  it("question and answer: an open phrase followed by an arrival, with shared material strengthening the claim", () => {
    const question: [string, string, string][] = [["C4", "0", "1/8"], ["E4", "1/8", "1/8"], ["G4", "1/4", "1/8"]];
    const answer: [string, string, string][] = [["C4", "1", "1/8"], ["E4", "9/8", "1/8"], ["F4", "5/4", "1/8"], ["E4", "3/2", "1/2"]];
    const r = rel(question, answer);
    const kinds = r.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["question-answer", "cadential-arrival"]));
    const qa = r.find((x) => x.kind === "question-answer")!;
    expect(qa.evidence.length).toBeGreaterThan(0);
    expect(qa.confidence).toBeLessThan(0.9); // proposed, not certain
  });

  it("stores proposed relations in the document, which stays valid", () => {
    const spec = acceptanceSpec();
    const gen = generatePhrase(spec);
    if (!gen.ok) throw new Error(gen.reason);
    const ir = phraseToIR(gen.candidates[0]!, spec);
    const two = { ...ir, semantics: { ...ir.semantics!, phrases: [...ir.semantics!.phrases!, { id: "ph-2", notes: ir.semantics!.phrases![0]!.notes.slice(0, 2) }] } };
    const out = withPhraseRelations(two, "ph-1", "ph-2", [{ kind: "continuation", confidence: 0.5, evidence: ["it begins where the first ended"] }]);
    expect(out.semantics!.phraseRelations).toEqual([{ id: "pr-1", kind: "continuation", from: "ph-1", to: "ph-2", evidence: ["it begins where the first ended"] }]);
    expect(validateMusicIR(out)).toEqual([]);
  });
});
