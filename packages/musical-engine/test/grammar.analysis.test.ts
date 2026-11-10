import { describe, expect, it } from "vitest";
import {
  analyzeMelody,
  formatNote,
  generatePhrase,
  interpretationsToIR,
  notesOf,
  parseChordSymbol,
  phraseToIR,
  pitchClass,
  validateMusicIR,
  withInterpretations,
  type Interpretation,
} from "../src";
import { acceptanceSpec, iiVIProgression, melodyDoc } from "./grammar.helpers";
import { ALL_TONICS } from "./helpers";
import { buildScale } from "../src";

const kinds = (a: ReturnType<typeof analyzeMelody>) => a.interpretations.map((i) => i.kind);
const find = (a: ReturnType<typeof analyzeMelody>, kind: string): Interpretation => {
  const r = a.interpretations.find((i) => i.kind === kind);
  if (!r) throw new Error(`no ${kind} in [${kinds(a).join(", ")}]`);
  return r;
};

describe("analysis: the user's example, F4 – D#4 – E4 over Cmaj7", () => {
  const doc = melodyDoc([["Cmaj7", "0", "2"]], [["F4", "7/8", "1/16"], ["D#4", "15/16", "1/16"], ["E4", "1", "1/2"]]);
  const a = analyzeMelody(doc);

  it("reports definite FACTS apart from interpretations", () => {
    const [f, d, e] = a.facts;
    expect(e!.harmonic).toMatchObject({ role: "third", kind: "chord-tone" });
    expect(d!.harmonic).toBeNull();
    expect(f!.harmonic).toBeNull(); // the natural 11th is not offered as an extension of a major seventh
    expect(e!.metric).toEqual({ label: "downbeat", accent: 3 });
    expect(f!.toNext).toMatchObject({ semitones: -2, motion: "step", direction: "down" });
    expect(d!.toNext).toMatchObject({ semitones: 1, motion: "chromatic-step", direction: "up" });
    expect(f!.fromPrevious).toBeNull();
    expect(e!.toNext).toBeNull();
  });

  it("identifies a chromatic enclosure of E, with the evidence that supports it", () => {
    const r = find(a, "chromatic-enclosure");
    expect(r.notes).toEqual(["m1", "m2", "m3"]);
    expect(r.target).toBe("m3");
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
    const text = r.evidence.join(" | ");
    expect(text).toMatch(/F4 is 1 semitone above E4/);
    expect(text).toMatch(/D#4 is 1 semitone below it, on the other side/);
    expect(text).toMatch(/the target E4 is the third of the sounding chord/);
    expect(text).toMatch(/arrives on a downbeat/);
    expect(text).toMatch(/both surrounding notes are non-chord tones/);
  });

  it("also offers the narrower reading of D# as a chromatic approach: several interpretations at once, none forced", () => {
    expect(kinds(a)).toEqual(expect.arrayContaining(["chromatic-enclosure", "chromatic-approach"]));
    const approach = a.interpretations.find((i) => i.kind === "chromatic-approach" && i.notes[0] === "m2")!;
    expect(approach.target).toBe("m3");
  });

  it("interpretations are claims: each has evidence, a confidence in 0..1, and ids", () => {
    for (const r of a.interpretations) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.confidence).toBeLessThanOrEqual(0.95);
      expect(r.id).toMatch(/^i-\d+$/);
    }
    expect(new Set(a.interpretations.map((i) => i.id)).size).toBe(a.interpretations.length);
  });
});

describe("analysis depends on context", () => {
  const notes = [["F4", "7/8", "1/16"], ["D#4", "15/16", "1/16"], ["E4", "1", "1/2"]] as [string, string, string][];

  it("the same three notes are a weaker enclosure when the target is not a chord tone", () => {
    const strong = find(analyzeMelody(melodyDoc([["Cmaj7", "0", "2"]], notes)), "chromatic-enclosure");
    const weak = find(analyzeMelody(melodyDoc([["Ab", "0", "2"]], notes)), "chromatic-enclosure");
    expect(weak.confidence).toBeLessThan(strong.confidence);
    expect(weak.evidence.join(" ")).toMatch(/not a chord tone: weaker evidence/);
  });

  it("two neighbours on the SAME side of the target are not an enclosure", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "2"]], [["F#4", "7/8", "1/16"], ["F4", "15/16", "1/16"], ["E4", "1", "1/2"]]));
    expect(kinds(a)).not.toContain("enclosure");
    expect(kinds(a)).not.toContain("chromatic-enclosure");
  });

  it("a weak metric position lowers the reading too", () => {
    const onBeat = find(analyzeMelody(melodyDoc([["Cmaj7", "0", "2"]], notes)), "chromatic-enclosure");
    const off = find(analyzeMelody(melodyDoc([["Cmaj7", "0", "2"]], [["F4", "13/16", "1/16"], ["D#4", "7/8", "1/16"], ["E4", "15/16", "1/2"]])), "chromatic-enclosure");
    expect(off.confidence).toBeLessThan(onBeat.confidence);
  });

  it("D# over G7 is not the b13: that would be an Eb (spelling matters), so it stays a non-chord tone", () => {
    const a = analyzeMelody(melodyDoc([["G7", "0", "1"]], [["D#4", "0", "1/4"]]));
    expect(a.facts[0]!.harmonic).toBeNull();
    const b = analyzeMelody(melodyDoc([["G7", "0", "1"]], [["Eb4", "0", "1/4"]]));
    expect(b.facts[0]!.harmonic).toMatchObject({ label: "b13", kind: "alteration" });
  });

  it("a note may be several things: F over Cmaj7 as the 9th-less non-chord tone, E as the third, D as the ninth", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["D4", "0", "1/4"], ["E4", "1/4", "1/4"], ["F4", "1/2", "1/4"]]));
    expect(a.facts[0]!.harmonic).toMatchObject({ role: "ninth", kind: "extension" });
    expect(a.facts[1]!.harmonic).toMatchObject({ role: "third", kind: "chord-tone" });
    expect(a.facts[2]!.harmonic).toBeNull();
  });
});

describe("analysis: the embellishment vocabulary, each recognised from its context", () => {
  it("passing tone: a non-chord tone stepping between two chord tones in one direction", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["G4", "0", "1/8"], ["F4", "1/8", "1/8"], ["E4", "1/4", "1/4"]]));
    const r = find(a, "passing-tone");
    expect(r.notes).toEqual(["m1", "m2", "m3"]);
    expect(r.evidence.join(" ")).toMatch(/connects two chord tones/);
  });

  it("chromatic passing tone", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["C4", "0", "1/8"], ["C#4", "1/8", "1/8"], ["D4", "1/4", "1/4"]]));
    expect(kinds(a)).toContain("chromatic-passing-tone");
  });

  it("rival readings of the same note are linked as alternatives (F between G and E is both passing and an approach)", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["G4", "0", "1/8"], ["F4", "1/8", "1/8"], ["E4", "1/4", "1/4"]]));
    const passing = find(a, "passing-tone");
    const approach = find(a, "chromatic-approach");
    expect(passing.alternatives).toContain(approach.id);
    expect(approach.alternatives).toContain(passing.id);
  });

  it("neighbour tones, upper and lower, diatonic and chromatic", () => {
    // F# is a conventional tension (#11) of Cmaj7, so the triad is used here: over C, F# is a plain non-chord tone
    const upper = analyzeMelody(melodyDoc([["C", "0", "1"]], [["E4", "0", "1/8"], ["F#4", "1/8", "1/8"], ["E4", "1/4", "1/4"]]));
    const r = find(upper, "neighbor-tone");
    expect(r.evidence.join(" ")).toMatch(/upper neighbour/);
    const lower = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["E4", "0", "1/8"], ["D#4", "1/8", "1/8"], ["E4", "1/4", "1/4"]]));
    const l = find(lower, "chromatic-neighbor-tone");
    expect(l.evidence.join(" ")).toMatch(/lower neighbour/);
  });

  it("appoggiatura: an accented non-chord tone reached by leap and resolved by step the other way", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "2"]], [["C4", "3/4", "1/4"], ["F5", "1", "1/4"], ["E5", "5/4", "1/2"]]));
    const r = find(a, "appoggiatura");
    expect(r.notes).toEqual(["m2", "m3"]);
    expect(r.evidence.join(" ")).toMatch(/reached by a leap of 17 semitones/);
    expect(r.evidence.join(" ")).toMatch(/opposite to the leap/);
  });

  it("suspension: prepared in the old chord, dissonant on the new one, resolved down by step", () => {
    const a = analyzeMelody(melodyDoc([["Dm7", "0", "1"], ["G7", "1", "1"]], [["C5", "3/4", "1/4"], ["C5", "1", "1/4"], ["B4", "5/4", "1/2"]]));
    const r = find(a, "suspension");
    expect(r.notes).toEqual(["m1", "m2", "m3"]);
    expect(r.evidence[0]).toMatch(/^preparation: C5 is consonant in Dm7/);
    expect(r.evidence[1]).toMatch(/^dissonance:/);
    expect(r.evidence[2]).toMatch(/^resolution: it moves down by a step to B4/);
  });

  it("retardation: the same, resolving upward", () => {
    const a = analyzeMelody(melodyDoc([["C", "0", "1"], ["F", "1", "1"]], [["E4", "3/4", "1/4"], ["E4", "1", "1/4"], ["F4", "5/4", "1/2"]]));
    expect(kinds(a)).toContain("retardation");
    expect(kinds(a)).not.toContain("suspension");
  });

  it("a held note without preparation is NOT called a suspension", () => {
    const a = analyzeMelody(melodyDoc([["Dm7", "0", "1"], ["G7", "1", "1"]], [["E4", "3/4", "1/4"], ["C5", "1", "1/4"], ["B4", "5/4", "1/2"]]));
    expect(kinds(a)).not.toContain("suspension");
  });

  it("anticipation: a tone of the next chord arrives early and is sounded again with the chord", () => {
    const a = analyzeMelody(melodyDoc([["C", "0", "1"], ["F", "1", "1"]], [["E4", "3/4", "1/8"], ["F4", "7/8", "1/8"], ["F4", "1", "1/2"]]));
    const r = find(a, "anticipation");
    expect(r.notes[0]).toBe("m2");
    expect(r.evidence.join(" ")).toMatch(/sounded again as the chord arrives/);
  });

  it("escape tone: approached by step, left by a leap in the opposite direction", () => {
    const a = analyzeMelody(melodyDoc([["C", "0", "1"]], [["E4", "0", "1/4"], ["F4", "1/4", "1/4"], ["C4", "1/2", "1/4"]]));
    expect(kinds(a)).toContain("escape-tone");
  });

  it("cambiata: step down to a dissonance, leap down a third, step up", () => {
    const a = analyzeMelody(melodyDoc([["C", "0", "1"]], [["G4", "0", "1/4"], ["F4", "1/4", "1/4"], ["D4", "1/2", "1/4"], ["E4", "3/4", "1/4"]]));
    expect(kinds(a)).toContain("cambiata");
  });

  it("pedal tone: a pitch returning through changing harmony, clashing in some of it", () => {
    const a = analyzeMelody(melodyDoc([["C", "0", "1"], ["F", "1", "1"], ["G", "2", "1"]], [["C4", "0", "1/2"], ["C4", "1", "1/2"], ["C4", "2", "1/4"], ["C4", "9/4", "1/4"]]));
    const r = find(a, "pedal-tone");
    expect(r.notes).toHaveLength(4);
    expect(r.evidence.join(" ")).toMatch(/while the harmony changes across 3 chords/);
    expect(r.evidence.join(" ")).toMatch(/non-chord tone in 2 of the 4/);
  });

  it("arpeggiation: consecutive tones of one chord moving by thirds and larger", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["C4", "0", "1/4"], ["E4", "1/4", "1/4"], ["G4", "1/2", "1/4"], ["B4", "3/4", "1/4"]]));
    const r = find(a, "arpeggiation");
    expect(r.notes).toHaveLength(4);
    expect(r.evidence[0]).toMatch(/4 consecutive tones of Cmaj7: C4 \(root\), E4 \(third\), G4 \(fifth\), B4 \(seventh\)/);
    expect(r.evidence[1]).toMatch(/upward/);
  });

  it("guide-tone line: F (3rd of Dm7) – F (7th of G7) – E (3rd of Cmaj7)", () => {
    const a = analyzeMelody(melodyDoc([["Dm7", "0", "1"], ["G7", "1", "1"], ["Cmaj7", "2", "1"]], [["F4", "0", "1"], ["F4", "1", "1"], ["E4", "2", "1"]]));
    const r = find(a, "guide-tone-line");
    expect(r.notes).toEqual(["m1", "m2", "m3"]);
    expect(r.evidence[0]).toMatch(/F4 \(third\) → F4 \(seventh\) → E4 \(third\)/);
  });

  it("sequence: the same interval and rhythm pattern restated a step lower", () => {
    const a = analyzeMelody(melodyDoc([["C", "0", "2"]], [["D4", "0", "1/8"], ["F4", "1/8", "1/8"], ["E4", "1/4", "1/4"], ["C4", "1/2", "1/8"], ["Eb4", "5/8", "1/8"], ["D4", "3/4", "1/4"]]));
    const r = find(a, "melodic-sequence");
    expect(r.evidence.join(" ")).toMatch(/2 semitones lower/);
  });
});

describe("analysis admits what it cannot explain", () => {
  it("a lone non-chord tone with no clear figure is listed as unresolved, not forced into a label", () => {
    const a = analyzeMelody(melodyDoc([["Cmaj7", "0", "1"]], [["C4", "0", "1/4"], ["Ab4", "3/8", "1/8"], ["C5", "1/2", "1/4"]]));
    expect(a.facts[1]!.harmonic).toBeNull();
    expect(kinds(a).filter((k) => ["passing-tone", "neighbor-tone", "appoggiatura", "step-approach", "chromatic-approach", "escape-tone"].includes(k))).toEqual([]);
    expect(a.unresolved.map((u) => u.note)).toEqual(["m2"]);
    expect(a.unresolved[0]!.reason).toMatch(/does not clearly fit/);
  });

  it("notes separated by a long silence are not joined into one gesture", () => {
    const together = analyzeMelody(melodyDoc([["Cmaj7", "0", "3"]], [["F4", "0", "1/16"], ["D#4", "1/16", "1/16"], ["E4", "1/8", "1/4"]]));
    expect(kinds(together)).toContain("chromatic-enclosure");
    const apart = analyzeMelody(melodyDoc([["Cmaj7", "0", "3"]], [["F4", "0", "1/16"], ["D#4", "1/16", "1/16"], ["E4", "2", "1/4"]]));
    expect(kinds(apart)).not.toContain("chromatic-enclosure");
  });

  it("returns facts and no readings for a single note, and nothing at all for an empty voice", () => {
    expect(analyzeMelody(melodyDoc([["C", "0", "1"]], [["C4", "0", "1"]])).interpretations).toEqual([]);
    const empty = analyzeMelody(melodyDoc([["C", "0", "1"]], []));
    expect(empty.facts).toEqual([]);
    expect(empty.interpretations).toEqual([]);
  });
});

describe("bidirectional: what the generator builds, the analyser recovers", () => {
  it("the enclosure of every generated candidate, in every key, is found with its own notes and target", () => {
    for (const tonic of ALL_TONICS) {
      const spec = acceptanceSpec({ progression: iiVIProgression(tonic), space: { scale: buildScale(tonic, "major").notes }, candidates: 3 });
      const r = generatePhrase(spec);
      if (!r.ok) throw new Error(`${tonic}: ${r.reason}`);
      for (const c of r.candidates) {
        const ir = phraseToIR(c, spec);
        const a = analyzeMelody(ir);
        const gesture = c.gestures.find((g) => g.kind === "enclosure")!;
        const found = a.interpretations.find((i) => /enclosure/.test(i.kind) && i.target === c.targetNote);
        expect(found, `${tonic}: ${c.summary} → [${kinds(a).join(", ")}]`).toBeDefined();
        expect(found!.notes.slice(0, 2).sort()).toEqual([...gesture.notes].sort());
        expect(found!.notes[2]).toBe(c.targetNote);
        expect(found!.confidence).toBeGreaterThan(0.6);
      }
    }
  });

  it("facts about a generated phrase agree with what the generator said about each note", () => {
    const spec = acceptanceSpec();
    const r = generatePhrase(spec);
    if (!r.ok) throw new Error(r.reason);
    for (const c of r.candidates) {
      const a = analyzeMelody(phraseToIR(c, spec));
      for (const n of notesOf(c.events as never)) {
        const fact = a.facts.find((f) => f.id === n.id)!;
        expect(fact.harmonic?.role ?? null, `${n.id} in ${c.summary}`).toBe(n.functions.harmonic[0] ?? null);
        expect(fact.metric.label).toBe(n.functions.metric);
      }
    }
  });

  it("never claims an arpeggiation unless every note is a tone of one chord", () => {
    const spec = acceptanceSpec({ outline: { direction: "any", counts: [3, 4] } });
    const r = generatePhrase(spec);
    if (!r.ok) throw new Error(r.reason);
    const g7 = new Set(parseChordSymbol("G7").tones.map(pitchClass));
    for (const c of r.candidates) {
      const ir = phraseToIR(c, spec);
      for (const i of analyzeMelody(ir).interpretations.filter((x) => x.kind === "arpeggiation")) {
        for (const id of i.notes) {
          const ev = ir.events.find((e) => e.id === id)!;
          if (ev.kind === "note") expect(g7.has(((ev.pitch.midi % 12) + 12) % 12)).toBe(true);
        }
      }
    }
  });

  it("stores interpretations in the document, which stays valid, and can be re-read", () => {
    const spec = acceptanceSpec();
    const r = generatePhrase(spec);
    if (!r.ok) throw new Error(r.reason);
    const ir = phraseToIR(r.candidates[0]!, spec);
    const a = analyzeMelody(ir);
    const withAnalysis = withInterpretations(ir, a);
    expect(validateMusicIR(withAnalysis)).toEqual([]);
    expect(withAnalysis.semantics!.gestures).toEqual(ir.semantics!.gestures); // construction history is untouched
    expect(withAnalysis.semantics!.interpretations).toEqual(interpretationsToIR(a));
    expect(formatNote({ letter: "E", accidental: 0 })).toBe("E");
  });
});
