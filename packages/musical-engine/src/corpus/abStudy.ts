/**
 * A blind A/B listening study.
 *
 * Pairs one phrase of Generator A with one phrase of Generator B from the same key, mode and seed, so both start from
 * the same harmony, register and limits, and picks the two whose lengths and note counts are closest. Which of the two
 * is "X" and which is "Y" is decided by a seeded coin; the answer is kept in a separate key that the listening view does
 * not read until every pair has been judged.
 *
 * Only the LABEL is blind. Whatever can be heard is left as it is: if one generator holds its last note longer, a
 * listener can hear that, and that is part of what is being tested. Nothing that can be read from the files (a title, a
 * transformation record, a gesture list, a provenance field, a chip) names the generator: each document is rebuilt from
 * its notes and chords alone.
 */
import { fnum } from "../time/rational";
import { seededRandom } from "../grammar/explore";
import type { MusicIR } from "../ir/types";
import type { GeneratedPhrase, GeneratorRun } from "./generatorSample";

export const AB_SCHEMA = "nugget-ab-study" as const;

export interface BlindPhrase {
  /** A MusicIR document with a neutral id and title and nothing that names its maker. */
  readonly ir: MusicIR;
  readonly notes: number;
  readonly beats: number;
}

export interface AbPair {
  readonly id: string;
  readonly key: string;
  readonly mode: string;
  readonly x: BlindPhrase;
  readonly y: BlindPhrase;
}

export interface AbStudy {
  readonly schema: typeof AB_SCHEMA;
  readonly version: 1;
  readonly id: string;
  /** How the two sets were made (shared by both generators); says nothing about which phrase is which. */
  readonly config: { readonly keys: readonly string[]; readonly seeds: readonly number[]; readonly phrasesPerRun: number; readonly pairs: number; readonly seed: number };
  readonly questions: readonly { readonly id: string; readonly text: string }[];
  readonly pairs: readonly AbPair[];
}

export interface AbKey {
  readonly schema: "nugget-ab-key";
  readonly studyId: string;
  readonly pairs: Readonly<Record<string, { readonly X: "A" | "B"; readonly Y: "A" | "B" }>>;
}

export const AB_QUESTIONS = [
  { id: "musical", text: "Which sounds more musical?" },
  { id: "coherent", text: "Which sounds more like a phrase that belongs to a tune: one idea, not a string of notes?" },
] as const;

/** The document rebuilt from its sounding parts only. */
export function blindDocument(ir: MusicIR, id: string): MusicIR {
  return {
    version: ir.version,
    id,
    title: "Example",
    tempo: ir.tempo,
    meter: ir.meter,
    voices: ir.voices.filter((v) => v.role === "melody").map((v) => ({ id: v.id, name: "Melody", role: v.role, ...(v.instrument ? { instrument: v.instrument } : {}) })) as MusicIR["voices"],
    events: ir.events.filter((e) => e.voice === "melody").map((e) => {
      const { provenance: _p, ...rest } = e as typeof e & { provenance?: unknown };
      return rest;
    }) as MusicIR["events"],
    chords: ir.chords,
    relations: [],
    constraints: [],
    transformations: [],
  };
}

/** A short, stable fingerprint (two FNV-1a passes); the engine is plain TypeScript and does not use Node's crypto. */
const fingerprint = (text: string): string => {
  let a = 2166136261;
  let b = 3735928559;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ (c + i), 2246822519);
  }
  return ((a >>> 0).toString(16).padStart(8, "0") + ((b >>> 0) & 0xff).toString(16).padStart(2, "0")).slice(0, 10);
};

const beatsOf = (p: GeneratedPhrase): number => Math.round(fnum(p.line.length) * 4 * 100) / 100;

interface Candidate {
  readonly key: string;
  readonly mode: string;
  readonly seed: number;
  readonly a: GeneratedPhrase;
  readonly b: GeneratedPhrase;
  readonly cost: number;
}

export interface AbOptions {
  /** How many pairs to build (fewer if the runs do not have enough). */
  readonly pairs?: number;
  /** Seeds the X/Y coin. */
  readonly seed?: number;
  readonly keys?: readonly string[];
  readonly seeds?: readonly number[];
  readonly phrasesPerRun?: number;
}

export function buildAbStudy(runsA: readonly GeneratorRun[], runsB: readonly GeneratorRun[], options: AbOptions = {}): { study: AbStudy; key: AbKey } {
  const want = options.pairs ?? 12;
  const coin = seededRandom(options.seed ?? 1);
  const byRun = new Map(runsB.map((r) => [`${r.key}|${r.mode}|${r.seed}`, r] as const));

  // for each shared run, the best-matched pairs (closest in length, then in note count), never reusing a phrase
  const perRun: Candidate[][] = [];
  for (const a of runsA) {
    const b = byRun.get(`${a.key}|${a.mode}|${a.seed}`);
    if (!b || a.phrases.length === 0 || b.phrases.length === 0) continue;
    const all: Candidate[] = [];
    for (const pa of a.phrases) for (const pb of b.phrases) all.push({ key: a.key, mode: a.mode, seed: a.seed, a: pa, b: pb, cost: Math.abs(beatsOf(pa) - beatsOf(pb)) + 0.25 * Math.abs(pa.line.notes.length - pb.line.notes.length) });
    all.sort((p, q) => p.cost - q.cost);
    const usedA = new Set<GeneratedPhrase>();
    const usedB = new Set<GeneratedPhrase>();
    const picks: Candidate[] = [];
    for (const c of all) {
      if (usedA.has(c.a) || usedB.has(c.b)) continue;
      usedA.add(c.a);
      usedB.add(c.b);
      picks.push(c);
    }
    perRun.push(picks);
  }
  // round-robin over runs, so the study spreads over keys and seeds instead of exhausting one run
  const chosen: Candidate[] = [];
  for (let round = 0; chosen.length < want; round++) {
    let any = false;
    for (const picks of perRun) {
      const c = picks[round];
      if (c && chosen.length < want) {
        chosen.push(c);
        any = true;
      }
    }
    if (!any) break;
  }

  const keyPairs: Record<string, { X: "A" | "B"; Y: "A" | "B" }> = {};
  const pairs: AbPair[] = chosen.map((c, i) => {
    const id = `p${String(i + 1).padStart(2, "0")}`;
    const aFirst = coin() < 0.5;
    keyPairs[id] = aFirst ? { X: "A", Y: "B" } : { X: "B", Y: "A" };
    const blind = (p: GeneratedPhrase, slot: "x" | "y"): BlindPhrase => ({ ir: blindDocument(p.ir!, `${id}-${slot}`), notes: p.line.notes.length, beats: beatsOf(p) });
    return { id, key: c.key, mode: c.mode, x: blind(aFirst ? c.a : c.b, "x"), y: blind(aFirst ? c.b : c.a, "y") };
  });

  const config = {
    keys: options.keys ?? [...new Set(runsA.map((r) => r.key))],
    seeds: options.seeds ?? [...new Set(runsA.map((r) => r.seed))].sort((p, q) => p - q),
    phrasesPerRun: options.phrasesPerRun ?? Math.max(0, ...runsB.map((r) => r.phrases.length)),
    pairs: pairs.length,
    seed: options.seed ?? 1,
  };
  const id = `ab-${fingerprint(JSON.stringify({ config, pairs }))}`;
  return {
    study: { schema: AB_SCHEMA, version: 1, id, config, questions: AB_QUESTIONS, pairs },
    key: { schema: "nugget-ab-key", studyId: id, pairs: keyPairs },
  };
}

/** Per question, how often each generator was preferred, from the ratings and the sealed key. */
export interface AbTally {
  readonly question: string;
  readonly A: number;
  readonly B: number;
  readonly noDifference: number;
}
export type AbRatings = Readonly<Record<string, Readonly<Record<string, "X" | "Y" | "same">>>>;

export function tallyAb(key: AbKey, ratings: AbRatings): AbTally[] {
  return AB_QUESTIONS.map((q) => {
    let A = 0;
    let B = 0;
    let same = 0;
    for (const [pairId, mapping] of Object.entries(key.pairs)) {
      const choice = ratings[pairId]?.[q.id];
      if (choice === undefined) continue;
      if (choice === "same") same++;
      else if (mapping[choice] === "A") A++;
      else B++;
    }
    return { question: q.id, A, B, noDifference: same };
  });
}
