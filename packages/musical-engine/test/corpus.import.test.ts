import { describe, expect, it } from "vitest";
import { corpus, validateMusicIR } from "../src";
import { codes, ctx, harmony, importOk, note, score } from "./corpus.helpers";

describe("MusicXML import: notation is preserved exactly", () => {
  it("reads pitches, exact durations and chords from a simple bar", () => {
    const xml = score([harmony("C", "major") + note({ p: "C4", d: 4 }) + note({ p: "E4", d: 2 }) + note({ p: "F#4", d: 2 }) + harmony("G", "dominant") + note({ p: "G4", d: 8 })]);
    const { piece, report } = importOk(xml);
    expect(report.status).toBe("ok");
    expect(piece.events.map((e) => (e.kind === "note" ? e.pitch.name : "r"))).toEqual(["C4", "E4", "F#4", "G4"]);
    expect(piece.events.map((e) => `${e.onset}+${e.duration}`)).toEqual(["0+1/4", "1/4+1/8", "3/8+1/8", "1/2+1/2"]);
    expect(piece.events.map((e) => (e.kind === "note" ? e.pitch.midi : -1))).toEqual([60, 64, 66, 67]);
    expect(piece.harmony.map((h) => [h.symbol, h.onset, h.duration, h.tones?.join(" ")])).toEqual([
      ["C", "0", "1/2", "C E G"],
      ["G7", "1/2", "1/2", "G B D F"],
    ]);
    expect(piece.measures[0]).toMatchObject({ pickup: false, length: "1", nominalLength: "1", startPhase: "0" });
  });

  it("keeps provenance and licence, and does not trust the XML's own creator field", () => {
    const xml = score([note({ p: "C4", d: 16 })], { creator: "Music21", title: "Tune" });
    const r = corpus.importMusicXml(xml, ctx("tune", { composer: "Trad.", source: "Mick Peat" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.piece.provenance.corpus).toMatchObject({ license: "GPL-3.0", usage: "tests only" });
    expect(r.piece.provenance.catalog).toEqual({ composer: "Trad.", source: "Mick Peat" });
    expect(r.piece.provenance.xml.creatorField).toBe("Music21");
    expect(r.piece.provenance.contentHash).toBe(corpus.fnv1a(xml));
    expect(codes(r.report)).toContain("xml-creator-ignored");
    expect(r.piece.tuning.system).toBe("12-tet");
  });

  it("detects a pickup and measures metric position from where the bar really starts", () => {
    const { piece, report } = importOk(score([note({ p: "G4", d: 4 }), note({ p: "C5", d: 16 })]));
    expect(piece.measures[0]).toMatchObject({ pickup: true, length: "1/4", startPhase: "3/4" });
    expect(codes(report)).toContain("pickup");
    const line = corpus.melodyFromCorpusPiece(piece);
    expect(line.notes[0]!.phase).toEqual({ num: 3, den: 4 });
    expect(line.notes[1]!.weight).toBe(4);
  });

  it("joins tied notes into one sounding note and keeps the parts", () => {
    const m1 = note({ p: "C4", d: 4 }) + note({ p: "E4", d: 4 }) + note({ p: "F4", d: 4 }) + note({ p: "D4", d: 4, tie: "start" });
    const m2 = note({ p: "D4", d: 8, tie: "stop" }) + note({ p: "E4", d: 8 });
    const { piece, report } = importOk(score([m1, m2]));
    const tied = piece.events.find((e) => e.kind === "note" && e.tiedParts)!;
    expect(tied).toMatchObject({ onset: "3/4", duration: "3/4" });
    expect(tied.kind === "note" && tied.tiedParts!.map((p) => p.onset + "+" + p.duration)).toEqual(["3/4+1/4", "1+1/2"]);
    expect(piece.events).toHaveLength(5);
    expect(report.counts.tiedChains).toBe(1);
    expect(report.irLoss.join(" ")).toMatch(/tie/);
  });

  it("warns about a tie with no partner and about a tie into a different pitch, and keeps the notes", () => {
    const a = importOk(score([note({ p: "C4", d: 8, tie: "start" }) + note({ p: "D4", d: 8 }) + note({ p: "E4", d: 16 })]));
    expect(codes(a.report)).toContain("tie-mismatch");
    expect(a.piece.events).toHaveLength(3);
    const b = importOk(score([note({ p: "C4", d: 8 }) + note({ p: "D4", d: 8, tie: "stop" }) + note({ p: "E4", d: 16 })]));
    expect(codes(b.report)).toContain("tie-orphan-stop");
  });

  it("keeps tuplets exact: three in the time of two eighths is 1/12 each", () => {
    const trip = (step: string) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>`;
    const body = trip("C") + trip("D") + trip("E") + `<note><pitch><step>G</step><octave>4</octave></pitch><duration>36</duration><type>half</type><dot/></note>`;
    const xml = score([body]).replace("<divisions>4</divisions>", "<divisions>12</divisions>");
    const { piece, report } = importOk(xml);
    expect(piece.events.slice(0, 3).map((e) => e.duration)).toEqual(["1/12", "1/12", "1/12"]);
    expect(piece.events.map((e) => e.onset)).toEqual(["0", "1/12", "1/6", "1/4"]);
    expect(piece.events[0]!.tuplet).toEqual({ actual: 3, normal: 2 });
    expect(report.counts.tupletNotes).toBe(3);
    expect(codes(report)).not.toContain("duration-type-mismatch");
    expect(report.irLoss.join(" ")).toMatch(/tuplet/);
  });

  it("records grace notes on the next note, takes no time for them, and reports the IR loss", () => {
    const { piece, report } = importOk(score([note({ p: "D5", d: 0, grace: true, type: "eighth" }) + note({ p: "C5", d: 16 })]));
    const n = piece.events[0]!;
    expect(n.kind === "note" && n.graces!.map((g) => g.pitch.name)).toEqual(["D5"]);
    expect(n.onset).toBe("0");
    expect(report.counts.graceNotes).toBe(1);
    expect(report.irLoss.join(" ")).toMatch(/grace/);
  });

  it("keeps notation marks as data and counts elements it does not interpret", () => {
    const fermata = note({ p: "C4", d: 8, extra: "<notations><fermata/></notations>" });
    const odd = note({ p: "D4", d: 8, extra: "<mystery-element/>" });
    const { piece, report } = importOk(score([fermata + odd]));
    expect(piece.events[0]!.marks).toContain("fermata");
    expect(report.unsupported["note/mystery-element"]).toBe(1);
  });

  it("derives the tonic from key and mode, and does not assume one when the mode is absent", () => {
    const k = (fifths: number, mode: string | null) => importOk(score([note({ p: "C4", d: 16 })], { fifths, mode })).piece.measures[0]!.key!;
    expect(k(2, "major").tonic).toBe("D");
    expect(k(2, "dorian").tonic).toBe("E");
    expect(k(0, "minor").tonic).toBe("A");
    expect(k(-3, "minor").tonic).toBe("C");
    expect(k(0, "mixolydian").tonic).toBe("G");
    expect(k(3, "major").tonic).toBe("A");
    const none = k(1, null);
    expect(none.tonic).toBeUndefined();
    expect(none.mode).toBeUndefined();
    expect(importOk(score([note({ p: "C4", d: 16 })], { fifths: 1, mode: null })).report.issues.map((i) => i.code)).toContain("key-mode-unspecified");
  });

  it("records repeats, endings, meter and key changes", () => {
    const m1 = { body: note({ p: "C4", d: 16 }), left: `<repeat direction="forward"/>` };
    const m2 = { body: note({ p: "D4", d: 16 }), right: `<ending number="1" type="stop"/><repeat direction="backward"/>` };
    const m3 = { body: note({ p: "E4", d: 12 }), attrs: `<attributes><key><fifths>1</fifths><mode>major</mode></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>` };
    const { piece, report } = importOk(score([m1, m2, m3]));
    expect(piece.measures[0]!.repeat).toEqual({ forward: true });
    expect(piece.measures[1]!.repeat).toMatchObject({ backward: true });
    expect(piece.measures[1]!.ending).toEqual({ numbers: "1", type: "stop" });
    expect(piece.measures[2]!.meter.text).toBe("3/4");
    expect(piece.measures[2]!.key).toMatchObject({ fifths: 1, tonic: "G" });
    expect(codes(report)).toEqual(expect.arrayContaining(["meter-change", "key-change"]));
    expect(report.counts).toMatchObject({ meterChanges: 1, keyChanges: 1, repeats: 2 });
    expect(report.irLoss.join(" ")).toMatch(/meter changes.*repeat|repeat.*meter changes/s);
  });
});

describe("MusicXML import: nothing is corrected silently", () => {
  it("reports a measure that does not add up and keeps it as written", () => {
    const { piece, report } = importOk(score([note({ p: "C4", d: 16 }), note({ p: "D4", d: 12 }), note({ p: "E4", d: 16 })]));
    expect(codes(report)).toContain("measure-length-mismatch");
    expect(report.status).toBe("ok-with-warnings");
    expect(piece.measures[1]).toMatchObject({ length: "3/4", nominalLength: "1" });
  });

  it("reports a written type that disagrees with the duration and uses the duration", () => {
    const { piece, report } = importOk(score([note({ p: "C4", d: 8, type: "quarter" }) + note({ p: "D4", d: 8 })]));
    expect(codes(report)).toContain("duration-type-mismatch");
    expect(piece.events[0]!.duration).toBe("1/2");
  });

  it("warns on a short final measure that is not a pickup completion", () => {
    const { report } = importOk(score([note({ p: "C4", d: 16 }), note({ p: "D4", d: 8 })]));
    expect(codes(report)).toContain("short-final-measure");
  });

  it("flags chord kinds it does not know and does not guess their tones", () => {
    const { piece, report } = importOk(score([harmony("C", "quarter-tone-cluster") + note({ p: "C4", d: 16 })]));
    expect(codes(report)).toContain("unknown-chord-kind");
    expect(piece.harmony[0]!.tones).toBeUndefined();
    expect(report.unsupported["harmony/kind:quarter-tone-cluster"]).toBe(1);
  });

  it("spells slash chords and augmented sevenths correctly", () => {
    const m1 = harmony("G", "major", "B") + note({ p: "G4", d: 8 }) + harmony("C", "augmented-seventh") + note({ p: "C5", d: 8 });
    const m2 = harmony("B", "minor", undefined, -1) + note({ p: "D5", d: 16 });
    const { piece } = importOk(score([m1, m2]));
    expect(piece.harmony.map((h) => h.symbol)).toEqual(["G/B", "Caug7", "Bbm"]);
    expect(piece.harmony[1]!.tones).toEqual(["C", "E", "G#", "Bb"]);
    expect(piece.harmony[2]!.tones).toEqual(["Bb", "Db", "F"]);
  });

  it("fails, with a reason, on what a monophonic line cannot hold", () => {
    const fail = (xml: string) => {
      const r = corpus.importMusicXml(xml, ctx());
      expect(r.ok).toBe(false);
      return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
    };
    expect(fail(score([note({ p: "C4", d: 8 }) + `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration></note>` + note({ p: "D4", d: 8 })]))).toContain("chord-note");
    expect(fail(score([note({ p: "C4", d: 16 })], { parts: 2 }))).toContain("multiple-parts");
    expect(fail(score([note({ p: "C4", d: 8 }) + "<backup><duration>8</duration></backup>" + note({ p: "E4", d: 8 })]))).toContain("backup-forward");
    expect(fail(score([note({ p: "C4", d: 16 }).replace("<octave>4</octave>", "<octave>11</octave>")]))).toContain("bad-pitch");
    expect(fail(score([note({ p: "C4", d: 16 }).replace("<step>C</step>", "<step>H</step>")]))).toContain("bad-pitch");
    expect(fail(score([note({ p: "C4", d: 16 }).replace("<duration>16</duration>", "<duration>0</duration>")]))).toContain("bad-duration");
    expect(fail("<score-partwise><part><measure/></part>")).toContain("xml-malformed");
    expect(fail("<score-timewise/>")).toContain("timewise-unsupported");
    expect(fail("<html/>")).toContain("not-musicxml");
    expect(fail(score([note({ p: "r", d: 16 })]))).toContain("no-notes");
    expect(fail(score([note({ p: "C4", d: 8 }) + `<note><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration><voice>2</voice></note>`]))).toContain("multiple-voices");
  });

  it("refuses an entity bomb in a score and reports it as malformed", () => {
    const xml = score([note({ p: "C4", d: 16 })], { doctype: '<!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>' });
    const r = corpus.importMusicXml(xml, ctx());
    expect(r.ok).toBe(false);
    expect(r.report.issues[0]!.code).toBe("xml-malformed");
  });

  it("never throws on junk", () => {
    for (const junk of ["", "null", "<<<", "\u0000\u0001", "<a>" + "x".repeat(1000), "{}"]) expect(() => corpus.importMusicXml(junk, ctx())).not.toThrow();
  });
});

describe("MusicIR projection", () => {
  it("produces a valid MusicIR with exact times, chords and an observed-provenance transformation", () => {
    const { piece } = importOk(score([harmony("C", "major") + note({ p: "C4", d: 4 }) + note({ p: "D4", d: 4 }) + note({ p: "E4", d: 4 }) + note({ p: "F4", d: 4 }), harmony("G", "dominant") + note({ p: "G4", d: 16 })]));
    const p = corpus.corpusPieceToIR(piece);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(validateMusicIR(p.ir)).toEqual([]);
    expect(p.ir.meter).toEqual({ groups: [1, 1, 1, 1], unit: "1/4" });
    expect(p.ir.chords.map((c) => c.symbol)).toEqual(["C", "G7"]);
    expect(p.ir.events.filter((e) => e.kind === "note")).toHaveLength(5);
    expect(p.ir.transformations[0]).toMatchObject({ op: "corpus-import", provenance: { status: "observed" } });
    // D4 and F4 are not tones of C: labelled, not explained away
    const roles = p.ir.events.filter((e) => e.kind === "note").map((e) => (e.kind === "note" ? e.roles?.melodic : undefined));
    expect(roles).toEqual([undefined, "non-chord-tone", undefined, "non-chord-tone", undefined]);
    expect(p.loss.join(" ")).toMatch(/key signature/);
  });

  it("projects slash chords without their bass and says so", () => {
    const { piece } = importOk(score([harmony("G", "major", "B") + note({ p: "G4", d: 16 })]));
    const p = corpus.corpusPieceToIR(piece);
    expect(p.ok && p.ir.chords[0]!.symbol).toBe("G");
    expect(p.loss.join(" ")).toMatch(/bass/);
  });

  it("refuses to squeeze a microtonal pitch into a 12-tone IR, and explains", () => {
    const { piece } = importOk(score([note({ p: "C4", d: 16, alter: 0.5 })]));
    expect(piece.events[0]!.kind === "note" && piece.events[0]!.pitch.midi).toBe(60.5);
    const p = corpus.corpusPieceToIR(piece);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.issues[0]!.message).toMatch(/12-tone/);
  });
});

