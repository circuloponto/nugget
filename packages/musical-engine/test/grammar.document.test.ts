import { describe, expect, it } from "vitest";
import {
  buildCycleProgressionIR,
  editPhraseNote,
  frac,
  generatePhrase,
  MUSIC_IR_SEMANTICS_VERSION,
  notesOf,
  parseMusicIR,
  phraseToIR,
  renderDocument,
  rhythmizeIR,
  serializeMusicIR,
  validateMusicIR,
  verifyGrammarSemantics,
  DEFAULT_RHYTHM,
  type IRNoteEvent,
  type MusicIR,
} from "../src";
import { acceptanceSpec } from "./grammar.helpers";

const spec = acceptanceSpec();
const r = generatePhrase(spec);
if (!r.ok) throw new Error(r.reason);
const candidate = r.candidates[0]!;
const ir = phraseToIR(candidate, spec, { request: { target: "3" } });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = (): Json => JSON.parse(JSON.stringify(ir));
const issuesOf = (doc: Json) => validateMusicIR(doc).map((i) => `${i.path}: ${i.message}`);
const noteOf = (doc: Json, id: string): Json => doc.events.find((e: Json) => e.id === id);

describe("a generated phrase is a complete MusicIR document", () => {
  it("is valid, with a semantic layer that references events instead of copying them", () => {
    expect(validateMusicIR(ir)).toEqual([]);
    expect(ir.semantics!.version).toBe(MUSIC_IR_SEMANTICS_VERSION);
    expect(ir.semantics!.targets).toHaveLength(1);
    expect(ir.semantics!.gestures!.length).toBeGreaterThanOrEqual(3);
    const gesture = ir.semantics!.gestures!.find((g) => g.kind === "enclosure")!;
    // gestures hold note ids only, never pitches or times
    expect(JSON.stringify(gesture)).not.toMatch(/"midi"|"onset"/);
    for (const id of gesture.notes) expect(ir.events.some((e) => e.id === id)).toBe(true);
  });

  it("records how the phrase was built, and how to ask for it again", () => {
    const t = ir.transformations.find((x) => x.op === "phrase-generate")!;
    expect(t.params.request).toBe(JSON.stringify({ target: "3" }));
    expect(t.params.summary).toBe(candidate.summary);
    expect(ir.semantics!.gestures!.find((g) => g.kind === "enclosure")!.steps.map((s) => s.op)).toEqual(["target", "surround"]);
  });

  it("states per-note functions along four independent dimensions", () => {
    const f = ir.semantics!.noteFunctions!;
    const target = f.find((x) => x.note === candidate.targetNote)!;
    expect(target).toMatchObject({ harmonic: ["third"], melodic: ["arrival"], metric: "downbeat", structural: ["target"] });
    const nonChord = f.find((x) => x.harmonic!.length === 0)!;
    expect(nonChord.melodic!.length).toBeGreaterThan(0); // a non-chord tone always carries a melodic explanation
  });

  it("round-trips through canonical text unchanged", () => {
    const text = serializeMusicIR(ir);
    const parsed = parseMusicIR(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeMusicIR(parsed.ir)).toBe(text);
    expect(parsed.ir.semantics).toEqual(ir.semantics);
  });

  it("plays: the document renders to finite audio", () => {
    const out = renderDocument(ir, { sampleRate: 44100 });
    expect(out.peak).toBeGreaterThan(0);
    expect(out.samples.every(Number.isFinite)).toBe(true);
  });
});

describe("backward compatibility", () => {
  it("Phase 1/2 documents have no semantic layer and are unaffected", () => {
    const p = buildCycleProgressionIR({ tonic: "C", scale: "major", cycle: 2 });
    if (!p.ok) throw new Error(p.reason);
    expect(p.ir.semantics).toBeUndefined();
    expect(validateMusicIR(p.ir)).toEqual([]);
    const re = rhythmizeIR(p.ir, { ...DEFAULT_RHYTHM, pattern: "A.x." });
    expect(validateMusicIR(re)).toEqual([]);
  });

  it("an empty semantic layer is valid, and a Phase 2 document stays valid with one added", () => {
    const p = buildCycleProgressionIR({ tonic: "G", scale: "major", cycle: 3 });
    if (!p.ok) throw new Error(p.reason);
    expect(validateMusicIR({ ...p.ir, semantics: { version: 1 } })).toEqual([]);
  });

  it("seventh chords pass the existing chord checks, and a wrong seventh label is caught", () => {
    const doc = clone();
    const bass = doc.events.find((e: Json) => e.voice === "bass" && e.roles.harmonic === "root");
    bass.roles.harmonic = "seventh";
    expect(issuesOf(doc).some((m) => /labelled seventh/.test(m))).toBe(true);
  });
});

describe("the semantic layer is verified against the events it references", () => {
  it("a target whose arrival disagrees with its note is rejected", () => {
    const doc = clone();
    doc.semantics.targets[0].arrival = "7/4";
    expect(issuesOf(doc).some((m) => /target arrives at 7\/4, but its note/.test(m))).toBe(true);
  });

  it("a target whose pitch disagrees with its note is rejected", () => {
    const doc = clone();
    doc.semantics.targets[0].pitch = { name: "F4", midi: 65 };
    expect(issuesOf(doc).some((m) => /differs from its note/.test(m))).toBe(true);
  });

  it("a target naming the wrong degree for its note is rejected", () => {
    const doc = clone();
    doc.semantics.targets[0].degree = "5";
    expect(issuesOf(doc).some((m) => /degree 5 of Cmaj7/.test(m))).toBe(true);
  });

  it("a target pointing at the wrong chord segment is rejected", () => {
    const doc = clone();
    doc.semantics.targets[0].chord = "c-1";
    expect(issuesOf(doc).some((m) => /arrives during Cmaj7, not G7/.test(m))).toBe(true);
  });

  it("a target on a chord with no such degree is rejected", () => {
    const doc = clone();
    doc.semantics.targets[0].degree = "b2";
    expect(issuesOf(doc).some((m) => /has no degree "b2"/.test(m))).toBe(true);
  });

  /** Move one note of the generated enclosure so both neighbours lie on the same side (keeping its fret correct). */
  const breakEnclosure = (provenance?: "user") => {
    const doc = clone();
    const g = doc.semantics.gestures.find((x: Json) => x.kind === "enclosure");
    const target = noteOf(doc, doc.semantics.targets[0].note);
    const below = g.notes.map((id: string) => noteOf(doc, id)).find((n: Json) => n.pitch.midi < target.pitch.midi);
    below.pitch = { name: "F#4", midi: 66 };
    below.instrument.fret += 66 - 63;
    if (provenance) g.provenance = { status: provenance, source: "edit" };
    return doc;
  };

  it("a generated enclosure that no longer surrounds its target is rejected", () => {
    expect(issuesOf(breakEnclosure()).some((m) => /an enclosure needs a note one or two semitones above AND below/.test(m))).toBe(true);
  });

  it("…but a gesture a user has edited is history, not a promise, so the same change is accepted", () => {
    expect(issuesOf(breakEnclosure("user"))).toEqual([]);
  });

  it("an arpeggiation containing a note that is not a chord tone is rejected", () => {
    const doc = clone();
    const g = doc.semantics.gestures.find((x: Json) => x.kind === "arpeggiation");
    const n = noteOf(doc, g.notes[0]);
    n.pitch = { name: "G#3", midi: n.pitch.midi + 1 };
    n.instrument.fret += 1;
    n.pitch.name = n.pitch.name.replace(/\d$/, String(Math.floor(n.pitch.midi / 12) - 1));
    expect(issuesOf(doc).some((m) => /not an outline of it/.test(m))).toBe(true);
  });

  it("a gesture naming a missing note, or listing notes out of time order, is rejected", () => {
    const doc = clone();
    doc.semantics.gestures[0].notes[0] = "n-nope";
    expect(issuesOf(doc).some((m) => /unknown note "n-nope"/.test(m))).toBe(true);
    const doc2 = clone();
    const g = doc2.semantics.gestures.find((x: Json) => x.kind === "arpeggiation");
    g.notes.reverse();
    expect(issuesOf(doc2).some((m) => /time order/.test(m))).toBe(true);
  });

  it("a note function that mislabels the harmony is rejected", () => {
    const doc = clone();
    const f = doc.semantics.noteFunctions.find((x: Json) => x.harmonic.includes("root") || x.harmonic.includes("third"));
    f.harmonic = [f.harmonic[0] === "root" ? "fifth" : "root"];
    expect(issuesOf(doc).some((m) => /is labelled/.test(m))).toBe(true);
  });

  it("an interpretation must give evidence, a confidence in 0..1, and real alternatives", () => {
    const doc = clone();
    doc.semantics.interpretations = [{ id: "i-1", kind: "x", notes: [candidate.targetNote], confidence: 1.5, evidence: [], alternatives: ["i-9"] }];
    const msgs = issuesOf(doc);
    expect(msgs.some((m) => /confidence/.test(m))).toBe(true);
    expect(msgs.some((m) => /state its evidence/.test(m))).toBe(true);
    expect(msgs.some((m) => /unknown interpretation "i-9"/.test(m))).toBe(true);
  });

  it("semantic ids may not collide with each other or with the document body", () => {
    const doc = clone();
    doc.semantics.gestures[0].id = doc.events[0].id;
    expect(issuesOf(doc).some((m) => /collides/.test(m))).toBe(true);
    const doc2 = clone();
    doc2.semantics.gestures[1].id = doc2.semantics.gestures[0].id;
    expect(issuesOf(doc2).some((m) => /duplicate semantic id/.test(m))).toBe(true);
  });

  it("motif statements must really have the motif's intervals and durations", () => {
    const doc = clone();
    const ids = (doc.semantics.noteFunctions as Json[]).slice(0, 3).map((f) => f.note);
    const evs = ids.map((id) => noteOf(doc, id));
    const intervals: number[] = [evs[1]!.pitch.midi - evs[0]!.pitch.midi, evs[2]!.pitch.midi - evs[1]!.pitch.midi];
    doc.semantics.motifs = [{ id: "mo-1", intervals, durations: evs.map((e: Json) => e.duration), accents: [1, 1, 1], statements: [{ id: "ms-1", notes: ids }], lineage: [] }];
    expect(issuesOf(doc)).toEqual([]);
    doc.semantics.motifs[0].intervals = [intervals[0]! + 1, intervals[1]];
    expect(issuesOf(doc).some((m) => /do not match the motif/.test(m))).toBe(true);
    doc.semantics.motifs[0].intervals = intervals;
    doc.semantics.motifs[0].durations[1] = "1/64";
    expect(issuesOf(doc).some((m) => /differs from the motif's/.test(m))).toBe(true);
  });

  it("phrase relations must join phrases that exist", () => {
    const doc = clone();
    doc.semantics.phraseRelations = [{ id: "pr-1", kind: "repetition", from: "ph-1", to: "ph-404" }];
    expect(issuesOf(doc).some((m) => /unknown phrase "ph-404"/.test(m))).toBe(true);
  });

  it("a malformed semantic layer is reported, never thrown", () => {
    for (const bad of [[], "text", 5, { version: 1, targets: "no" }, { version: 1, gestures: [null] }, { version: 2 }, { version: 1, targets: [{ id: "t" }] }]) {
      const doc = { ...clone(), semantics: bad };
      expect(() => validateMusicIR(doc)).not.toThrow();
      expect(issuesOf(doc).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
    expect(() => verifyGrammarSemantics({ ...ir, semantics: { version: 1, gestures: [{ id: "g", kind: "x", steps: null, provenance: {} }] } } as unknown as MusicIR)).not.toThrow();
  });
});

describe("editing a phrase", () => {
  const firstEnclosure = ir.semantics!.gestures!.find((g) => g.kind === "enclosure")!;
  const member = firstEnclosure.notes[0]!;
  const eventOf = (doc: MusicIR, id: string) => doc.events.find((e): e is IRNoteEvent => e.kind === "note" && e.id === id)!;

  it("changing a pitch respells it, re-frets it, recomputes its roles, and demotes the gestures that contain it", () => {
    const before = eventOf(ir, member);
    const res = editPhraseNote(ir, member, { midi: before.pitch.midi + 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const after = eventOf(res.ir, member);
    expect(after.pitch.midi).toBe(before.pitch.midi + 2);
    expect(after.provenance).toEqual({ status: "user", source: "edit" });
    expect(after.instrument).toBeDefined();
    const g = res.ir.semantics!.gestures!;
    expect(g.find((x) => x.id === firstEnclosure.id)!.provenance.status).toBe("user");
    expect(g.find((x) => x.kind === "arpeggiation" && !x.notes.includes(member))!.provenance.status).toBe("generated");
    // every other note is untouched
    for (const e of ir.events) if (e.id !== member) expect(res.ir.events.find((x) => x.id === e.id)).toEqual(e);
    expect(validateMusicIR(res.ir)).toEqual([]);
  });

  it("editing the target note updates its target, re-deriving the degree", () => {
    const tId = candidate.targetNote;
    const t = eventOf(ir, tId);
    const res = editPhraseNote(ir, tId, { midi: t.pitch.midi + 3 }); // G: the fifth of Cmaj7
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tg = res.ir.semantics!.targets![0]!;
    expect(tg.degree).toBe("5");
    expect(tg.pitch!.midi).toBe(t.pitch.midi + 3);
    const toF = editPhraseNote(ir, tId, { midi: t.pitch.midi + 1 }); // F: not a Cmaj7 tone
    expect(toF.ok).toBe(true);
    if (toF.ok) expect(toF.ir.semantics!.targets![0]!.degree).toBe("non-chord");
  });

  it("an edit that would make the document invalid is refused, with the reasons, and changes nothing", () => {
    const first = ir.events.find((e): e is IRNoteEvent => e.kind === "note" && e.voice === "melody")!;
    const res = editPhraseNote(ir, first.id, { duration: frac(5, 2) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => /overlaps/.test(i.message))).toBe(true);
    expect(editPhraseNote(ir, "n-missing", { midi: 60 }).ok).toBe(false);
  });

  it("an edited document still plays", () => {
    const res = editPhraseNote(ir, member, { midi: eventOf(ir, member).pitch.midi - 1 });
    if (!res.ok) throw new Error(res.issues.map((i) => i.message).join("; "));
    expect(renderDocument(res.ir, { sampleRate: 44100 }).samples.every(Number.isFinite)).toBe(true);
  });
});
