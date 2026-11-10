/**
 * Phrase structure as description, not hardcoded form. `describePhrase` reports what a stretch of
 * melody does (its climax, contour, tension profile, silences, how it arrives or stops short) and
 * `relatePhrases` proposes how two phrases relate (repetition, variation, question and answer ...).
 * Both only describe and propose, with evidence: a relation is a claim, and phrases of any
 * length are accepted (nothing assumes a four-bar structure).
 */
import { formatPitch, midi } from "../theory/pitch";
import { fadd, fcmp, fsub, type Fraction } from "../time/rational";
import type { IRPhraseRelation, MusicIR } from "../ir/types";
import { analyzeMelody, type NoteFacts } from "./analysis";
import { contourOf, type Contour } from "./line";

export interface PhraseDescription {
  readonly notes: readonly string[];
  readonly contour: Contour;
  readonly climax: { readonly note: string; readonly index: number; readonly unique: boolean; readonly position: number };
  /** Per note, 0..1: non-chord tones, accents and height raise it. A heuristic, labelled as such. */
  readonly tension: readonly { readonly note: string; readonly value: number }[];
  readonly silences: readonly { readonly onset: Fraction; readonly duration: Fraction }[];
  readonly ending: {
    readonly note: string;
    readonly onChordTone: boolean;
    readonly metric: string;
    readonly approachedByStep: boolean;
    /** "arrival" (a chord tone on a strong position, reached by step), "open" (a chord tone elsewhere) or "interrupted" (a non-chord tone). */
    readonly kind: "arrival" | "open" | "interrupted";
    readonly evidence: readonly string[];
  };
  readonly durations: readonly string[];
  readonly intervals: readonly number[];
}

export function describePhrase(ir: MusicIR, noteIds?: readonly string[], voice?: string): PhraseDescription {
  const a = analyzeMelody(ir, voice ? { voice } : {});
  const facts: NoteFacts[] = noteIds ? a.facts.filter((f) => noteIds.includes(f.id)) : [...a.facts];
  if (facts.length === 0) throw new RangeError("a phrase needs at least one note");
  const ms = facts.map((f) => midi(f.pitch));
  const hi = Math.max(...ms);
  const lo = Math.min(...ms);
  const climaxIdx = ms.indexOf(hi);
  const tension = facts.map((f) => {
    const base = f.harmonic === null ? 0.55 : f.harmonic.kind === "chord-tone" ? 0.1 : 0.3;
    const height = hi === lo ? 0 : ((midi(f.pitch) - lo) / (hi - lo)) * 0.25;
    const accent = f.harmonic === null ? 0.15 * (f.metric.accent / 3) : 0;
    return { note: f.id, value: Math.round(Math.min(1, base + height + accent) * 100) / 100 };
  });

  // silences: gaps between the phrase's notes
  const silences: { onset: Fraction; duration: Fraction }[] = [];
  for (let i = 1; i < facts.length; i++) {
    const gapStart = fadd(facts[i - 1]!.onset, facts[i - 1]!.duration);
    if (fcmp(facts[i]!.onset, gapStart) > 0) silences.push({ onset: gapStart, duration: fsub(facts[i]!.onset, gapStart) });
  }

  const last = facts[facts.length - 1]!;
  const prev = facts.length > 1 ? facts[facts.length - 2]! : null;
  const stepIn = prev ? Math.abs(midi(last.pitch) - midi(prev.pitch)) <= 2 && midi(last.pitch) !== midi(prev.pitch) : false;
  const onChordTone = last.harmonic?.kind === "chord-tone";
  const strong = last.metric.accent >= 2;
  const kind = last.harmonic === null ? "interrupted" : onChordTone && strong && stepIn ? "arrival" : "open";
  const evidence = [
    `the last note ${formatPitch(last.pitch)} is ${last.harmonic === null ? "not a tone of the sounding chord" : `the ${last.harmonic.role} of the sounding chord`}`,
    `it falls on a ${last.metric.label}`,
    stepIn ? "it is reached by step" : "it is not reached by step",
  ];
  return {
    notes: facts.map((f) => f.id),
    contour: contourOf(facts),
    climax: { note: facts[climaxIdx]!.id, index: climaxIdx, unique: ms.filter((m) => m === hi).length === 1, position: facts.length > 1 ? climaxIdx / (facts.length - 1) : 0 },
    tension,
    silences,
    ending: { note: last.id, onChordTone, metric: last.metric.label, approachedByStep: stepIn, kind, evidence },
    durations: facts.map((f) => `${f.duration.num}/${f.duration.den}`),
    intervals: ms.slice(1).map((m, i) => m - ms[i]!),
  };
}

export interface ProposedRelation {
  readonly kind: IRPhraseRelation["kind"];
  readonly confidence: number;
  readonly evidence: readonly string[];
}

/** Proposed relations from phrase `a` to a later phrase `b`. Several may be proposed; none is certain. */
export function relatePhrases(a: PhraseDescription, b: PhraseDescription): ProposedRelation[] {
  const out: ProposedRelation[] = [];
  const sameRhythm = a.durations.join() === b.durations.join();
  const sameIntervals = a.intervals.join() === b.intervals.join();
  const n = Math.min(a.intervals.length, b.intervals.length);
  let sharedPrefix = 0;
  while (sharedPrefix < n && a.intervals[sharedPrefix] === b.intervals[sharedPrefix]) sharedPrefix++;
  const differing = a.intervals.length === b.intervals.length ? a.intervals.filter((x, i) => x !== b.intervals[i]).length : Infinity;

  if (sameRhythm && sameIntervals) out.push({ kind: "repetition", confidence: 0.9, evidence: ["the same intervals and the same rhythm"] });
  else if (sameRhythm && differing <= 2) out.push({ kind: "repetition-with-variation", confidence: 0.7, evidence: ["the same rhythm", `${differing} interval${differing === 1 ? "" : "s"} changed`] });
  else if (sameIntervals) out.push({ kind: "repetition-with-variation", confidence: 0.65, evidence: ["the same intervals with a different rhythm"] });

  // question and answer: the first leaves the harmony open, the second arrives
  if (a.ending.kind !== "arrival" && b.ending.kind === "arrival") {
    const ev = [`the first phrase ends ${a.ending.kind === "interrupted" ? "on a non-chord tone" : "open"}`, "the second ends with an arrival"];
    if (sharedPrefix >= 2 || sameRhythm) {
      out.push({ kind: "antecedent-consequent", confidence: 0.7, evidence: [...ev, sameRhythm ? "they share a rhythm" : `they share their first ${sharedPrefix} intervals`] });
    }
    out.push({ kind: "question-answer", confidence: 0.5, evidence: ev });
  }
  if (a.ending.kind === "interrupted") out.push({ kind: "interruption", confidence: 0.6, evidence: a.ending.evidence });
  if (b.ending.kind === "arrival") out.push({ kind: "cadential-arrival", confidence: 0.6, evidence: b.ending.evidence });
  return out;
}

/** Store proposed relations in the document's semantic layer, between two phrases already listed there. */
export function withPhraseRelations(ir: MusicIR, fromPhrase: string, toPhrase: string, proposed: readonly ProposedRelation[]): MusicIR {
  const sem = ir.semantics ?? { version: 1 as const };
  const existing = sem.phraseRelations ?? [];
  const added: IRPhraseRelation[] = proposed.map((p, i) => ({ id: `pr-${existing.length + i + 1}`, kind: p.kind, from: fromPhrase, to: toPhrase, evidence: p.evidence }));
  return { ...ir, semantics: { ...sem, version: 1 as const, phraseRelations: [...existing, ...added] } };
}
