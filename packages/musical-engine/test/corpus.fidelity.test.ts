import { describe, expect, it } from "vitest";
import { corpus } from "../src";
import { ctx, lineOf, note, notes, score } from "./corpus.helpers";

/** Import an XML score as if it had been converted from the given ABC. */
function withAbc(xml: string, abc: string): corpus.CorpusPiece {
  const base = ctx("f1");
  const r = corpus.importMusicXml(xml, { ...base, provenance: { ...base.provenance, originalNotation: { format: "abc", path: "ABC/f1.abc", text: abc } } });
  if (!r.ok) throw new Error("import failed");
  return r.piece;
}
const abcOf = (body: string) => `X:1\nT:t\nM:4/4\nL:1/4\nK:C\n${body}\n`;

describe("the original notation is the check on the conversion", () => {
  it("reads notes and rests from ABC, ignoring chords, decorations, grace notes, comments, headers and lyrics", () => {
    const abc = `X:1\nT:Cab\nS:Bad Dog\nK:C\n% a comment with notes abc\n"Am"C !trill!D {gag}E z |"G7"F z2 (3GAB\nw:cab dog\n`;
    expect(corpus.abcTokens(abc)).toEqual(["N", "N", "N", "R", "N", "R", "N", "N", "N"]);
  });

  it("finds nothing to report when conversion is faithful, and keeps written rests as written", () => {
    const xml = score([notes("C4:4 D4:4 r:4 E4:4"), notes("G4:16")]);
    const piece = withAbc(xml, abcOf("CD z E|G4|"));
    const f = corpus.crossCheckAbc(piece);
    expect(f).toMatchObject({ checked: true, abcNotes: 4, xmlNotes: 4, abcRests: 1, xmlRests: 1, lostNotes: 0, extraNotes: 0, lostRests: 0 });
    expect(f.paddingRests).toEqual([]);
    expect(corpus.fidelityIssues(f)).toEqual([]);
    expect(corpus.applyFidelity(piece, f)).toBe(piece);
  });

  it("flags a rest the original never wrote as converter padding, and the analysis then ignores it", () => {
    const xml = score([notes("C4:4 D4:4 E4:4 F4:4"), notes("G4:4 r:12")]);
    const piece = withAbc(xml, abcOf("CDEF|G3|"));
    const f = corpus.crossCheckAbc(piece);
    expect(f.paddingRests).toEqual(["r1"]);
    expect(corpus.fidelityIssues(f).map((i) => i.code)).toEqual(["converter-padding-rests"]);
    const checked = corpus.applyFidelity(piece, f);
    expect(checked.events.find((e) => e.id === "r1")).toMatchObject({ suspect: "converter-padding", duration: "3/4" });
    const a = corpus.analyzeMelody(corpus.melodyFromCorpusPiece(checked));
    expect(a.rhythm.restCount).toBe(0);
    expect(a.rhythm.suspectRests).toBe(1);
    expect(a.rhythm.rests.timeShare).toBe(0);
    expect(a.rhythm.bars[1]!.restBeats).toBe(0);
    // the same score without the check counts it as silence
    const raw = corpus.analyzeMelody(corpus.melodyFromCorpusPiece(piece));
    expect(raw.rhythm.restCount).toBe(1);
  });

  it("a padding rest is not evidence of a phrase boundary; a written one is", () => {
    const xml = score([notes("C4:4 D4:4 E4:4 F4:4"), notes("G4:4 r:4 A4:4 B4:4")]);
    const written = corpus.analyzePhrases(corpus.melodyFromCorpusPiece(withAbc(xml, abcOf("CDEF|G z AB|"))));
    expect(written.candidates.some((c) => c.evidence.some((e) => e.kind === "rest"))).toBe(true);
    const piece = withAbc(xml, abcOf("CDEF|GAB|"));
    const padded = corpus.analyzePhrases(corpus.melodyFromCorpusPiece(corpus.applyFidelity(piece, corpus.crossCheckAbc(piece))));
    expect(padded.candidates.some((c) => c.evidence.some((e) => e.kind === "rest"))).toBe(false);
  });

  it("finds a note the converter lost (the Applejack case: a final note replaced by a rest)", () => {
    const xml = score([notes("C4:4 D4:4 E4:4 F4:4"), notes("G4:4 A4:4 r:8")]);
    const f = corpus.crossCheckAbc(withAbc(xml, abcOf("CDEF|GAB2|")));
    expect(f.lostNotes).toBe(1);
    expect(f.paddingRests).toHaveLength(1);
    const codes = corpus.fidelityIssues(f).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["note-lost-in-conversion", "converter-padding-rests"]));
  });

  it("pairs the earliest equal tokens, so the surplus rest is the later one", () => {
    const xml = score([notes("C4:4 r:4 D4:4 r:4"), notes("E4:4 r:12")]);
    const f = corpus.crossCheckAbc(withAbc(xml, abcOf("C z D z|E3|")));
    expect(f.abcRests).toBe(2);
    expect(f.paddingRests).toEqual(["r3"]);
  });

  it("notes the conversion added, and rests it lost", () => {
    const f1 = corpus.crossCheckAbc(withAbc(score([notes("C4:4 D4:4 E4:4 F4:4")]), abcOf("CDE2|")));
    expect(f1.extraNotes).toBe(1);
    const f2 = corpus.crossCheckAbc(withAbc(score([notes("C4:4 D4:4 E4:8")]), abcOf("CD z E|")));
    expect(f2.lostRests).toBe(1);
  });

  it("counts tied notes by their written parts", () => {
    const m1 = note({ p: "C4", d: 4 }) + note({ p: "E4", d: 4 }) + note({ p: "F4", d: 4 }) + note({ p: "D4", d: 4, tie: "start" });
    const m2 = note({ p: "D4", d: 8, tie: "stop" }) + note({ p: "E4", d: 8 });
    const f = corpus.crossCheckAbc(withAbc(score([m1, m2]), abcOf("CEFD-|D2 E2|")));
    expect(f).toMatchObject({ abcNotes: 6, xmlNotes: 6, lostNotes: 0, extraNotes: 0 });
  });

  it("says plainly when it cannot check", () => {
    const base = lineOf([notes("C4:16")]);
    void base;
    const r = corpus.importMusicXml(score([notes("C4:16")]), ctx("n1"));
    if (!r.ok) throw new Error("x");
    const f = corpus.crossCheckAbc(r.piece);
    expect(f.checked).toBe(false);
    expect(corpus.fidelityIssues(f)[0]).toMatchObject({ severity: "info", code: "fidelity-unchecked" });
  });
});
