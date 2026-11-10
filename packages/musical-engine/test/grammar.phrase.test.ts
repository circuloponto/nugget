import { describe, expect, it } from "vitest";
import {
  buildScale,
  fadd,
  feq,
  formatNote,
  formatPitch,
  frac,
  fstr,
  generatePhrase,
  iiVI,
  midi,
  notesOf,
  parseChordSymbol,
  phraseToIR,
  pitchClass,
  renderDocument,
  scheduleFrames,
  toSampleFrameExact,
  validateMusicIR,
  type PhraseCandidate,
  type PhraseSpec,
} from "../src";
import { acceptanceSpec, iiVIProgression } from "./grammar.helpers";
import { ALL_TONICS } from "./helpers";

function must(spec: PhraseSpec) {
  const r = generatePhrase(spec);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const pitchNames = (c: PhraseCandidate) => notesOf(c.events as never).map((n) => formatPitch(n.pitch));
const timing = (c: PhraseCandidate) => c.events.map((e) => `${e.kind}@${fstr(e.onset)}+${fstr(e.duration)}`);
const nameClass = (p: Parameters<typeof formatNote>[0]) => formatNote(p);

describe("the acceptance experiment: Dm7 → G7 → Cmaj7, outline G7, enclose E, arrive on the downbeat of Cmaj7", () => {
  const spec = acceptanceSpec();
  const result = must(spec);

  it("returns several ranked candidates, each a valid MusicIR document", () => {
    expect(result.candidates).toHaveLength(5);
    expect(result.considered).toBeGreaterThan(100);
    for (const c of result.candidates) {
      const ir = phraseToIR(c, spec);
      expect(validateMusicIR(ir), c.summary).toEqual([]);
    }
  });

  it("the target is E (the third of Cmaj7), arriving at exactly 2 whole notes", () => {
    for (const c of result.candidates) {
      const notes = notesOf(c.events as never);
      const t = notes[notes.length - 1]!;
      expect(c.targetNote).toBe(t.id);
      expect(nameClass(t.pitch)).toMatch(/^E$/);
      expect(feq(t.onset, frac(2))).toBe(true);
      expect(t.functions.harmonic).toEqual(["third"]);
      expect(t.functions.metric).toBe("downbeat");
      expect(t.functions.structural).toEqual(["target"]);
    }
  });

  it("every candidate encloses the target: one semitone above and one below, and ends a step from it", () => {
    for (const c of result.candidates) {
      const notes = notesOf(c.events as never);
      const t = notes[notes.length - 1]!;
      const enclosure = c.gestures.find((g) => g.kind === "enclosure")!;
      expect(enclosure, c.summary).toBeDefined();
      const members = notes.filter((n) => enclosure.notes.includes(n.id));
      expect(members.map((n) => midi(n.pitch) - midi(t.pitch)).sort((a, b) => a - b)).toEqual([-1, 1]);
      // the member names are the chromatic neighbours of E: F above, D# below
      expect(members.map((n) => formatNote(n.pitch)).sort()).toEqual(["D#", "F"]);
      const prev = notes[notes.length - 2]!;
      expect(Math.abs(midi(prev.pitch) - midi(t.pitch))).toBe(1);
    }
  });

  it("the outline is an arpeggio of G7: every outline note is a G7 tone, and the gesture records its construction", () => {
    const g7 = new Set(parseChordSymbol("G7").tones.map(pitchClass));
    for (const c of result.candidates) {
      const outline = c.gestures.find((g) => g.kind === "arpeggiation")!;
      expect(outline.steps[0]!.op).toBe("arpeggiate");
      const notes = notesOf(c.events as never).filter((n) => outline.notes.includes(n.id));
      expect(notes.length).toBeGreaterThanOrEqual(3);
      for (const n of notes) {
        expect(g7.has(pitchClass(n.pitch))).toBe(true);
        expect(n.functions.structural).toEqual(["outline"]);
      }
      const enc = c.gestures.find((g) => g.kind === "enclosure")!;
      expect(enc.steps.map((s) => s.op)).toEqual(["target", "surround"]);
      expect(enc.target).toBe("tg-1");
    }
  });

  it("rhythm: time is tiled exactly from the phrase start to the arrival, so nothing overlaps and nothing is lost", () => {
    for (const c of result.candidates) {
      let at = spec.start;
      for (const e of c.events) {
        if (feq(e.onset, frac(2))) break;
        expect(feq(e.onset, at), `${c.summary}: ${fstr(e.onset)} vs ${fstr(at)}`).toBe(true);
        at = fadd(e.onset, e.duration);
      }
      expect(feq(at, frac(2))).toBe(true);
    }
  });

  it("the rhythm is not uniform eighth notes", () => {
    for (const c of result.candidates) {
      const durations = new Set(notesOf(c.events as never).map((n) => fstr(n.duration)));
      expect(durations.size, c.summary).toBeGreaterThan(1);
    }
  });

  it("hard constraints hold: register, leap, fret window, and a real fingering for every note", () => {
    for (const c of result.candidates) {
      const notes = notesOf(c.events as never);
      for (const n of notes) {
        expect(midi(n.pitch)).toBeGreaterThanOrEqual(55);
        expect(midi(n.pitch)).toBeLessThanOrEqual(84);
        expect(n.position).toBeDefined();
        expect(n.position!.fret).toBeGreaterThanOrEqual(0);
        expect(n.position!.fret).toBeLessThanOrEqual(15);
      }
      for (let i = 1; i < notes.length; i++) expect(Math.abs(midi(notes[i]!.pitch) - midi(notes[i - 1]!.pitch))).toBeLessThanOrEqual(9);
      for (let i = 1; i < notes.length; i++) {
        const a = notes[i - 1]!.position!;
        const b = notes[i]!.position!;
        if (a.fret > 0 && b.fret > 0) expect(Math.abs(a.fret - b.fret)).toBeLessThanOrEqual(5);
      }
    }
  });

  it("ranking is transparent: named parts, weights, a total that is their weighted mean, and a disclaimer", () => {
    const first = result.candidates[0]!;
    const best = Math.max(...result.candidates.map((c) => c.score.total));
    expect(first.score.total).toBe(best);
    for (const c of result.candidates) {
      const wsum = c.score.parts.reduce((a, p) => a + p.weight, 0);
      const mean = c.score.parts.reduce((a, p) => a + p.value * p.weight, 0) / wsum;
      expect(c.score.total).toBeCloseTo(mean, 3);
      expect(c.score.parts.map((p) => p.name)).toEqual(expect.arrayContaining(["structural coherence", "melodic continuity", "target alignment", "rhythmic variety", "instrumental practicality"]));
      for (const p of c.score.parts) {
        expect(p.value).toBeGreaterThanOrEqual(0);
        expect(p.value).toBeLessThanOrEqual(1);
        expect(p.why.length).toBeGreaterThan(0);
      }
      expect(c.score.disclaimer).toMatch(/not a measure of musical beauty/);
    }
  });

  it("is deterministic: the same request gives the same candidates", () => {
    const again = must(spec);
    expect(again.candidates.map((c) => pitchNames(c).join() + "|" + timing(c).join())).toEqual(result.candidates.map((c) => pitchNames(c).join() + "|" + timing(c).join()));
  });

  it("candidates differ from one another (a pitch line and a rhythm are not repeated)", () => {
    const keys = result.candidates.map((c) => pitchNames(c).join() + "|" + c.choices.rhythm.id);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("plays back sample-exactly: the arrival lands on its exact frame and the render is finite", () => {
    const c = result.candidates[0]!;
    const ir = phraseToIR(c, spec, { bpm: 100 });
    const sr = 48000;
    const schedule = scheduleFrames(ir, sr);
    const target = schedule.events.find((e) => e.id === c.targetNote)!;
    expect(target.startFrame).toBe(toSampleFrameExact(frac(2), frac(100), sr, frac(1, 4)));
    expect(target.startFrame).toBe(230400);
    const { samples, peak } = renderDocument(ir, { sampleRate: sr });
    expect(peak).toBeGreaterThan(0);
    expect(samples.every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
  });
});

describe("other targets and gestures from the same grammar", () => {
  it("targets an extension: the 9th of Cmaj7 is D, enclosed by C# and Eb, and is a valid document", () => {
    const spec = acceptanceSpec({ target: { chordIndex: 2, degree: "9" } });
    const r = must(spec);
    for (const c of r.candidates) {
      const notes = notesOf(c.events as never);
      const t = notes[notes.length - 1]!;
      expect(formatNote(t.pitch)).toBe("D");
      expect(t.functions.harmonic).toEqual(["ninth"]);
      const enc = notes.filter((n) => c.gestures.find((g) => g.kind === "enclosure")!.notes.includes(n.id));
      expect(enc.map((n) => formatNote(n.pitch)).sort()).toEqual(["C#", "Eb"]);
      expect(validateMusicIR(phraseToIR(c, spec))).toEqual([]);
    }
  });

  it("targets the seventh of G7 from Dm7 material (phrase starts at the beginning)", () => {
    const spec = acceptanceSpec({ start: frac(0), target: { chordIndex: 1, degree: "7" }, outline: { direction: "any", chordIndex: 0 } });
    const r = must(spec);
    for (const c of r.candidates) {
      const t = notesOf(c.events as never).at(-1)!;
      expect(formatNote(t.pitch)).toBe("F");
      expect(feq(t.onset, frac(1))).toBe(true);
      expect(validateMusicIR(phraseToIR(c, spec))).toEqual([]);
    }
  });

  it("builds approaches as well as enclosures: a two-note diatonic approach from below", () => {
    const spec = acceptanceSpec({ embellishment: { kind: "approach", step: "diatonic", side: "below", count: 2 } });
    const r = must(spec);
    for (const c of r.candidates) {
      expect(c.gestures.some((g) => g.kind === "approach")).toBe(true);
      const notes = notesOf(c.events as never);
      const t = notes.at(-1)!;
      const approach = notes.filter((n) => c.gestures.find((g) => g.kind === "approach")!.notes.includes(n.id));
      expect(approach.map((n) => formatNote(n.pitch))).toEqual(["C", "D"]);
      expect(midi(approach[1]!.pitch)).toBeLessThan(midi(t.pitch));
      expect(validateMusicIR(phraseToIR(c, spec))).toEqual([]);
    }
  });

  it("can be just an approach with no outline, and just silence before the target", () => {
    const a = must(acceptanceSpec({ outline: null, embellishment: { kind: "approach", step: "chromatic", side: "below" } }));
    expect(a.candidates[0]!.gestures.some((g) => g.kind === "arpeggiation")).toBe(false);
    const b = must(acceptanceSpec({ outline: null, embellishment: { kind: "none", step: "any" } }));
    const c = b.candidates[0]!;
    expect(notesOf(c.events as never)).toHaveLength(1);
    expect(c.events[0]!.kind).toBe("rest");
    expect(validateMusicIR(phraseToIR(c, acceptanceSpec({ outline: null, embellishment: { kind: "none", step: "any" } })))).toEqual([]);
  });

  it("works in every major key, with correct spelling (flat keys and sharp keys)", () => {
    for (const tonic of ALL_TONICS) {
      const spec = acceptanceSpec({ progression: iiVIProgression(tonic), space: { scale: buildScale(tonic, "major").notes }, candidates: 3 });
      const r = generatePhrase(spec);
      expect(r.ok, `${tonic}: ${r.ok ? "" : r.reason}`).toBe(true);
      if (!r.ok) continue;
      for (const c of r.candidates) expect(validateMusicIR(phraseToIR(c, spec)), `${tonic} ${c.summary}`).toEqual([]);
    }
  });

  it("works over the minor ii–V–i (half-diminished ii)", () => {
    const { chords, romans } = iiVI("A", "minor");
    const spec = acceptanceSpec({
      progression: chords.map((chord, i) => ({ chord, onset: frac(i), duration: frac(1), roman: romans[i]! })),
      space: { scale: buildScale("A", "harmonicMinor").notes },
    });
    const r = must(spec);
    for (const c of r.candidates) expect(validateMusicIR(phraseToIR(c, spec)), c.summary).toEqual([]);
  });
});

describe("hard constraints are hard; soft preferences only rank", () => {
  it("a tighter maximum leap is honoured by every candidate", () => {
    const spec = acceptanceSpec({ hard: { register: [55, 84], maxLeap: 5 } });
    const r = must(spec);
    for (const c of r.candidates) {
      const m = notesOf(c.events as never).map((n) => midi(n.pitch));
      for (let i = 1; i < m.length; i++) expect(Math.abs(m[i]! - m[i - 1]!)).toBeLessThanOrEqual(5);
    }
  });

  it("a maximum leap of one semitone cannot hold a chromatic enclosure (D# to F is two), and says so", () => {
    expect(generatePhrase(acceptanceSpec({ outline: null, hard: { register: [55, 84], maxLeap: 1 } })).ok).toBe(false);
    expect(generatePhrase(acceptanceSpec({ outline: null, hard: { register: [55, 84], maxLeap: 2 } })).ok).toBe(true);
  });

  it("a register that excludes the target fails with a reason, rather than returning something wrong", () => {
    const r = generatePhrase(acceptanceSpec({ hard: { register: [60, 62] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/register/);
  });

  it("the register limits the embellishment notes too, not only the target", () => {
    // E4 alone fits in [64, 64]; the enclosure's D# and F lie outside it, so nothing can be built
    expect(generatePhrase(acceptanceSpec({ outline: null, hard: { register: [64, 64] } })).ok).toBe(false);
    const wide = must(acceptanceSpec({ hard: { register: [62, 67] }, outline: null }));
    for (const c of wide.candidates) for (const n of notesOf(c.events as never)) expect(midi(n.pitch)).toBeGreaterThanOrEqual(62);
  });

  it("an impossible fret window fails instead of returning an unplayable phrase", () => {
    const r = generatePhrase(acceptanceSpec({ hard: { register: [55, 84], fretRange: [0, 2] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/hard constraint/);
  });

  it("a high register keeps every note inside it and still has a fingering", () => {
    const r = must(acceptanceSpec({ hard: { register: [70, 84], maxLeap: 9 } }));
    for (const c of r.candidates) for (const n of notesOf(c.events as never)) expect(midi(n.pitch)).toBeGreaterThanOrEqual(70);
  });

  it("rejects a degree the chord cannot name and a target before the start", () => {
    expect(generatePhrase(acceptanceSpec({ target: { chordIndex: 2, degree: "b2" } })).ok).toBe(false);
    expect(generatePhrase(acceptanceSpec({ start: frac(3) })).ok).toBe(false);
    expect(generatePhrase(acceptanceSpec({ target: { chordIndex: 9, degree: "3" } })).ok).toBe(false);
  });

  it("a direction preference changes the top candidate", () => {
    const asc = must(acceptanceSpec({ soft: { direction: "ascending" } })).candidates[0]!;
    const desc = must(acceptanceSpec({ soft: { direction: "descending" } })).candidates[0]!;
    const net = (c: PhraseCandidate) => {
      const m = notesOf(c.events as never).map((n) => midi(n.pitch));
      return m[m.length - 1]! - m[0]!;
    };
    expect(net(asc)).toBeGreaterThan(0);
    expect(net(desc)).toBeLessThan(0);
    expect(asc.score.parts.some((p) => p.name === "direction preference")).toBe(true);
  });

  it("a rhythm intent changes the feel: triplets use exact thirds, and 'no rests' has none", () => {
    const trip = must(acceptanceSpec({ rhythm: { feel: "triplet" }, outline: { direction: "any", counts: [4] } }));
    for (const c of trip.candidates) {
      const hasTriplet = notesOf(c.events as never).some((n) => ["1/12", "1/6"].includes(fstr(n.duration)));
      expect(hasTriplet).toBe(true);
    }
    const noRests = must(acceptanceSpec({ rhythm: { rests: false } }));
    for (const c of noRests.candidates) expect(c.events.every((e) => e.kind === "note")).toBe(true);
  });
});

describe("transforming a phrase while holding part of it fixed", () => {
  const spec = acceptanceSpec();
  const original = must(spec).candidates[0]!;

  it("keep the rhythm, change the pitches: identical timing, different notes, same harmonic intention", () => {
    const r = must({ ...spec, fixed: { rhythm: original.choices.rhythm }, avoidPitchSequences: [original.choices.pitches.map(midi)] });
    for (const c of r.candidates) {
      expect(timing(c)).toEqual(timing(original));
      expect(c.choices.pitches.map(midi)).not.toEqual(original.choices.pitches.map(midi));
      const t = notesOf(c.events as never).at(-1)!;
      expect(formatNote(t.pitch)).toBe("E");
      expect(feq(t.onset, frac(2))).toBe(true);
    }
  });

  it("keep the pitches and their construction, change the rhythm: the notes and gestures are identical, the timing is not", () => {
    const r = must({ ...spec, fixed: { template: original }, rhythm: { shape: "accelerating", density: 3 } });
    expect(r.candidates.some((c) => c.choices.rhythm.id !== original.choices.rhythm.id)).toBe(true);
    for (const c of r.candidates) {
      expect(c.choices.pitches.map(midi)).toEqual(original.choices.pitches.map(midi));
      expect(c.gestures.map((g) => [g.id, g.kind, g.notes.join()])).toEqual(original.gestures.map((g) => [g.id, g.kind, g.notes.join()]));
      const t = notesOf(c.events as never).at(-1)!;
      expect(feq(t.onset, frac(2))).toBe(true);
      expect(validateMusicIR(phraseToIR(c, spec)), c.summary).toEqual([]);
    }
  });

  it("a rhythm that cannot carry the pitches yields nothing, not a broken phrase", () => {
    const tooMany = { ...original.choices.rhythm, hits: original.choices.rhythm.hits + 3 };
    const r = generatePhrase({ ...spec, fixed: { rhythm: tooMany } });
    expect(r.ok).toBe(false);
  });
});
