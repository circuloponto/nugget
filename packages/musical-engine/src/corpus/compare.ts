/**
 * Real music against Nugget's generator, measured by the same code.
 *
 * The unit of comparison is the PHRASE: the corpus's hypothesised phrases (see analysis/phrases.ts) against the
 * generator's phrases, each cut out as its own MelodyLine and measured by the identical rhythm, melody and phrase
 * analyses. Two rulers keep this honest:
 *
 *  - Spread. Every metric is also computed per corpus piece and per generator run. A generator value is "within" the
 *    corpus if it lies inside the 10th–90th percentile of the pieces' own values, so a difference is only reported as
 *    one when it exceeds how much real tunes differ from each other.
 *  - Subsets. The same numbers are given for the whole corpus, its 4/4 tunes only (the generator writes only 4/4, and
 *    beat-relative measures differ between meters), and the development and held-out halves of the fixed split.
 *
 *  - Matched subsets. The corpus phrases are also restricted to the generator's own length range (duration-matched), alone
 *    and together with the 4/4 filter. A finding that keeps its direction across these subsets is called stable; one
 *    that appears or vanishes depending on the subset may only reflect the repertoire.
 *
 * Two kinds of measure are kept apart. Single-phrase metrics describe each phrase on its own. Sequence metrics
 * ("continuity" and "development") describe how phrases follow each other inside one tune or generator run: how long
 * the music goes on without a written rest, and whether a phrase takes up what the previous one introduced.
 *
 * A difference is not a defect: the corpus is a small set of folk dance tunes, the generator writes jazz-style lines
 * over a ii–V–I. The verdict says "outside the corpus's range", nothing more.
 */
import { fnum, fstr } from "../time/rational";
import type { GeneratorRun } from "./generatorSample";
import { melodicAnalysis, intervalClass } from "./analysis/melodic";
import { melodyFromCorpusPiece, type MelodyEvent, type MelodyLine, type MelodyNote } from "./analysis/melody";
import { analyzePhrases, comparePhraseProfiles, phraseProfile, type PhraseProfile } from "./analysis/phrases";
import { rhythmAnalysis } from "./analysis/rhythm";
import { quantile, round } from "./analysis/stats";
import { splitCorpus, type CorpusSplit } from "./split";
import type { CorpusPiece } from "./types";

// ── cutting a phrase out of a line ────────────────────────────────────────
/**
 * The events from note `from` to note `to` (inclusive indices into line.notes) as a MelodyLine of their own. A written
 * rest immediately before or after the phrase belongs to it; a suspected-padding rest does not. Bars are renumbered to
 * the ones the phrase uses, so bar-based measures are not diluted by empty bars.
 *
 * A written rest between two consecutive phrases is the same silence for both. For context each side may take it (the
 * default), but when phrases are measured together it must belong to one of them or the silence is counted twice:
 * pass `{ leading: false }` for every phrase after the first, so the rest stays with the phrase it ends.
 */
export function sliceLine(line: MelodyLine, from: number, to: number, own: { readonly leading?: boolean; readonly trailing?: boolean } = {}): MelodyLine {
  let a = line.notes[from]!.index;
  let b = line.notes[to]!.index;
  const written = (e: MelodyEvent | undefined) => e?.kind === "rest" && !e.suspect;
  if (own.leading !== false) while (a > 0 && written(line.events[a - 1])) a--;
  if (own.trailing !== false) while (b + 1 < line.events.length && written(line.events[b + 1])) b++;
  const slice = line.events.slice(a, b + 1);
  const used = [...new Set(slice.map((e) => e.bar))].sort((x, y) => x - y);
  const remap = new Map(used.map((barIndex, i) => [barIndex, i] as const));
  const bars = used.map((barIndex, i) => ({ ...line.bars[barIndex]!, index: i }));
  const events: MelodyEvent[] = slice.map((e, i) => ({ ...e, index: i, bar: remap.get(e.bar)! }));
  const notes = events.filter((e): e is MelodyNote => e.kind === "note");
  const last = events[events.length - 1]!;
  return { ...line, id: `${line.id}#${from}-${to}`, bars, events, notes, length: last.end };
}

// ── measuring one phrase ──────────────────────────────────────────────────
export const DURATION_CLASSES = ["very short (< ½ beat)", "short (½ beat)", "medium (½–1)", "long (1–2)", "held (≥ 2)"] as const;
export const FINAL_CLASSES = ["< ½ beat", "½ beat", "1 beat", "1½ beats", "2+ beats"] as const;
const EPS = 1e-9;
const ACTIVITY_BINS = 10;

interface PhraseMeasure {
  readonly id: string;
  readonly notes: number;
  readonly beats: number;
  readonly durationClass: readonly number[];
  readonly runsGe4: number;
  readonly runsGe8: number;
  readonly longestRun: number;
  readonly bursts: number;
  readonly burstsHeld: number;
  readonly hasRest: boolean;
  readonly restTime: number;
  readonly span: number;
  readonly startsWithRest: boolean;
  readonly endsWithRest: boolean;
  readonly interiorRest: boolean;
  readonly repeatedMotif: boolean;
  readonly syncopated: number;
  readonly offbeat: number;
  readonly intervals: readonly number[];
  readonly gap: { readonly leaps: number; readonly reversed: number };
  readonly directionChanges: number;
  readonly contour: string;
  readonly shape: string;
  readonly finalBeats: number;
  readonly finalClass: number;
  readonly decelerates: boolean;
  readonly finalStrong: boolean;
  readonly finalByStep: boolean;
  readonly opensOnDownbeat: boolean;
  readonly repeatedCell: boolean;
  readonly distinctDurations: number;
  readonly rhythmKey: string;
  /** Exact note lengths in order (for comparing a phrase with the one before it). */
  readonly durations: readonly string[];
  /** Beats in the phrase's bars. */
  readonly bars: number;
  readonly activity: readonly number[];
  readonly activityShape: string;
  readonly profile: PhraseProfile;
}

function measurePhrase(line: MelodyLine): PhraseMeasure {
  const n = line.notes.length;
  const r = rhythmAnalysis(line);
  const m = melodicAnalysis(line);
  const profile = phraseProfile(line, 0, n - 1);
  const first = line.events[0]!;
  const last = line.events[line.events.length - 1]!;
  const t0 = fnum(first.onset);
  const span = Math.max(EPS, fnum(last.end) - t0);
  const beatOf = (e: MelodyEvent) => fnum(e.duration) / fnum(line.bars[e.bar]!.beat);
  const cls = [0, 0, 0, 0, 0];
  for (const x of line.notes) {
    const b = beatOf(x);
    cls[b < 0.5 - EPS ? 0 : b < 0.5 + EPS ? 1 : b < 1 - EPS ? 2 : b < 2 - EPS ? 3 : 4]!++;
  }
  const finalBeats = profile.ending.finalBeats;
  const restTime = line.events.filter((e) => e.kind === "rest" && !e.suspect).reduce((acc, e) => acc + fnum(e.duration), 0);
  const bins = new Array<number>(ACTIVITY_BINS).fill(0);
  const noteSpan = Math.max(EPS, fnum(line.notes[n - 1]!.end) - fnum(line.notes[0]!.onset));
  for (const x of line.notes) bins[Math.min(ACTIVITY_BINS - 1, Math.floor(((fnum(x.onset) - fnum(line.notes[0]!.onset)) / noteSpan) * ACTIVITY_BINS))]!++;
  const lastNote = line.notes[n - 1]!;
  const fic = profile.ending.finalIntervalClass;
  return {
    id: line.id,
    notes: n,
    beats: profile.beats,
    durationClass: cls,
    runsGe4: r.shortRuns.lengths.filter((x) => x >= 4).reduce((a, b) => a + b, 0),
    runsGe8: r.shortRuns.lengths.filter((x) => x >= 8).reduce((a, b) => a + b, 0),
    longestRun: r.shortRuns.longest,
    bursts: m.joint.burstThenHold.bursts,
    burstsHeld: m.joint.burstThenHold.heldAfter + m.joint.burstThenHold.restAfter,
    hasRest: line.events.some((e) => e.kind === "rest" && !e.suspect),
    restTime,
    span,
    startsWithRest: first.kind === "rest" && !first.suspect,
    endsWithRest: last.kind === "rest" && !last.suspect,
    interiorRest: line.events.slice(1, -1).some((e) => e.kind === "rest" && !e.suspect),
    repeatedMotif: m.motifs.some((x) => !x.uniform),
    syncopated: r.metric.syncopatedNotes,
    offbeat: line.notes.filter((x) => x.weight <= 1).length,
    intervals: m.intervals,
    gap: { leaps: m.gapFill.leaps, reversed: m.gapFill.reverseByStep + m.gapFill.reverseByLeap },
    directionChanges: m.direction.changes,
    contour: m.contour.kind,
    shape: m.contour.shape,
    finalBeats,
    finalClass: finalBeats < 0.5 - EPS ? 0 : finalBeats < 0.5 + EPS ? 1 : finalBeats < 1 + EPS ? 2 : finalBeats < 1.5 + EPS ? 3 : 4,
    decelerates: profile.ending.decelerates,
    finalStrong: lastNote.weight >= 3,
    finalByStep: fic === "step" || fic === "repeat",
    opensOnDownbeat: profile.opening.firstWeight >= 3,
    repeatedCell: r.cells.repeated.some((c) => !c.uniform && c.length >= 2),
    distinctDurations: r.durations.distinct,
    rhythmKey: line.notes.map((x) => fstr(x.duration)).join(","),
    durations: line.notes.map((x) => fstr(x.duration)),
    bars: profile.bars,
    activity: bins.map((c) => c / n),
    activityShape: profile.activityShape,
    profile,
  };
}

// ── metrics ───────────────────────────────────────────────────────────────
export type MetricGroup = "size" | "rhythm" | "silence" | "melody" | "contour" | "ending" | "diversity" | "continuity" | "development";

export interface MetricDef {
  readonly id: string;
  readonly label: string;
  readonly group: MetricGroup;
  readonly description: string;
  /** For display only: how to print the value. */
  readonly unit: "share" | "count" | "beats" | "semitones" | "score";
}

export const METRICS: readonly MetricDef[] = [
  { id: "notesPerPhrase", label: "notes per phrase (median)", group: "size", unit: "count", description: "length of a phrase in notes; a generated phrase is 1–1½ bars, a corpus phrase about 2" },
  { id: "beatsPerPhrase", label: "beats per phrase (median)", group: "size", unit: "beats", description: "length in beats (a beat is a dotted quarter in 6/8)" },
  { id: "attacksPerBeat", label: "attacks per beat", group: "rhythm", unit: "count", description: "notes per beat of phrase time" },
  { id: "shortShare", label: "short notes (≤ ½ beat)", group: "rhythm", unit: "share", description: "share of notes no longer than half a beat" },
  { id: "longShare", label: "sustained notes (≥ 1 beat)", group: "rhythm", unit: "share", description: "share of notes at least a beat long" },
  { id: "heldShare", label: "held notes (≥ 2 beats)", group: "rhythm", unit: "share", description: "share of notes at least two beats long" },
  { id: "runs4Share", label: "notes in runs of 4+ short notes", group: "rhythm", unit: "share", description: "consecutive-note runs: share of notes in unbroken runs of four or more short notes" },
  { id: "runs8Share", label: "notes in runs of 8+ short notes", group: "rhythm", unit: "share", description: "share of notes in unbroken runs of eight or more short notes" },
  { id: "longestRun", label: "longest run of short notes (mean)", group: "rhythm", unit: "count", description: "mean over phrases of the longest run" },
  { id: "burstHoldShare", label: "bursts that end held or on a rest", group: "rhythm", unit: "share", description: "of runs of 3+ short notes, the share followed by a note ≥ 1 beat or a written rest" },
  { id: "distinctDurations", label: "distinct note lengths per phrase", group: "rhythm", unit: "count", description: "rhythmic variety inside a phrase" },
  { id: "repeatedCellShare", label: "phrases with a repeated rhythmic cell", group: "rhythm", unit: "share", description: "phrases in which a non-uniform rhythmic cell of two or more events recurs" },
  { id: "repeatedMotifShare", label: "phrases with a repeated melodic motif", group: "rhythm", unit: "share", description: "phrases in which an interval pattern of three or more steps recurs (short phrases rarely can)" },
  { id: "syncopationShare", label: "syncopated notes", group: "rhythm", unit: "share", description: "notes starting on a weaker position than one they cross" },
  { id: "offbeatShare", label: "attacks on weak positions", group: "rhythm", unit: "share", description: "share of attacks at half-beat or finer positions" },
  { id: "restPhraseShare", label: "phrases containing a written rest", group: "silence", unit: "share", description: "written rests only; suspected converter padding is excluded on the corpus side" },
  { id: "restTimeShare", label: "time spent in written rests", group: "silence", unit: "share", description: "share of phrase time that is written silence" },
  { id: "startsWithRestShare", label: "phrases that open with a rest", group: "silence", unit: "share", description: "a rest before the first note" },
  { id: "interiorRestShare", label: "phrases with a rest inside", group: "silence", unit: "share", description: "a written rest between the first and last note" },
  { id: "endsWithRestShare", label: "phrases that end with a rest", group: "silence", unit: "share", description: "a written rest after the last note" },
  { id: "stepShare", label: "steps (≤ 2 semitones)", group: "melody", unit: "share", description: "share of intervals that are steps" },
  { id: "skipShare", label: "skips (3–4 semitones)", group: "melody", unit: "share", description: "share of intervals that are thirds" },
  { id: "leapShare", label: "leaps (≥ 5 semitones)", group: "melody", unit: "share", description: "share of intervals that are leaps" },
  { id: "repeatShare", label: "repeated pitches", group: "melody", unit: "share", description: "share of intervals that repeat a pitch" },
  { id: "meanAbsInterval", label: "mean interval size", group: "melody", unit: "semitones", description: "mean absolute interval" },
  { id: "reversalAfterLeap", label: "line reverses after a leap", group: "melody", unit: "share", description: "of leaps that are followed by a move, the share that turn back" },
  { id: "directionChangeRate", label: "direction changes per note", group: "melody", unit: "share", description: "turning points relative to length" },
  { id: "contourArch", label: "arch contours", group: "contour", unit: "share", description: "phrases whose highest note is inside and clearly above both ends" },
  { id: "contourValley", label: "valley contours", group: "contour", unit: "share", description: "phrases whose lowest note is inside and clearly below both ends" },
  { id: "contourAscending", label: "ascending contours", group: "contour", unit: "share", description: "phrases rising by 3+ semitones overall" },
  { id: "contourDescending", label: "descending contours", group: "contour", unit: "share", description: "phrases falling by 3+ semitones overall" },
  { id: "contourLevel", label: "level contours", group: "contour", unit: "share", description: "phrases with little overall movement" },
  { id: "opensOnDownbeat", label: "opens on a strong position", group: "ending", unit: "share", description: "first note on the downbeat or a group start" },
  { id: "finalBeatsMedian", label: "last note length (median, beats)", group: "ending", unit: "beats", description: "duration of the final note" },
  { id: "finalDecelerates", label: "phrase decelerates into its end", group: "ending", unit: "share", description: "final note ≥ 1 beat and ≥ 1.5× the phrase's mean note length" },
  { id: "finalOnStrong", label: "ends on a strong position", group: "ending", unit: "share", description: "final note on the downbeat or a group start" },
  { id: "finalByStep", label: "final note reached by step or repeat", group: "ending", unit: "share", description: "the last interval is a step or a repeated pitch" },
  { id: "meanPairDistance", label: "difference between phrases (mean)", group: "diversity", unit: "score", description: "1 − overall similarity (comparePhraseProfiles), averaged over pairs of phrases within one tune / one generator run" },
  { id: "distinctRhythmShare", label: "distinct rhythms", group: "diversity", unit: "share", description: "share of phrases whose exact rhythm differs from every other phrase in the same tune / run" },
  { id: "longestStreakNotes", label: "longest unbroken run of notes (notes)", group: "continuity", unit: "count", description: "the most notes in a row with no written rest between them, of any length, counted across phrase boundaries within one tune / run (suspected converter padding does not break it). It is bounded by how long the tune / run is, so read it against the matched subsets" },
  { id: "longestStreakBeats", label: "longest unbroken run of notes (beats)", group: "continuity", unit: "beats", description: "the same stretch measured in beats of sound, for one tune / run" },
  { id: "adjSimilarity", label: "similarity to the previous phrase (mean)", group: "development", unit: "score", description: "overall similarity (comparePhraseProfiles) of each phrase with the one just before it; only neighbours, unlike the all-pairs difference above" },
  { id: "adjExact", label: "exact repetition of the previous phrase", group: "development", unit: "share", description: "neighbouring phrases with the same note lengths and the same interval sequence (at any transposition)" },
  { id: "adjRhythmKept", label: "rhythm repeated, melody varied", group: "development", unit: "share", description: "neighbouring phrases with exactly the same note lengths but a different interval sequence" },
  { id: "adjMelodyKept", label: "melody recurs, rhythm varied", group: "development", unit: "share", description: "neighbouring phrases with different note lengths that repeat the interval sequence or share at least one three-step interval pattern" },
  { id: "adjModifiedEnding", label: "same phrase, modified ending", group: "development", unit: "share", description: "neighbouring phrases of 4+ notes that match all but their ending (rhythm and intervals), the matching part covering 75% or more of the longer phrase" },
  { id: "adjMotifShared", label: "shares a melodic motif with the previous phrase", group: "development", unit: "share", description: "neighbouring phrases that have at least one interval pattern of three steps (not a straight scale or repeat) in common, at any transposition" },
  { id: "adjMotifCarried", label: "motif material carried over (mean)", group: "development", unit: "share", description: "of the three-step interval patterns in a phrase, the share that were already in the previous phrase" },
  { id: "distinctShapeShare", label: "distinct contour shapes", group: "diversity", unit: "share", description: "share of phrases whose up/down shape differs from every other phrase in the same tune / run" },
];

const sumBy = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
const medianOf = (xs: readonly number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** Within-group diversity over pairs of phrases (all pairs; groups are small). */
function diversity(group: readonly PhraseMeasure[]): { dist: number; rhythm: number; shape: number } | null {
  if (group.length < 2) return null;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    total += 1 - comparePhraseProfiles(group[i]!.profile, group[j]!.profile).overall;
    pairs++;
  }
  const uniq = (key: (p: PhraseMeasure) => string) => group.filter((p, i) => group.every((q, j) => i === j || key(q) !== key(p))).length / group.length;
  return { dist: total / pairs, rhythm: uniq((p) => p.rhythmKey), shape: uniq((p) => p.shape) };
}

function metricsOf(ps: readonly PhraseMeasure[]): Record<string, number> {
  const notes = sumBy(ps, (p) => p.notes);
  const allIv = ps.flatMap((p) => p.intervals);
  const ic = (c: string) => allIv.filter((x) => intervalClass(x) === c).length;
  const leaps = sumBy(ps, (p) => p.gap.leaps);
  const bursts = sumBy(ps, (p) => p.bursts);
  const kind = (k: string) => ratio(ps.filter((p) => p.contour === k).length, ps.length);
  return {
    notesPerPhrase: medianOf(ps.map((p) => p.notes)),
    beatsPerPhrase: medianOf(ps.map((p) => p.beats)),
    attacksPerBeat: ratio(notes, sumBy(ps, (p) => p.beats)),
    shortShare: ratio(sumBy(ps, (p) => p.durationClass[0]! + p.durationClass[1]!), notes),
    longShare: ratio(sumBy(ps, (p) => p.durationClass[3]! + p.durationClass[4]!), notes),
    heldShare: ratio(sumBy(ps, (p) => p.durationClass[4]!), notes),
    runs4Share: ratio(sumBy(ps, (p) => p.runsGe4), notes),
    runs8Share: ratio(sumBy(ps, (p) => p.runsGe8), notes),
    longestRun: ratio(sumBy(ps, (p) => p.longestRun), ps.length),
    burstHoldShare: ratio(sumBy(ps, (p) => p.burstsHeld), bursts),
    distinctDurations: ratio(sumBy(ps, (p) => p.distinctDurations), ps.length),
    repeatedCellShare: ratio(ps.filter((p) => p.repeatedCell).length, ps.length),
    syncopationShare: ratio(sumBy(ps, (p) => p.syncopated), notes),
    offbeatShare: ratio(sumBy(ps, (p) => p.offbeat), notes),
    restPhraseShare: ratio(ps.filter((p) => p.hasRest).length, ps.length),
    restTimeShare: ratio(sumBy(ps, (p) => p.restTime), sumBy(ps, (p) => p.span)),
    startsWithRestShare: ratio(ps.filter((p) => p.startsWithRest).length, ps.length),
    interiorRestShare: ratio(ps.filter((p) => p.interiorRest).length, ps.length),
    repeatedMotifShare: ratio(ps.filter((p) => p.repeatedMotif).length, ps.length),
    endsWithRestShare: ratio(ps.filter((p) => p.endsWithRest).length, ps.length),
    stepShare: ratio(ic("step"), allIv.length),
    skipShare: ratio(ic("skip"), allIv.length),
    leapShare: ratio(ic("leap"), allIv.length),
    repeatShare: ratio(ic("repeat"), allIv.length),
    meanAbsInterval: ratio(sumBy(allIv, Math.abs), allIv.length),
    reversalAfterLeap: ratio(sumBy(ps, (p) => p.gap.reversed), leaps),
    directionChangeRate: ratio(sumBy(ps, (p) => p.directionChanges), notes),
    contourArch: kind("arch"),
    contourValley: kind("valley"),
    contourAscending: kind("ascending"),
    contourDescending: kind("descending"),
    contourLevel: kind("level"),
    opensOnDownbeat: ratio(ps.filter((p) => p.opensOnDownbeat).length, ps.length),
    finalBeatsMedian: medianOf(ps.map((p) => p.finalBeats)),
    finalDecelerates: ratio(ps.filter((p) => p.decelerates).length, ps.length),
    finalOnStrong: ratio(ps.filter((p) => p.finalStrong).length, ps.length),
    finalByStep: ratio(ps.filter((p) => p.finalByStep).length, ps.length),
  };
}

export interface Distributions {
  readonly durationClasses: Readonly<Record<string, number>>;
  readonly intervals: Readonly<Record<string, number>>;
  readonly contour: Readonly<Record<string, number>>;
  readonly finalBeats: Readonly<Record<string, number>>;
  readonly activityShape: Readonly<Record<string, number>>;
  /** Mean share of a phrase's attacks in each tenth of its time. */
  readonly activityCurve: readonly number[];
}

function distributionsOf(ps: readonly PhraseMeasure[]): Distributions {
  const notes = sumBy(ps, (p) => p.notes) || 1;
  const dur: Record<string, number> = {};
  DURATION_CLASSES.forEach((c, i) => (dur[c] = round(sumBy(ps, (p) => p.durationClass[i]!) / notes)));
  const iv: Record<string, number> = {};
  const all = ps.flatMap((p) => p.intervals);
  for (let k = -9; k <= 9; k++) iv[k <= -9 ? "≤ −9" : k >= 9 ? "≥ 9" : String(k)] = 0;
  for (const x of all) {
    const r = Math.round(x);
    const key = r <= -9 ? "≤ −9" : r >= 9 ? "≥ 9" : String(r);
    iv[key] = (iv[key] ?? 0) + 1;
  }
  for (const k of Object.keys(iv)) iv[k] = round(iv[k]! / (all.length || 1));
  const ct: Record<string, number> = {};
  for (const k of ["ascending", "descending", "arch", "valley", "level"]) ct[k] = round(ps.filter((p) => p.contour === k).length / (ps.length || 1));
  const fb: Record<string, number> = {};
  FINAL_CLASSES.forEach((c, i) => (fb[c] = round(ps.filter((p) => p.finalClass === i).length / (ps.length || 1))));
  const sh: Record<string, number> = {};
  for (const k of ["even", "rising", "falling", "arch", "valley", "burst-hold"]) sh[k] = round(ps.filter((p) => p.activityShape === k).length / (ps.length || 1));
  return {
    durationClasses: dur,
    intervals: iv,
    contour: ct,
    finalBeats: fb,
    activityShape: sh,
    activityCurve: Array.from({ length: ACTIVITY_BINS }, (_, b) => round(sumBy(ps, (p) => p.activity[b]!) / (ps.length || 1))),
  };
}

// ── groups, spread, verdicts ──────────────────────────────────────────────
export interface PhraseGroup {
  /** A corpus piece or a generator run. */
  readonly id: string;
  readonly lines: readonly MelodyLine[];
}

interface MeasuredGroup {
  readonly id: string;
  readonly phrases: PhraseMeasure[];
  readonly metrics: Record<string, number>;
}

const MIN_NOTES = 3;

const measureCache = new WeakMap<MelodyLine, PhraseMeasure>();
const measureOnce = (line: MelodyLine): PhraseMeasure => {
  let m = measureCache.get(line);
  if (!m) {
    m = measurePhrase(line);
    measureCache.set(line, m);
  }
  return m;
};

// ── sequences: continuity and development ─────────────────────────────────
type Slot = { readonly line: MelodyLine; readonly m: PhraseMeasure } | null;

/** The longest stretch of notes with no written rest between them, across the phrases of one tune / run, in order. */
function streaks(slots: readonly Slot[]): { notes: number; beats: number } {
  let best = { notes: 0, beats: 0 };
  let cur = { notes: 0, beats: 0 };
  const close = () => {
    if (cur.notes > best.notes) best = cur;
    cur = { notes: 0, beats: 0 };
  };
  for (const slot of slots) {
    if (!slot) {
      close(); // a phrase that was left out (too short, or outside the subset) breaks the stream
      continue;
    }
    for (const e of slot.line.events) {
      if (e.kind === "rest") {
        if (!e.suspect) close();
      } else {
        cur = { notes: cur.notes + 1, beats: cur.beats + fnum(e.duration) / fnum(slot.line.bars[e.bar]!.beat) };
      }
    }
  }
  close();
  return best;
}

const grams = (ivs: readonly number[]): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= ivs.length; i++) {
    const g = ivs.slice(i, i + 3).map((x) => Math.round(x * 100) / 100);
    if (g[0] === g[1] && g[1] === g[2]) continue; // a repeat or a straight scale is not a motif
    out.add(g.join(","));
  }
  return out;
};

/**
 * How a phrase relates to the one just before it. The four kinds are exclusive and tried in this order: exact
 * repetition, modified ending, rhythm kept with the melody varied, melody recurring with the rhythm varied. A pair that
 * is none of them is simply unrelated.
 */
type Kind = "exact" | "modifiedEnding" | "rhythmKept" | "melodyKept" | "none";
const sameList = (x: readonly (string | number)[], y: readonly (string | number)[], n: number) => x.length >= n && y.length >= n && x.slice(0, n).every((v, i) => v === y[i]);
function relate(prev: PhraseMeasure, next: PhraseMeasure) {
  const nPrev = prev.durations.length;
  const nNext = next.durations.length;
  const common = Math.min(nPrev, nNext);
  const longer = Math.max(nPrev, nNext);
  const durEq = prev.rhythmKey === next.rhythmKey;
  const ivEq = prev.intervals.length === next.intervals.length && sameList(prev.intervals, next.intervals, prev.intervals.length);
  const a = grams(prev.intervals);
  const b = grams(next.intervals);
  const hasMotifs = b.size > 0;
  const carried = hasMotifs ? [...b].filter((g) => a.has(g)).length / b.size : 0;
  const prefixKept = common >= 4 && common - 1 >= 0.75 * longer && sameList(prev.durations, next.durations, common - 1) && sameList(prev.intervals, next.intervals, common - 2);
  const kind: Kind = durEq && ivEq ? "exact" : prefixKept ? "modifiedEnding" : durEq ? "rhythmKept" : ivEq || carried > 0 ? "melodyKept" : "none";
  return { sim: comparePhraseProfiles(prev.profile, next.profile).overall, kind, hasMotifs, carried };
}

/** Neighbour-pair measures over a list of (previous, next) pairs. Returns nothing for an empty list. */
function developmentOf(pairs: readonly (readonly [PhraseMeasure, PhraseMeasure])[]): Record<string, number> {
  if (pairs.length === 0) return {};
  const rel = pairs.map(([a, b]) => relate(a, b));
  const motif = rel.filter((r) => r.hasMotifs);
  const share = (k: Kind) => ratio(rel.filter((r) => r.kind === k).length, rel.length);
  const out: Record<string, number> = {
    adjSimilarity: ratio(sumBy(rel, (r) => r.sim), rel.length),
    adjExact: share("exact"),
    adjRhythmKept: share("rhythmKept"),
    adjMelodyKept: share("melodyKept"),
    adjModifiedEnding: share("modifiedEnding"),
  };
  if (motif.length) {
    out.adjMotifShared = ratio(motif.filter((r) => r.carried > 0).length, motif.length);
    out.adjMotifCarried = ratio(sumBy(motif, (r) => r.carried), motif.length);
  }
  return out;
}

interface Measured {
  readonly pooled: Record<string, number>;
  readonly groups: MeasuredGroup[];
  readonly dist: Distributions;
  readonly phrases: number;
  readonly pairs: number;
}

/** Measure groups; `keep` restricts which phrases count (a subset), and phrases outside it also break sequences. */
function measureGroups(groups: readonly PhraseGroup[], keep?: (m: PhraseMeasure) => boolean): Measured {
  const measured: MeasuredGroup[] = [];
  const allPairs: (readonly [PhraseMeasure, PhraseMeasure])[] = [];
  const streakNotes: number[] = [];
  const streakBeats: number[] = [];
  for (const g of groups) {
    const slots: Slot[] = g.lines.map((line) => {
      if (line.notes.length < MIN_NOTES) return null;
      const m = measureOnce(line);
      return !keep || keep(m) ? { line, m } : null;
    });
    const phrases = slots.filter((x): x is NonNullable<Slot> => x !== null).map((x) => x.m);
    if (phrases.length === 0) continue;
    const metrics = metricsOf(phrases);
    const d = diversity(phrases);
    if (d) Object.assign(metrics, { meanPairDistance: d.dist, distinctRhythmShare: d.rhythm, distinctShapeShare: d.shape });
    const st = streaks(slots);
    Object.assign(metrics, { longestStreakNotes: st.notes, longestStreakBeats: st.beats });
    streakNotes.push(st.notes);
    streakBeats.push(st.beats);
    const pairs: (readonly [PhraseMeasure, PhraseMeasure])[] = [];
    for (let i = 1; i < slots.length; i++) if (slots[i - 1] && slots[i]) pairs.push([slots[i - 1]!.m, slots[i]!.m]);
    Object.assign(metrics, developmentOf(pairs));
    allPairs.push(...pairs);
    measured.push({ id: g.id, phrases, metrics });
  }
  const all = measured.flatMap((g) => g.phrases);
  const pooled = metricsOf(all);
  for (const key of ["meanPairDistance", "distinctRhythmShare", "distinctShapeShare"]) {
    const vals = measured.map((g) => g.metrics[key]).filter((x): x is number => x !== undefined);
    pooled[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  pooled.longestStreakNotes = ratio(sumBy(streakNotes, (x) => x), streakNotes.length);
  pooled.longestStreakBeats = ratio(sumBy(streakBeats, (x) => x), streakBeats.length);
  Object.assign(pooled, developmentOf(allPairs)); // neighbour pairs pooled, not an average of per-tune averages
  return { pooled, groups: measured, dist: distributionsOf(all), phrases: all.length, pairs: allPairs.length };
}

const spread = (vals: readonly number[]): [number, number] => {
  const s = [...vals].sort((a, b) => a - b);
  return [round(quantile(s, 0.1)), round(quantile(s, 0.9))];
};

export type Verdict = "within" | "above" | "below";
const verdictOf = (v: number, [lo, hi]: [number, number]): Verdict => (v < lo - 1e-9 ? "below" : v > hi + 1e-9 ? "above" : "within");

/** The ways the corpus is cut. Each gives its own verdict for every metric. */
export const SUBSETS = ["all", "fourFour", "matched", "matchedFourFour", "development", "heldOut"] as const;
export type SubsetId = (typeof SUBSETS)[number];
/** The subsets that control for what kind of music is being compared (meter, phrase length); the split is separate. */
const REPERTOIRE_SUBSETS: readonly SubsetId[] = ["all", "fourFour", "matched", "matchedFourFour"];
/** A subset needs at least this many corpus pieces with a value before it can give a verdict. */
const MIN_SUBSET_PIECES = 3;

/**
 * stable: outside the corpus's range in the same direction in every control subset that could be judged (two or more);
 * stable-within: inside in all of them; repertoire: the subsets disagree, so the finding may only reflect which
 * repertoire is compared; unclear: fewer than two control subsets are large enough.
 */
export type Stability = "stable" | "stable-within" | "repertoire" | "unclear";

/**
 * A value is null when it cannot be computed (an empty subset, or a sequence measure with no neighbouring phrases).
 * It is never replaced by 0 or by "within", which would look like a result.
 */
export interface MetricRow extends MetricDef {
  readonly generator: number | null;
  readonly generatorSpread: readonly [number, number] | null;
  readonly corpus: number | null;
  readonly corpusSpread: readonly [number, number] | null;
  readonly corpusFourFour: number | null;
  /** Corpus phrases in the generator's length range, any meter. */
  readonly corpusMatched: number | null;
  /** … and also in 4/4. */
  readonly corpusMatchedFourFour: number | null;
  readonly corpusDevelopment: number | null;
  readonly corpusHeldOut: number | null;
  /** The generator's pooled value against the spread across individual corpus pieces (whole corpus). */
  readonly verdict: Verdict | null;
  /** The same, against the 4/4 tunes only. */
  readonly verdictFourFour: Verdict | null;
  /** The verdict in every subset; null where the subset is too small to judge. */
  readonly verdicts: Readonly<Record<SubsetId, Verdict | null>>;
  readonly stability: Stability;
}

export interface ExamplePhrase {
  readonly source: "generator" | "corpus";
  readonly id: string;
  readonly label: string;
  /** Notes with exact positions as numbers of whole notes from the phrase start. */
  readonly notes: readonly { readonly midi: number; readonly at: number; readonly len: number; readonly weight: number }[];
  readonly rests: readonly { readonly at: number; readonly len: number }[];
  readonly span: number;
}

export interface SubsetSize {
  readonly pieces: number;
  readonly phrases: number;
  /** Neighbouring phrase pairs available to the development metrics. */
  readonly pairs: number;
}

export interface GeneratorComparison {
  readonly schema: "nugget-generator-comparison";
  readonly version: 2;
  readonly sample: { readonly runs: number; readonly failedRuns: number; readonly phrases: number; readonly keys: readonly string[]; readonly seeds: readonly number[]; readonly meter: "4/4"; readonly medianBars: number; readonly medianBeats: number };
  readonly corpus: {
    readonly name: string;
    readonly pieces: number;
    readonly phrases: number;
    readonly fourFourPieces: number;
    readonly fourFourPhrases: number;
    readonly meters: Readonly<Record<string, number>>;
    readonly medianBars: number;
    readonly medianBeats: number;
    readonly writtenRests: number;
    readonly paddingRests: number;
    readonly split: CorpusSplit;
  };
  /** The phrase length (in beats) the generator covers; corpus phrases inside it form the matched subsets. */
  readonly matchRange: readonly [number, number];
  readonly subsets: Readonly<Record<SubsetId, SubsetSize>>;
  readonly rows: readonly MetricRow[];
  readonly distributions: { readonly generator: Distributions; readonly corpus: Distributions; readonly corpusFourFour: Distributions };
  readonly examples: { readonly generator: readonly ExamplePhrase[]; readonly corpus: readonly ExamplePhrase[] };
  readonly caveats: readonly string[];
}

function exampleOf(source: "generator" | "corpus", line: MelodyLine, label: string): ExamplePhrase {
  const t0 = fnum(line.events[0]!.onset);
  return {
    source,
    id: line.id,
    label,
    notes: line.notes.map((n) => ({ midi: n.midi, at: round(fnum(n.onset) - t0, 5), len: round(fnum(n.duration), 5), weight: n.weight })),
    rests: line.events.filter((e) => e.kind === "rest" && !e.suspect).map((e) => ({ at: round(fnum(e.onset) - t0, 5), len: round(fnum(e.duration), 5) })),
    span: round(fnum(line.events[line.events.length - 1]!.end) - t0, 5),
  };
}

const evenly = <T>(xs: readonly T[], k: number): T[] => (xs.length <= k ? [...xs] : Array.from({ length: k }, (_, i) => xs[Math.floor((i * xs.length) / k)]!));

export interface CompareInput {
  readonly runs: readonly GeneratorRun[];
  readonly pieces: readonly CorpusPiece[];
  readonly split?: CorpusSplit;
  /** How many example phrases of each kind to keep for drawing. */
  readonly examples?: number;
  /** Name of the corpus, for the report (default "the corpus"). */
  readonly corpusName?: string;
}

const countBy = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};
const list = (o: Readonly<Record<string, number>>) => Object.entries(o).map(([k, v]) => `${v} in ${k}`).join(", ");

export function compareGenerator(input: CompareInput): GeneratorComparison {
  const { runs, pieces } = input;
  const split = input.split ?? splitCorpus(pieces.map((p) => ({ id: p.id, category: p.provenance.catalog.category ?? "" })));
  const name = input.corpusName ?? "the corpus";

  // corpus phrases: each piece's phrases at the primary reading, cut out as lines. A written rest between two phrases
  // belongs to the earlier one, so silence is not counted twice.
  let writtenRests = 0;
  let paddingRests = 0;
  const corpusGroups: (PhraseGroup & { fourFour: boolean })[] = pieces.map((piece) => {
    const line = melodyFromCorpusPiece(piece);
    for (const e of line.events) if (e.kind === "rest") e.suspect ? paddingRests++ : writtenRests++;
    const index = new Map(line.notes.map((n, i) => [n.id, i] as const));
    const lines = analyzePhrases(line).phrases.map((ph, i) => sliceLine(line, index.get(ph.noteIds[0]!)!, index.get(ph.noteIds[ph.noteIds.length - 1]!)!, { leading: i === 0 }));
    return { id: piece.id, lines, fourFour: piece.measures.every((m) => m.meter.text === "4/4") };
  });
  const generatorGroups: PhraseGroup[] = runs.filter((r) => r.phrases.length > 0).map((r) => ({ id: `${r.key}-${r.mode}-s${r.seed}`, lines: r.phrases.map((p, i) => sliceLine(p.line, 0, p.line.notes.length - 1, { leading: i === 0 })) }));

  const gen = measureGroups(generatorGroups);
  const genBeats = gen.groups.flatMap((g) => g.phrases.map((p) => p.beats)).sort((a, b) => a - b);
  // the generator's own length range (5th–95th percentile of its phrases, in beats)
  const matchRange: [number, number] = genBeats.length ? [round(quantile(genBeats, 0.05)), round(quantile(genBeats, 0.95))] : [0, 0];
  const inRange = (m: PhraseMeasure) => m.beats >= matchRange[0] - 1e-9 && m.beats <= matchRange[1] + 1e-9;

  const fourFourGroups = corpusGroups.filter((g) => g.fourFour);
  const measuredSubsets: Record<SubsetId, Measured> = {
    all: measureGroups(corpusGroups),
    fourFour: measureGroups(fourFourGroups),
    matched: measureGroups(corpusGroups, inRange),
    matchedFourFour: measureGroups(fourFourGroups, inRange),
    development: measureGroups(corpusGroups.filter((g) => split.development.includes(g.id))),
    heldOut: measureGroups(corpusGroups.filter((g) => split.heldOut.includes(g.id))),
  };
  const cor = measuredSubsets.all;
  const ff = measuredSubsets.fourFour;

  const rows: MetricRow[] = METRICS.map((def) => {
    const valsOf = (m: Measured) => m.groups.map((g) => g.metrics[def.id]).filter((x): x is number => x !== undefined);
    const gv = gen.phrases > 0 ? gen.pooled[def.id] : undefined;
    const genVals = valsOf(gen);
    const verdicts = Object.fromEntries(
      SUBSETS.map((id) => {
        const vals = valsOf(measuredSubsets[id]);
        return [id, gv !== undefined && vals.length >= MIN_SUBSET_PIECES ? verdictOf(gv, spread(vals)) : null] as const;
      }),
    ) as Record<SubsetId, Verdict | null>;
    const judged = REPERTOIRE_SUBSETS.map((id) => verdicts[id]).filter((v): v is Verdict => v !== null);
    const stability: Stability = judged.length < 2 ? "unclear" : judged.every((v) => v === "within") ? "stable-within" : judged.every((v) => v === judged[0]) ? "stable" : "repertoire";
    const pooled = (m: Measured): number | null => (m.phrases > 0 && m.pooled[def.id] !== undefined ? round(m.pooled[def.id]!) : null);
    const spreadOf = (vals: readonly number[]): [number, number] | null => (vals.length ? spread(vals) : null);
    return {
      ...def,
      generator: gv === undefined ? null : round(gv),
      generatorSpread: spreadOf(genVals),
      corpus: pooled(cor),
      corpusSpread: spreadOf(valsOf(cor)),
      corpusFourFour: pooled(ff),
      corpusMatched: pooled(measuredSubsets.matched),
      corpusMatchedFourFour: pooled(measuredSubsets.matchedFourFour),
      corpusDevelopment: pooled(measuredSubsets.development),
      corpusHeldOut: pooled(measuredSubsets.heldOut),
      verdict: verdicts.all,
      verdictFourFour: verdicts.fourFour,
      verdicts,
      stability,
    };
  });

  const genLines = generatorGroups.flatMap((g) => g.lines).filter((l) => l.notes.length >= MIN_NOTES);
  const corLines = corpusGroups.flatMap((g) => g.lines).filter((l) => l.notes.length >= MIN_NOTES);
  const seeds = [...new Set(runs.map((r) => r.seed))].sort((a, b) => a - b);
  const medianOver = (m: Measured, f: (p: PhraseMeasure) => number) => round(medianOf(m.groups.flatMap((g) => g.phrases.map(f))));
  const meters = countBy(pieces.map((p) => p.measures[0]!.meter.text));
  const categories = countBy(pieces.map((p) => (p.provenance.catalog.category ?? "unlabelled").replace("_", " ")));
  const subsets = Object.fromEntries(SUBSETS.map((id) => [id, { pieces: measuredSubsets[id].groups.length, phrases: measuredSubsets[id].phrases, pairs: measuredSubsets[id].pairs }])) as Record<SubsetId, SubsetSize>;
  const sample = { runs: runs.length, failedRuns: runs.filter((r) => r.phrases.length === 0).length, phrases: gen.phrases, keys: [...new Set(runs.map((r) => r.key))], seeds, meter: "4/4" as const, medianBars: medianOver(gen, (p) => p.bars), medianBeats: medianOver(gen, (p) => p.beats) };
  const corInfo = { name, pieces: pieces.length, phrases: cor.phrases, fourFourPieces: fourFourGroups.length, fourFourPhrases: ff.phrases, meters, medianBars: medianOver(cor, (p) => p.bars), medianBeats: medianOver(cor, (p) => p.beats), writtenRests, paddingRests, split };

  const caveats: string[] = [
    `${name}: ${pieces.length} pieces (${list(categories)}), by meter ${list(meters)}. The generator writes 4/4 only. A difference between repertoires is not a defect.`,
    `Phrase length differs: the generator's phrases have a median of ${sample.medianBars} bars (${sample.medianBeats} beats), the corpus's ${corInfo.medianBars} bars (${corInfo.medianBeats} beats). The 4/4 subset (${subsets.fourFour.pieces} tunes, ${subsets.fourFour.phrases} phrases) controls for meter, not for length. The matched subsets keep only corpus phrases of ${matchRange[0]}–${matchRange[1]} beats, the generator's own range: ${subsets.matched.phrases} phrases from ${subsets.matched.pieces} tunes, of which ${subsets.matchedFourFour.phrases} from ${subsets.matchedFourFour.pieces} in 4/4.`,
    `Each metric carries its verdict in every subset and a stability label. "stable" means the generator is outside the corpus's range in the same direction in every control subset that was large enough (${MIN_SUBSET_PIECES}+ tunes); "repertoire" means the subsets disagree, so the difference may only reflect which music is compared; "unclear" means fewer than two subsets could be judged. Stable is not proof: the subsets overlap and are small.`,
    "A verdict compares the generator's pooled value with the 10th–90th percentile of individual corpus pieces: it says the value lies outside how much real tunes differ from each other, nothing about quality.",
    `The sequence metrics (continuity and development) look at neighbouring phrases inside one tune or run. They depend on where the phrase boundaries are, which for the corpus are heuristic hypotheses; the numbers of neighbouring pairs per subset are in the subset table (${subsets.all.pairs} for the whole corpus, ${subsets.matched.pairs} matched, ${subsets.matchedFourFour.pairs} matched in 4/4).`,
    "The development categories are exclusive and ordered (exact repetition, modified ending, rhythm kept, melody kept). \"Melody recurs\" is a loose test: any shared three-step interval pattern counts, so stepwise music shares one easily. The exact and modified-ending tests are strict and can be zero in a small corpus; a zero there says the corpus is too small to show it, not that it never happens.",
    writtenRests < 10
      ? `The corpus holds only ${writtenRests} written rest${writtenRests === 1 ? "" : "s"} (${paddingRests} more are suspected converter padding and are ignored), so it cannot say how much silence is right.`
      : `The corpus holds ${writtenRests} written rests (${paddingRests} more are suspected converter padding and are ignored). A written rest between two phrases is counted once, with the earlier phrase.`,
    "Phrase boundaries in the corpus are hypotheses (see the phrase analysis); the generator's phrases are exactly what it was asked to build.",
    "Nobody has listened to either side for this comparison; no listening evaluation has been done.",
  ];
  if (subsets.fourFour.pieces < 10) caveats.push(`Only ${subsets.fourFour.pieces} corpus tunes are in 4/4, so the 4/4 spreads rest on very few pieces.`);
  if (subsets.matched.phrases < 20) caveats.push(`Only ${subsets.matched.phrases} corpus phrases fall in the generator's length range; the matched verdicts are weak.`);

  return {
    schema: "nugget-generator-comparison",
    version: 2,
    sample,
    corpus: corInfo,
    matchRange,
    subsets,
    rows,
    distributions: { generator: gen.dist, corpus: cor.dist, corpusFourFour: ff.dist },
    examples: {
      generator: evenly(genLines, input.examples ?? 6).map((l) => exampleOf("generator", l, l.id)),
      corpus: evenly(corLines, input.examples ?? 6).map((l) => exampleOf("corpus", l, l.id)),
    },
    caveats,
  };
}

// ── phrase sequences, for deriving a profile ──────────────────────────────
export type RelationKind = Kind;

/** What a profile needs to know about one phrase; no pitches, no melody. */
export interface PhraseStats {
  readonly notes: number;
  readonly beats: number;
  readonly notesPerBeat: number;
  readonly finalBeats: number;
  readonly activityShape: string;
  readonly contour: string;
  readonly hasWrittenRest: boolean;
  readonly dottedShare: number;
  readonly tripletShare: number;
  readonly syncopatedShare: number;
}

export interface PieceSequence {
  readonly id: string;
  readonly phrases: readonly PhraseStats[];
  /** How phrase i relates to phrase i−1 (index 0 of this list is phrase 1). */
  readonly relations: readonly RelationKind[];
}

const statsOf = (m: PhraseMeasure): PhraseStats => {
  const share = (f: (d: string) => boolean) => ratio(m.durations.filter(f).length, m.durations.length);
  return {
    notes: m.notes,
    beats: m.beats,
    notesPerBeat: ratio(m.notes, m.beats),
    finalBeats: m.finalBeats,
    activityShape: m.activityShape,
    contour: m.contour,
    hasWrittenRest: m.hasRest,
    dottedShare: share((d) => d.split("/")[0] === "3" || d.split("/")[0] === "7"),
    tripletShare: share((d) => Number(d.split("/")[1] ?? 1) % 3 === 0),
    syncopatedShare: ratio(m.syncopated, m.notes),
  };
};

/** The measured phrases of each piece, in order, with how each one relates to the one before it. */
export function corpusPhraseSequences(pieces: readonly CorpusPiece[]): PieceSequence[] {
  return pieces.map((piece) => {
    const line = melodyFromCorpusPiece(piece);
    const index = new Map(line.notes.map((n, i) => [n.id, i] as const));
    const lines = analyzePhrases(line).phrases.map((ph, i) => sliceLine(line, index.get(ph.noteIds[0]!)!, index.get(ph.noteIds[ph.noteIds.length - 1]!)!, { leading: i === 0 }));
    const slots = lines.map((l) => (l.notes.length >= MIN_NOTES ? measureOnce(l) : null));
    const relations: RelationKind[] = [];
    for (let i = 1; i < slots.length; i++) if (slots[i - 1] && slots[i]) relations.push(relate(slots[i - 1]!, slots[i]!).kind);
    return { id: piece.id, phrases: slots.filter((x): x is PhraseMeasure => x !== null).map(statsOf), relations };
  });
}
