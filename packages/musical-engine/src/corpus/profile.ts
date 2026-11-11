/**
 * A corpus profile: a few measured distributions that steer Generator B (see generatorB.ts).
 *
 * It is derived ONLY from the development half of the fixed split (split.ts), so the held-out half stays unseen and can
 * later show whether B generalises. It holds numbers about phrases (how long the last note is, how dense the writing
 * is, what shape the activity takes, how a phrase relates to the one before it); it holds no pitches, no rhythm
 * sequences and no melody, so nothing in it can be played back as a corpus tune.
 */
import { corpusPhraseSequences, type RelationKind } from "./compare";
import type { CorpusSplit } from "./split";
import type { CorpusPiece } from "./types";

export const PROFILE_SCHEMA = "nugget-corpus-profile" as const;

export interface CorpusProfile {
  readonly schema: typeof PROFILE_SCHEMA;
  readonly version: 1;
  readonly source: {
    readonly corpus: string;
    /** The pieces the numbers come from: development pieces only. */
    readonly pieceIds: readonly string[];
    readonly phrases: number;
    /** Neighbouring phrase pairs behind the relation shares. */
    readonly pairs: number;
  };
  /** Length of each phrase's last note, in beats, sorted: an empirical distribution that is sampled, not summarised. */
  readonly finalBeats: readonly number[];
  /** Length of each phrase in beats, sorted: B draws a whole-phrase length from this and builds the run-up to fit. */
  readonly phraseBeats: readonly number[];
  /** Notes per beat of each phrase, sorted. */
  readonly notesPerBeat: readonly number[];
  /** Share of phrases by activity shape (even, rising, falling, arch, valley, burst-hold). */
  readonly activityShapes: Readonly<Record<string, number>>;
  /** Share of phrases by overall contour. */
  readonly contours: Readonly<Record<string, number>>;
  /** Share of neighbouring phrase pairs by how the second relates to the first (see compare.ts). */
  readonly relations: Readonly<Record<RelationKind, number>>;
  /** Mean per-phrase rhythmic features: which kinds of rhythm the corpus actually uses. */
  readonly rhythm: { readonly restPhraseShare: number; readonly dottedShare: number; readonly tripletShare: number; readonly syncopatedShare: number };
}

const shares = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  for (const k of Object.keys(out)) out[k] = Math.round((out[k]! / xs.length) * 1000) / 1000;
  return out;
};
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function deriveCorpusProfile(pieces: readonly CorpusPiece[], split: CorpusSplit, corpusName: string): CorpusProfile {
  const dev = new Set(split.development);
  const used = pieces.filter((p) => dev.has(p.id));
  if (used.length === 0) throw new RangeError("the development half of the split has no pieces to derive a profile from");
  const seqs = corpusPhraseSequences(used);
  const phrases = seqs.flatMap((s) => s.phrases);
  const relations = seqs.flatMap((s) => s.relations);
  if (phrases.length === 0) throw new RangeError("no phrases were found in the development pieces");
  const rel = shares(relations);
  const kinds: RelationKind[] = ["exact", "modifiedEnding", "rhythmKept", "melodyKept", "none"];
  return {
    schema: PROFILE_SCHEMA,
    version: 1,
    source: { corpus: corpusName, pieceIds: used.map((p) => p.id).sort(), phrases: phrases.length, pairs: relations.length },
    finalBeats: phrases.map((p) => r3(p.finalBeats)).sort((a, b) => a - b),
    phraseBeats: phrases.map((p) => r3(p.beats)).sort((a, b) => a - b),
    notesPerBeat: phrases.map((p) => r3(p.notesPerBeat)).sort((a, b) => a - b),
    activityShapes: shares(phrases.map((p) => p.activityShape)),
    contours: shares(phrases.map((p) => p.contour)),
    relations: Object.fromEntries(kinds.map((k) => [k, rel[k] ?? 0])) as Record<RelationKind, number>,
    rhythm: {
      restPhraseShare: r3(phrases.filter((p) => p.hasWrittenRest).length / phrases.length),
      dottedShare: r3(mean(phrases.map((p) => p.dottedShare))),
      tripletShare: r3(mean(phrases.map((p) => p.tripletShare))),
      syncopatedShare: r3(mean(phrases.map((p) => p.syncopatedShare))),
    },
  };
}
