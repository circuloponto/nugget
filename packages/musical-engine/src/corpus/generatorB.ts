/**
 * Generator B: an experimental, corpus-informed way to use Nugget's existing phrase grammar.
 *
 * Generator A (explore.ts) is left exactly as it was. B does not replace any of its musical machinery: every pitch is
 * still chosen by the same grammar (chords, arpeggios, approaches, enclosures, scale runs), under the same hard limits
 * and checked by the same independent verifier. What changes is what steers it, and that comes from a CorpusProfile
 * derived only from the development half of the corpus (profile.ts):
 *
 *   1. Activity. The shape of a phrase's rhythmic activity (even, rising, falling…) and its density are drawn from the
 *      corpus's distributions, and only the rhythmic characters the corpus really uses are allowed (a corpus with no
 *      written rests gets no "phrased with rests").
 *   2. Intention. A target degree, register band, contour and melodic strategy are chosen as in A; the contour is
 *      drawn from the corpus's contour shares.
 *   3. Time. The target is not held to the end of its chord. The length of its note is drawn from the corpus's
 *      distribution of final-note lengths, and the run-up length (short, standard or long) is drawn with a preference for the one
 *      that brings the whole phrase closest to a phrase length drawn from the corpus, so B's phrases are about as long
 *      as real ones and not shorter merely because the last note is no longer held.
 *   4. Development. A run is a sequence of phrases, each of which may take up the one before it: keep its melody with a
 *      new rhythm, or keep its exact rhythm with new pitches, in the proportions the corpus shows for neighbouring
 *      phrases. (Exact repetition and modified endings are what the corpus shows least of, and are not generated.)
 *   5. Filling. The grammar fills the rest.
 *   6. Validation. Every candidate passes the A verifier before it can be chosen.
 *   7. Selection. Of the valid candidates for each slot, B takes the one that adds the most new ground (target,
 *      register, strategy, rhythm, contour, density) among those that are not near duplicates of an earlier phrase of
 *      the run. A phrase developed from its parent is allowed to resemble it; it must still differ from the others.
 *
 * Nothing here copies a corpus melody: the profile holds numbers, not pitches or rhythms.
 */
import { DEFAULT_PHRASE_REQUEST, generationSpaceFromRequest, type PhraseRequest } from "../grammar/request";
import {
  DEFAULT_DISTINCTNESS,
  RHYTHM_CHARACTERS,
  STRATEGIES,
  exploreDegrees,
  phraseDistance,
  seededRandom,
  specForIntention,
  traitsOf,
  verifyCandidate,
  type Density,
  type ExploredPhrase,
  type GenerationSpace,
  type Intention,
  type Length,
} from "../grammar/explore";
import { generatePhrase, type PhraseCandidate, type PhraseSpec } from "../grammar/phrase";
import { phraseToIR } from "../grammar/document";
import type { RhythmIntent, RhythmTag } from "../grammar/rhythmic";
import type { ContourClass } from "../grammar/line";
import { frac, fcmp, type Fraction } from "../time/rational";
import { midi } from "../theory/pitch";
import { melodyFromIR } from "./analysis/melody";
import type { GeneratedPhrase, GeneratorRun } from "./generatorSample";
import type { CorpusProfile } from "./profile";

export interface GeneratorBOptions {
  readonly keys?: readonly string[];
  readonly modes?: readonly ("major" | "minor")[];
  readonly seeds?: readonly number[];
  /** Phrases per run: a short sequence in which each phrase may develop the one before. Default 4. */
  readonly phrasesPerRun?: number;
  /** Candidate intentions tried per phrase before choosing. Default 16. */
  readonly attempts?: number;
  /** The same request A is run with, so both start from identical harmony, register, limits and densities. */
  readonly base?: PhraseRequest;
}

type Relation = "none" | "melodyKept" | "rhythmKept";

interface Made {
  readonly cand: ExploredPhrase;
  readonly ix: Intention;
  readonly relation: Relation;
  readonly parent: number | null;
  readonly sampled: NonNullable<GeneratedPhrase["sampled"]>;
}

const hashOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const sampleFrom = <T>(xs: readonly T[], rnd: () => number): T => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))]!;

function sampleWeighted<K extends string>(weights: Readonly<Record<K, number>>, rnd: () => number): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = rnd() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x <= 0) return k;
  }
  return entries[entries.length - 1]![0];
}

const densityOf = (perBeat: number): Density => (perBeat < 1.5 ? "sparse" : perBeat < 2.5 ? "medium" : "busy");
const DENSITY_ORDER: readonly Density[] = ["sparse", "medium", "busy"];

/** Which rhythmic characters the corpus actually uses (a character the corpus lacks is not offered). */
export function allowedCharacters(profile: CorpusProfile, offered: readonly string[]): string[] {
  const r = profile.rhythm;
  const ok = (id: string): boolean => {
    switch (id) {
      case "breathing":
      case "hesitating":
        return r.restPhraseShare >= 0.1;
      case "lilting":
        return r.dottedShare >= 0.02;
      case "syncopated":
        return r.syncopatedShare >= 0.02;
      case "triplet":
        return r.tripletShare >= 0.02;
      default:
        return true; // flowing, driving, broad
    }
  };
  const list = RHYTHM_CHARACTERS.map((c) => c.id).filter((id) => offered.includes(id) && ok(id));
  return list.length ? list : ["flowing"];
}

/** Rhythmic ingredients the corpus does not use are forbidden to every character, not only left out of the menu. */
export function rhythmLimits(profile: CorpusProfile): { forbid: RhythmTag[]; rests: boolean } {
  const forbid: RhythmTag[] = [];
  if (profile.rhythm.tripletShare < 0.02) forbid.push("triplet");
  return { forbid, rests: profile.rhythm.restPhraseShare >= 0.1 };
}

const SHAPE_OF_ACTIVITY: Record<string, RhythmIntent["shape"]> = { rising: "accelerating", falling: "decelerating", even: "even", "burst-hold": "decelerating" };
const CONTOUR_OF: Record<string, ContourClass | "any"> = { ascending: "ascending", descending: "descending", arch: "arch", valley: "valley", level: "any" };

/** The length of a final note drawn from the profile, on the half-beat grid and no longer than the target chord. */
function finalDuration(beats: number, chordLength: Fraction): { duration: Fraction; beats: number } {
  const halves = Math.max(1, Math.round(beats * 2));
  let duration = frac(halves, 8); // half a beat is 1/8 of a whole note
  if (fcmp(duration, chordLength) > 0) duration = chordLength;
  return { duration, beats: (duration.num / duration.den) * 4 };
}

const exactKey = (c: PhraseCandidate): string => `${c.choices.pitches.map(midi).join(",")}|${c.choices.rhythm.slots.map((s) => `${s.duration.num}/${s.duration.den}${s.rest ? "r" : ""}`).join(",")}`;
/** What a phrase adds to the run. Length and density are not counted: the profile steers them, and rewarding variety there would pull B away from the corpus. */
const coverageKeys = (t: ExploredPhrase["traits"]): string[] => [`d:${t.targetDegree}`, `b:${t.band}`, `f:${t.family}`, `r:${t.rhythmCharacter}`, `c:${t.contour}`];

export function sampleGeneratorB(profile: CorpusProfile, options: GeneratorBOptions = {}): GeneratorRun[] {
  const keys = options.keys ?? ["C"];
  const modes = options.modes ?? ["major"];
  const seeds = options.seeds ?? [1, 2, 3];
  const base = options.base ?? DEFAULT_PHRASE_REQUEST;
  const slots = options.phrasesPerRun ?? 4;
  const attempts = options.attempts ?? 16;
  const runs: GeneratorRun[] = [];
  for (const mode of modes) {
    for (const key of keys) {
      for (const seed of seeds) {
        const req: PhraseRequest = { ...base, tonic: key, mode, exploration: { ...base.exploration, seed } };
        runs.push(oneRun(profile, req, key, mode, seed, slots, attempts));
      }
    }
  }
  return runs;
}

function oneRun(profile: CorpusProfile, req: PhraseRequest, key: string, mode: "major" | "minor", seed: number, slots: number, attempts: number): GeneratorRun {
  const gs = generationSpaceFromRequest(req);
  const rnd = seededRandom((hashOf(`B|${key}|${mode}`) ^ Math.imul(seed, 2654435761)) >>> 0);
  const prog = gs.progression;
  const chordLength = prog[prog.length - 1]!.duration;
  const degrees = gs.targets.mode === "explore" && gs.targets.degrees ? gs.targets.degrees : exploreDegrees(prog);
  const characters = allowedCharacters(profile, gs.rhythms);
  const runup = runupBeats(gs, degrees, characters);
  const tau = gs.distinctness ?? DEFAULT_DISTINCTNESS;
  const relationWeights: Record<Relation, number> = { none: profile.relations.none + profile.relations.exact + profile.relations.modifiedEnding, melodyKept: profile.relations.melodyKept, rhythmKept: profile.relations.rhythmKept };

  const made: Made[] = [];
  let note: string | undefined;

  for (let slot = 0; slot < slots; slot++) {
    const wanted: Relation = slot === 0 ? "none" : sampleWeighted(relationWeights, rnd);
    let chosen: Made | null = null;
    for (const relation of wanted === "none" ? (["none"] as const) : ([wanted, "none"] as const)) {
      const parent = relation === "none" ? null : made[made.length - 1]!;
      const pool: Made[] = [];
      for (let a = 0; a < attempts; a++) {
        const m = candidateFor(profile, gs, relation, parent, { rnd, runup, degrees, characters, chordLength });
        if (m) pool.push(...m);
      }
      const seen = new Set(made.map((x) => exactKey(x.cand)));
      const eligible = pool.filter((p) => {
        if (seen.has(exactKey(p.cand))) return false;
        return made.every((o, i) => (parent && i === made.length - 1 ? true : phraseDistance(p.cand.traits, o.cand.traits).total >= tau));
      });
      if (eligible.length === 0) continue;
      const covered = new Set(made.flatMap((x) => coverageKeys(x.cand.traits)));
      let best: Made | null = null;
      let bestValue = -Infinity;
      for (const p of eligible) {
        const gain = coverageKeys(p.cand.traits).filter((k) => !covered.has(k)).length;
        const value = gain + 0.01 * p.cand.score.total;
        if (value > bestValue + 1e-12) {
          bestValue = value;
          best = p;
        }
      }
      chosen = best;
      if (chosen) break;
    }
    if (!chosen) {
      note = `Only ${made.length} phrase${made.length === 1 ? "" : "s"} could be made that were valid and not near duplicates; the run was not padded.`;
      break;
    }
    made.push({ ...chosen, parent: chosen.relation === "none" ? null : made.length - 1, sampled: { ...chosen.sampled, parent: chosen.relation === "none" ? null : made.length - 1 } });
  }

  const phrases: GeneratedPhrase[] = made.map((m, i) => {
    const ir = phraseToIR(m.cand, m.cand.spec, { bpm: req.bpm, bass: false });
    const line = melodyFromIR(ir, { key: { tonic: key, mode: mode === "major" ? "major" : "minor" }, origin: "generated" });
    return {
      line: { ...line, id: `${key}-${mode}-s${seed}-B${i + 1}` },
      traits: m.cand.traits,
      chips: [...m.cand.chips, m.relation === "none" ? "new idea" : m.relation === "melodyKept" ? `melody of phrase ${i}, new rhythm` : `rhythm of phrase ${i}, new pitches`],
      ir,
      sampled: m.sampled,
    };
  });
  return { key, mode, seed, generator: "B", phrases, ...(note ? { note } : {}) };
}

interface Ctx {
  readonly rnd: () => number;
  /** Beats from the start of a phrase to the arrival of its target, for each length the space offers. */
  readonly runup: Readonly<Record<string, number>>;
  readonly degrees: readonly string[];
  readonly characters: readonly string[];
  readonly chordLength: Fraction;
}

/** The run-up of each phrase length, read from the spec the grammar builds for it (so it follows the progression). */
function runupBeats(gs: GenerationSpace, degrees: readonly string[], characters: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const arrival = gs.progression[gs.progression.length - 1]!.onset;
  for (const length of gs.lengths) {
    const spec = specForIntention(gs, { degree: degrees[0]!, band: gs.bands[0]!, strategy: "scale-run", rhythm: characters[0]!, contour: "any", density: "medium", length });
    if (spec) out[length] = ((arrival.num / arrival.den) - (spec.start.num / spec.start.den)) * 4;
  }
  return out;
}

/**
 * A length class, drawn so that the phrase lengths B produces follow the corpus's: each class is weighted by how close
 * its run-up plus the drawn final note comes to a phrase length drawn from the profile. It is a soft preference, not a
 * rule, because a single forced length would leave too few candidates that differ from one another.
 */
function lengthFor(profile: CorpusProfile, gs: GenerationSpace, ctx: Ctx, finalBeats: number): Length {
  const want = sampleFrom(profile.phraseBeats, ctx.rnd);
  const options = gs.lengths.filter((l) => ctx.runup[l] !== undefined).map((l) => ({ l, w: Math.exp(-((ctx.runup[l]! + finalBeats - want) ** 2) / 2) }));
  if (options.length === 0) return gs.lengths[0]!;
  let x = ctx.rnd() * options.reduce((acc, o) => acc + o.w, 0);
  for (const o of options) {
    x -= o.w;
    if (x <= 0) return o.l;
  }
  return options[options.length - 1]!.l;
}

/** One attempt: an intention steered by the profile, realised by the grammar, verified. May yield nothing. */
function candidateFor(profile: CorpusProfile, gs: GenerationSpace, relation: Relation, parent: Made | null, ctx: Ctx): Made[] | null {
  const { rnd } = ctx;
  const densityDrawn = densityOf(sampleFrom(profile.notesPerBeat, rnd));
  const allowed = gs.densities;
  const density: Density = allowed.includes(densityDrawn) ? densityDrawn : [...allowed].sort((a, b) => Math.abs(DENSITY_ORDER.indexOf(a) - DENSITY_ORDER.indexOf(densityDrawn)) - Math.abs(DENSITY_ORDER.indexOf(b) - DENSITY_ORDER.indexOf(densityDrawn)))[0]!;
  const activityShape = sampleWeighted(profile.activityShapes, rnd);
  const finalDraw = sampleFrom(profile.finalBeats, rnd);
  const fin = finalDuration(finalDraw, ctx.chordLength);
  const contourClass = CONTOUR_OF[sampleWeighted(profile.contours, rnd)] ?? "any";

  let space: GenerationSpace = gs;
  let ix: Intention;
  let template: PhraseCandidate | undefined;
  if (relation === "melodyKept" && parent) {
    const others = ctx.characters.filter((c) => c !== parent.ix.rhythm);
    ix = { ...parent.ix, rhythm: sampleFrom(others.length ? others : ctx.characters, rnd), density };
    template = parent.cand;
  } else {
    const length: Length = relation === "rhythmKept" && parent ? parent.ix.length : lengthFor(profile, gs, ctx, fin.beats);
    const usable = STRATEGIES.filter((s) => gs.strategies.includes(s.id) && (!s.lead || (length === "long" && gs.progression.length >= 3)));
    if (usable.length === 0) return null;
    ix = {
      degree: sampleFrom(ctx.degrees, rnd),
      band: sampleFrom(gs.bands, rnd),
      strategy: sampleFrom(usable, rnd).id,
      rhythm: sampleFrom(ctx.characters, rnd),
      contour: gs.contours.includes(contourClass) ? contourClass : "any",
      density,
      length,
    };
    if (relation === "rhythmKept" && parent) space = { ...gs, locks: { ...(gs.locks ?? {}), rhythmPlan: parent.cand.choices.rhythm }, lengths: [parent.ix.length] };
  }

  const base = specForIntention(space, ix);
  if (!base) return null;
  const rhythmLocked = space.locks?.rhythmPlan !== undefined;
  const shape = SHAPE_OF_ACTIVITY[activityShape];
  const spec: PhraseSpec = {
    ...base,
    target: { ...base.target, duration: fin.duration },
    ...(rhythmLocked
      ? {}
      : (() => {
          const lim = rhythmLimits(profile);
          const r = base.rhythm ?? {};
          return { rhythm: { ...r, ...(shape ? { shape } : {}), forbid: [...new Set([...(r.forbid ?? []), ...lim.forbid])], ...(lim.rests ? {} : { rests: false }) } };
        })()),
    ...(template ? { fixed: { ...(base.fixed ?? {}), template } } : {}),
  };
  const r = generatePhrase(spec);
  if (!r.ok) return null;
  const strategy = STRATEGIES.find((s) => s.id === ix.strategy)!;
  const out: Made[] = [];
  for (const c of r.candidates) {
    if (verifyCandidate(c, spec).length > 0) continue;
    const cand: ExploredPhrase = { ...c, spec, intention: ix, traits: traitsOf(c, spec, ix, strategy), chips: [], distinguishing: [] };
    out.push({ cand: { ...cand, chips: chipsFor(cand) }, ix, relation, parent: null, sampled: { finalBeats: fin.beats, activityShape, density, relation, parent: null } });
  }
  return out;
}

const chipsFor = (c: ExploredPhrase): string[] => {
  const t = c.traits;
  return [`target ${t.targetDegree} · ${t.targetName}`, `${t.band} register`, t.family.replace("+", " + "), `${t.contour} contour`, t.rhythmCharacter, `${t.noteCount} notes · ${t.density}`];
};
