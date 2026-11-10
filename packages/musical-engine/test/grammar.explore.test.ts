import { describe, expect, it } from "vitest";
import {
  buildScale,
  contourClassOf,
  contourShape,
  defaultGenerationSpace,
  explorePhrases,
  exploreDegrees,
  formatNote,
  frac,
  fstr,
  generatePhrase,
  lockAspects,
  makeChord,
  measureDiversity,
  midi,
  notesOf,
  parsePitch,
  phraseDistance,
  phraseToIR,
  progressionFor,
  rhythmPlans,
  rhythmTraits,
  seededRandom,
  validateMusicIR,
  verifyCandidate,
  type ExploredPhrase,
  type GenerationSpace,
  type ProgressionChord,
} from "../src";
import { acceptanceSpec } from "./grammar.helpers";
import { ALL_TONICS } from "./helpers";

const C_MAJOR = { scale: buildScale("C", "major").notes };
const cSpace = (over: Partial<GenerationSpace> = {}): GenerationSpace => defaultGenerationSpace(progressionFor("C", "major"), C_MAJOR, over);

function run(gs: GenerationSpace) {
  const r = explorePhrases(gs);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const key = (c: ExploredPhrase) => `${c.choices.pitches.map(midi).join(",")}|${c.traits.onsets.join(",")}`;
const timing = (c: ExploredPhrase) => c.events.map((e) => `${e.kind}@${fstr(e.onset)}+${fstr(e.duration)}`).join(" ");
const names = (c: ExploredPhrase) => notesOf(c.events as never).at(-1)!.pitch;

/** Every returned phrase must be sound: verified, valid, and at least `tau` apart from every other. */
function expectSound(list: readonly ExploredPhrase[], tau: number) {
  for (const c of list) {
    expect(verifyCandidate(c, c.spec), c.summary).toEqual([]);
    expect(validateMusicIR(phraseToIR(c, c.spec)), c.summary).toEqual([]);
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(phraseDistance(list[i]!.traits, list[j]!.traits).total, `${i} vs ${j}`).toBeGreaterThanOrEqual(tau);
  expect(new Set(list.map(key)).size).toBe(list.length);
}

describe("the original convergence problem, pinned (so a regression back to it is caught)", () => {
  it("the single-target generator returns one target and one idea however many are asked for", () => {
    const r = generatePhrase(acceptanceSpec({ candidates: 7 }));
    if (!r.ok) throw new Error(r.reason);
    const targets = new Set(r.candidates.map((c) => formatNote(notesOf(c.events as never).at(-1)!.pitch)));
    const embellishments = new Set(r.candidates.map((c) => c.choices.embellishment.replace(/ from (above|below)/, "")));
    expect(targets.size).toBe(1);
    expect(embellishments.size).toBe(1);
  });
});

describe("the acceptance scenario: Dm7 – G7 – Cmaj7 in C major, explored with defaults", () => {
  const gs = cSpace();
  const r = run(gs);
  const list = r.candidates;

  it("returns 6 to 8 contrasting phrases by default, not dozens", () => {
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(list.length).toBeLessThanOrEqual(8);
  });

  it("explores the targets of Cmaj7: C, E, G, B and the extensions D and A", () => {
    expect(exploreDegrees(gs.progression)).toEqual(["1", "3", "5", "7", "9", "13"]);
    const classes = new Set(list.map((c) => formatNote(names(c))));
    for (const n of classes) expect(["C", "E", "G", "B", "D", "A"]).toContain(n);
    expect(classes.size).toBeGreaterThanOrEqual(5);
    const chordTones = [...classes].filter((n) => ["C", "E", "G", "B"].includes(n));
    expect(chordTones.length).toBeGreaterThanOrEqual(3);
    expect([...classes].some((n) => n === "D" || n === "A")).toBe(true);
  });

  it("varies across octaves, contours, harmonic strategies, rhythmic gestures and lengths", () => {
    const m = measureDiversity(list);
    expect(m.coverage.registers).toBeGreaterThanOrEqual(2);
    expect(m.coverage.contours).toBeGreaterThanOrEqual(3);
    expect(m.coverage.strategies).toBeGreaterThanOrEqual(4);
    expect(m.coverage.rhythms).toBeGreaterThanOrEqual(4);
    expect(m.coverage.lengths).toBeGreaterThanOrEqual(2);
    expect(new Set(list.map((c) => c.traits.harmonic)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(list.map((c) => c.traits.targetPitch)).size).toBe(list.length);
  });

  it("every phrase is verified and valid, arrives exactly on the downbeat of Cmaj7, and no two are near duplicates", () => {
    expectSound(list, gs.distinctness);
    for (const c of list) {
      const t = notesOf(c.events as never).at(-1)!;
      expect(fstr(t.onset)).toBe("2");
      expect(t.functions.metric).toBe("downbeat");
    }
    expect(r.stats.rejectedInvalid).toBe(0);
    expect(r.stats.minDistance).toBeGreaterThanOrEqual(gs.distinctness);
  });

  it("measures its own diversity: the pairwise distances and coverage are reported and agree", () => {
    const m = measureDiversity(list);
    expect(r.stats.minDistance).toBeCloseTo(m.min, 2);
    expect(r.stats.meanDistance).toBeCloseTo(m.mean, 2);
    expect(r.stats.coverage).toEqual(m.coverage);
    expect(m.mean).toBeGreaterThan(0.4);
  });

  it("is far more diverse than the single-target generator was (same number of phrases, measured the same way)", () => {
    const old = generatePhrase(acceptanceSpec({ candidates: list.length }));
    if (!old.ok) throw new Error(old.reason);
    const oldTargets = new Set(old.candidates.map((c) => notesOf(c.events as never).at(-1)!.pitch.octave + formatNote(notesOf(c.events as never).at(-1)!.pitch)));
    const newTargets = new Set(list.map((c) => c.traits.targetName));
    expect(newTargets.size).toBeGreaterThanOrEqual(3 * oldTargets.size);
  });

  it("describes each phrase by what it is, and what sets it apart", () => {
    for (const c of list) {
      expect(c.chips).toHaveLength(7);
      expect(c.chips[0]).toMatch(/^target (root|3rd|5th|7th|9th|13th) · [A-G][#b]?\d/);
    }
    // what is unique is stated: every claim "the only X" is true of exactly one phrase
    for (const c of list) {
      for (const d of c.distinguishing) {
        const m = /^the only one arriving on the (.+) \(/.exec(d);
        if (m) expect(list.filter((o) => o.chips[0]!.includes(m[1]!)).length).toBe(1);
      }
    }
    expect(list.some((c) => c.distinguishing.length > 0)).toBe(true);
  });

  it("uses no stored phrases: every phrase records the grammar operations that built it", () => {
    for (const c of list) {
      const ops = c.gestures.flatMap((g) => g.steps.map((s) => s.op));
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) expect(["arpeggiate", "surround", "approach", "connect", "target", "arrive"]).toContain(op);
    }
  });
});

describe("reproducibility: the seed chooses which intentions are visited, nothing else", () => {
  it("the same seed gives byte-identical results", () => {
    const a = run(cSpace({ seed: 7 }));
    const b = run(cSpace({ seed: 7 }));
    expect(a.candidates.map(key)).toEqual(b.candidates.map(key));
    expect(a.candidates.map(timing)).toEqual(b.candidates.map(timing));
    expect(a.stats).toEqual(b.stats);
  });

  it("different seeds give different sets, each of them just as diverse", () => {
    const sets = [1, 2, 3, 4].map((seed) => run(cSpace({ seed })));
    const keys = sets.map((s) => s.candidates.map(key).sort().join("||"));
    expect(new Set(keys).size).toBe(sets.length);
    for (const s of sets) {
      expectSound(s.candidates, DEFAULT_TAU);
      expect(s.candidates.length).toBeGreaterThanOrEqual(5);
      expect(measureDiversity(s.candidates).coverage.targets).toBeGreaterThanOrEqual(4);
    }
  });

  it("the seeded generator is a pure function of its seed", () => {
    const a = seededRandom(5);
    const b = seededRandom(5);
    const xs = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 20 }, seededRandom(6))).not.toEqual(xs);
  });
});
const DEFAULT_TAU = 0.22;

describe("diversity across keys and progressions", () => {
  it("every major key: sound, distinct, and covering several targets", () => {
    for (const tonic of ALL_TONICS) {
      const gs = defaultGenerationSpace(progressionFor(tonic, "major"), { scale: buildScale(tonic, "major").notes }, { intentions: 60, count: 6 });
      const r = explorePhrases(gs);
      expect(r.ok, `${tonic}: ${r.ok ? "" : r.reason}`).toBe(true);
      if (!r.ok) continue;
      expect(r.candidates.length, tonic).toBeGreaterThanOrEqual(4);
      expectSound(r.candidates, gs.distinctness);
      const m = measureDiversity(r.candidates);
      expect(m.coverage.targets, `${tonic} targets`).toBeGreaterThanOrEqual(3);
      expect(m.coverage.strategies, `${tonic} strategies`).toBeGreaterThanOrEqual(3);
      expect(m.coverage.rhythms, `${tonic} rhythms`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the minor ii–V–i", () => {
    const gs = defaultGenerationSpace(progressionFor("A", "minor"), { scale: buildScale("A", "harmonicMinor").notes });
    const r = run(gs);
    expect(r.candidates.length).toBeGreaterThanOrEqual(5);
    expectSound(r.candidates, gs.distinctness);
    expect(exploreDegrees(gs.progression)).toEqual(["1", "3", "5", "7", "9", "11", "13"]);
    expect(measureDiversity(r.candidates).coverage.targets).toBeGreaterThanOrEqual(4);
  });

  it("a longer progression (vi–ii–V–I): the chord before the V leads, and the result is still diverse", () => {
    const chords = [makeChord("A", "minor7"), makeChord("D", "minor7"), makeChord("G", "dominant7"), makeChord("C", "major7")];
    const prog: ProgressionChord[] = chords.map((chord, i) => ({ chord, onset: frac(i), duration: frac(1) }));
    const gs = defaultGenerationSpace(prog, C_MAJOR);
    const r = run(gs);
    expectSound(r.candidates, gs.distinctness);
    for (const c of r.candidates) expect(fstr(notesOf(c.events as never).at(-1)!.onset)).toBe("3");
    expect(measureDiversity(r.candidates).coverage.targets).toBeGreaterThanOrEqual(4);
  });

  it("a bare V–I has nothing before the V, so two-chord lines and long phrases are not offered, and it says nothing false", () => {
    const prog: ProgressionChord[] = [makeChord("G", "dominant7"), makeChord("C", "major7")].map((chord, i) => ({ chord, onset: frac(i), duration: frac(1) }));
    const gs = defaultGenerationSpace(prog, C_MAJOR);
    const r = run(gs);
    expectSound(r.candidates, gs.distinctness);
    expect(r.candidates.every((c) => c.traits.length !== "long")).toBe(true);
    expect(r.candidates.every((c) => c.traits.family !== "two-chord")).toBe(true);
  });

  it("refuses a progression with nothing to lead into the target", () => {
    const r = explorePhrases(defaultGenerationSpace([{ chord: makeChord("C", "major7"), onset: frac(0), duration: frac(1) }], C_MAJOR));
    expect(r.ok).toBe(false);
  });
});

describe("Focus mode locks the target and still varies everything else", () => {
  const gs = cSpace({ targets: { mode: "focus", degree: "3" } });
  const r = run(gs);

  it("every phrase arrives on E", () => {
    for (const c of r.candidates) expect(formatNote(names(c))).toBe("E");
  });

  it("…in different octaves, with different strategies, contours and rhythms", () => {
    const m = measureDiversity(r.candidates);
    expect(r.candidates.length).toBeGreaterThanOrEqual(5);
    expect(m.coverage.registers).toBeGreaterThanOrEqual(2);
    expect(m.coverage.strategies).toBeGreaterThanOrEqual(3);
    expect(m.coverage.rhythms).toBeGreaterThanOrEqual(3);
    expect(new Set(r.candidates.map((c) => c.traits.targetPitch)).size).toBe(new Set(r.candidates.map((c) => c.traits.band)).size);
    expectSound(r.candidates, gs.distinctness);
  });

  it("rejects a degree the chord does not have", () => {
    expect(explorePhrases(cSpace({ targets: { mode: "focus", degree: "b2" } })).ok).toBe(false);
  });
});

describe("developing a chosen phrase: lock its target, rhythm or contour and get variations", () => {
  const gs = cSpace();
  const first = run(gs).candidates[0]!;

  it("locking the target keeps degree and octave, and varies the rest", () => {
    const next = lockAspects(gs, first, ["target"]);
    expect(next.seed).toBe(gs.seed + 1);
    const r = run(next);
    expect(r.candidates.length).toBeGreaterThanOrEqual(3);
    for (const c of r.candidates) expect(c.traits.targetPitch).toBe(first.traits.targetPitch);
    expect(measureDiversity(r.candidates).coverage.strategies).toBeGreaterThanOrEqual(2);
    expectSound(r.candidates, gs.distinctness);
  });

  it("locking the rhythm keeps every onset and duration exactly, and changes the pitches", () => {
    const next = lockAspects(gs, first, ["rhythm"]);
    const r = run(next);
    for (const c of r.candidates) expect(timing(c)).toBe(timing(first));
    expect(r.candidates.some((c) => c.choices.pitches.map(midi).join() !== first.choices.pitches.map(midi).join())).toBe(true);
    expectSound(r.candidates, gs.distinctness);
  });

  it("locking the contour keeps the exact up/down shape", () => {
    const next = lockAspects(gs, first, ["contour"]);
    const r = run(next);
    for (const c of r.candidates) expect(c.traits.shape).toBe(first.traits.shape);
    expectSound(r.candidates, gs.distinctness);
  });

  it("locking the strategy and register keeps those, and varies target and rhythm", () => {
    const r = run(lockAspects(gs, first, ["strategy", "register"]));
    for (const c of r.candidates) {
      expect(c.traits.strategy).toBe(first.traits.strategy);
      expect(c.traits.band).toBe(first.traits.band);
    }
    expect(new Set(r.candidates.map((c) => c.traits.targetDegree)).size).toBeGreaterThanOrEqual(2);
  });

  it("locks combine: target and rhythm together", () => {
    const r = run(lockAspects(gs, first, ["target", "rhythm"]));
    for (const c of r.candidates) {
      expect(c.traits.targetPitch).toBe(first.traits.targetPitch);
      expect(timing(c)).toBe(timing(first));
    }
  });
});

describe("it returns fewer rather than padding", () => {
  it("a tightly constrained space yields fewer than requested, says why, and every result is still distinct", () => {
    const gs = cSpace({
      targets: { mode: "focus", degree: "3", bands: ["mid"] },
      strategies: ["enclosure-direct"],
      rhythms: ["flowing"],
      lengths: ["short"],
      densities: ["sparse"],
      contours: ["any"],
      count: 7,
    });
    const r = run(gs);
    expect(r.candidates.length).toBeLessThan(7);
    expect(r.stats.note).toMatch(/not padded/);
    expectSound(r.candidates, gs.distinctness);
  });

  it("a stricter notion of 'different' returns fewer, a looser one more; no result is closer than its threshold", () => {
    const sizes = [0, 0.22, 0.45].map((tau) => {
      const r = run(cSpace({ distinctness: tau, count: 40 }));
      expectSound(r.candidates, tau);
      return r.candidates.length;
    });
    expect(sizes[2]!).toBeLessThanOrEqual(sizes[1]!);
    expect(sizes[1]!).toBeLessThanOrEqual(sizes[0]!);
    expect(sizes[2]!).toBeLessThan(sizes[0]!);
  });

  it("an empty dimension or a register that excludes everything is reported, not hidden", () => {
    expect(explorePhrases(cSpace({ strategies: [] })).ok).toBe(false);
    expect(explorePhrases(cSpace({ register: [30, 40] })).ok).toBe(false);
  });
});

describe("rhythm is part of the intention, and the rhythm asked for is the rhythm delivered", () => {
  const only = (id: string) => run(cSpace({ rhythms: [id], intentions: 80, count: 6 }));

  it("triplets: every phrase contains exact triplet durations", () => {
    for (const c of only("triplet").candidates) {
      expect(c.traits.rhythmTags).toContain("triplet");
      expect(c.events.some((e) => e.duration.den % 3 === 0)).toBe(true);
    }
  });

  it("delayed resolution: silence just before the target arrives", () => {
    const r = only("hesitating");
    for (const c of r.candidates) {
      const before = c.events[c.events.length - 2]!;
      expect(before.kind).toBe("rest");
    }
  });

  it("rests, dotted figures and syncopation are present when asked for", () => {
    for (const c of only("breathing").candidates) expect(c.events.some((e) => e.kind === "rest")).toBe(true);
    for (const c of only("lilting").candidates) expect(c.traits.rhythmTags).toContain("dotted");
    for (const c of only("syncopated").candidates) expect(c.traits.rhythmTags).toContain("syncopated");
  });

  it("flowing rhythms have no rests and no dotted, syncopated or triplet figures", () => {
    for (const c of only("flowing").candidates) {
      expect(c.events.every((e) => e.kind === "note")).toBe(true);
      for (const t of ["dotted", "syncopated", "triplet", "rest"]) expect(c.traits.rhythmTags).not.toContain(t);
    }
  });

  it("different rhythmic characters give different note lengths and accents across a default exploration", () => {
    const list = run(cSpace()).candidates;
    const durations = new Set(list.flatMap((c) => notesOf(c.events as never).map((n) => fstr(n.duration))));
    const accents = new Set(list.flatMap((c) => notesOf(c.events as never).map((n) => n.accent)));
    expect(durations.size).toBeGreaterThanOrEqual(5);
    expect(accents.size).toBeGreaterThanOrEqual(3);
    expect(list.some((c) => c.events.some((e) => e.kind === "rest"))).toBe(true);
    expect(list.some((c) => c.traits.rhythmTags.includes("triplet"))).toBe(true);
  });

  it("hard rhythm requirements at the plan level", () => {
    for (const p of rhythmPlans(frac(1), 5, { require: ["dotted"] }, 40)) expect(rhythmTraits(p).tags).toContain("dotted");
    for (const p of rhythmPlans(frac(1), 5, { forbid: ["rest", "triplet"] }, 40)) expect(rhythmTraits(p).tags).not.toEqual(expect.arrayContaining(["rest"]));
    for (const p of rhythmPlans(frac(1), 4, { endsWithRest: true }, 40)) expect(rhythmTraits(p).endsWithRest).toBe(true);
    for (const p of rhythmPlans(frac(1), 4, { startsWithRest: true }, 40)) expect(rhythmTraits(p).startsWithRest).toBe(true);
    expect(rhythmPlans(frac(1), 4, { endsWithRest: true }).length).toBeGreaterThan(0);
  });
});

describe("the grammar gained new gestures, and they are verified", () => {
  it("a scale run is built with connect, moves by step in one direction, and passes validation", () => {
    const r = run(cSpace({ strategies: ["scale-run"], count: 4, intentions: 80 }));
    for (const c of r.candidates) {
      const g = c.gestures.find((x) => x.kind === "scalar-run")!;
      expect(g, c.summary).toBeDefined();
      expect(g.steps.map((s) => s.op)).toEqual(["target", "connect"]);
      const line = [...g.notes, c.targetNote].map((id) => midi(notesOf(c.events as never).find((n) => n.id === id)!.pitch));
      const moves = line.slice(1).map((m, i) => m - line[i]!);
      expect(new Set(moves.map(Math.sign)).size).toBe(1);
      expect(moves.every((d) => Math.abs(d) <= 3)).toBe(true);
    }
  });

  it("a two-chord line outlines the ii over the ii and the V over the V, each in its own bar", () => {
    const r = run(cSpace({ strategies: ["two-chord-arpeggios", "two-chord-approach"], lengths: ["long"], count: 4, intentions: 80 }));
    for (const c of r.candidates) {
      const lead = c.gestures.find((g) => g.id === "g-outline-lead")!;
      const main = c.gestures.find((g) => g.id === "g-outline")!;
      expect(lead.params.chord).toBe("Dm7");
      expect(main.params.chord).toBe("G7");
      const ns = notesOf(c.events as never);
      for (const id of lead.notes) expect(ns.find((n) => n.id === id)!.onset.num / ns.find((n) => n.id === id)!.onset.den).toBeLessThan(1);
      for (const id of main.notes) {
        const n = ns.find((x) => x.id === id)!;
        const t = n.onset.num / n.onset.den;
        expect(t).toBeGreaterThanOrEqual(1);
        expect(t).toBeLessThan(2);
      }
    }
  });

  it("an outline can use the chord's extension: the upper structure of G7 contains its 9th", () => {
    const r = run(cSpace({ strategies: ["upper-structure-enclosure"], count: 4, intentions: 80 }));
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) expect(validateMusicIR(phraseToIR(c, c.spec))).toEqual([]);
  });
});

describe("contour and distance, defined and tested", () => {
  const P = (...n: string[]) => n.map((x) => parsePitch(x));

  it("classifies the overall shape", () => {
    expect(contourClassOf(P("C4", "D4", "E4", "G4"))).toBe("ascending");
    expect(contourClassOf(P("G4", "F4", "E4", "C4"))).toBe("descending");
    expect(contourClassOf(P("C4", "E4", "G4", "E4"))).toBe("arch");
    expect(contourClassOf(P("G4", "E4", "C4", "E4"))).toBe("valley");
    expect(contourClassOf(P("E4", "D#4", "F4", "E4"))).toBe("level"); // an enclosure turns around a note; it is not an arch
    expect(contourClassOf(P("C4"))).toBe("level");
    expect(contourShape(P("C4", "E4", "E4", "C4"))).toBe("uld");
  });

  it("distance is zero for identical phrases, symmetric, and judged per aspect", () => {
    const [a, b] = run(cSpace()).candidates;
    const t = a!.traits;
    expect(phraseDistance(t, t).total).toBe(0);
    expect(phraseDistance(a!.traits, b!.traits).total).toBeCloseTo(phraseDistance(b!.traits, a!.traits).total, 10);
    // a rhythm-only change moves the rhythm term and nothing about target, contour or register
    const rhythmOnly = { ...t, onsets: ["0", "1/8", "1/4"], rhythmSignature: "x>y", rhythmTags: ["syncopated"] };
    const d1 = phraseDistance(t, rhythmOnly);
    expect(d1.rhythm).toBeGreaterThan(0);
    expect(d1.target + d1.register + d1.contour + d1.structure + d1.pitch).toBe(0);
    // an octave change moves target and register, not the contour or the rhythm
    const octave = { ...t, targetPitch: t.targetPitch + 12, band: t.band === "high" ? ("mid" as const) : ("high" as const) };
    const d2 = phraseDistance(t, octave);
    expect(d2.target).toBeGreaterThan(0);
    expect(d2.register).toBeGreaterThan(0);
    expect(d2.contour + d2.rhythm).toBe(0);
  });

  it("the verifier catches a tampered phrase", () => {
    const c = run(cSpace()).candidates[0]!;
    const firstNote = c.events.find((e) => e.kind === "note")!;
    const bad = { ...c, events: c.events.map((e) => (e === firstNote && e.kind === "note" ? { ...e, pitch: { ...e.pitch, octave: e.pitch.octave + 4 } } : e)) };
    expect(verifyCandidate(bad, c.spec).length).toBeGreaterThan(0);
    const late = { ...c, events: c.events.map((e) => (e.id === c.targetNote ? { ...e, onset: frac(5, 2) } : e)) };
    expect(verifyCandidate(late, c.spec).some((p) => /arrives/.test(p))).toBe(true);
  });
});
