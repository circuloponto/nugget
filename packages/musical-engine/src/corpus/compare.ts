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
 */
export function sliceLine(line: MelodyLine, from: number, to: number): MelodyLine {
  let a = line.notes[from]!.index;
  let b = line.notes[to]!.index;
  const written = (e: MelodyEvent | undefined) => e?.kind === "rest" && !e.suspect;
  while (a > 0 && written(line.events[a - 1])) a--;
  while (b + 1 < line.events.length && written(line.events[b + 1])) b++;
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
    activity: bins.map((c) => c / n),
    activityShape: profile.activityShape,
    profile,
  };
}

// ── metrics ───────────────────────────────────────────────────────────────
export type MetricGroup = "size" | "rhythm" | "silence" | "melody" | "contour" | "ending" | "diversity";

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

function measureGroups(groups: readonly PhraseGroup[]): { pooled: Record<string, number>; groups: MeasuredGroup[]; dist: Distributions; phrases: number } {
  const measured: MeasuredGroup[] = [];
  for (const g of groups) {
    const phrases = g.lines.filter((l) => l.notes.length >= MIN_NOTES).map(measurePhrase);
    if (phrases.length === 0) continue;
    const m = metricsOf(phrases);
    const d = diversity(phrases);
    if (d) Object.assign(m, { meanPairDistance: d.dist, distinctRhythmShare: d.rhythm, distinctShapeShare: d.shape });
    measured.push({ id: g.id, phrases, metrics: m });
  }
  const all = measured.flatMap((g) => g.phrases);
  const pooled = metricsOf(all);
  for (const key of ["meanPairDistance", "distinctRhythmShare", "distinctShapeShare"]) {
    const vals = measured.map((g) => g.metrics[key]).filter((x): x is number => x !== undefined);
    pooled[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return { pooled, groups: measured, dist: distributionsOf(all), phrases: all.length };
}

const spread = (vals: readonly number[]): [number, number] => {
  const s = [...vals].sort((a, b) => a - b);
  return [round(quantile(s, 0.1)), round(quantile(s, 0.9))];
};

export type Verdict = "within" | "above" | "below";
const verdictOf = (v: number, [lo, hi]: [number, number]): Verdict => (v < lo - 1e-9 ? "below" : v > hi + 1e-9 ? "above" : "within");

export interface MetricRow extends MetricDef {
  readonly generator: number;
  readonly generatorSpread: readonly [number, number];
  readonly corpus: number;
  readonly corpusSpread: readonly [number, number];
  readonly corpusFourFour: number;
  readonly corpusDevelopment: number;
  readonly corpusHeldOut: number;
  /** The generator's pooled value against the spread across individual corpus pieces. */
  readonly verdict: Verdict;
  /** The same, against the 4/4 tunes only. */
  readonly verdictFourFour: Verdict;
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

export interface GeneratorComparison {
  readonly schema: "nugget-generator-comparison";
  readonly version: 1;
  readonly sample: { readonly runs: number; readonly failedRuns: number; readonly phrases: number; readonly keys: readonly string[]; readonly seeds: readonly number[]; readonly meter: "4/4" };
  readonly corpus: { readonly pieces: number; readonly phrases: number; readonly fourFourPieces: number; readonly fourFourPhrases: number; readonly split: CorpusSplit };
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
}

export function compareGenerator(input: CompareInput): GeneratorComparison {
  const { runs, pieces } = input;
  const split = input.split ?? splitCorpus(pieces.map((p) => ({ id: p.id, category: p.provenance.catalog.category ?? "" })));

  // corpus phrases: each piece's phrases at the primary reading, cut out as lines
  const corpusGroups: (PhraseGroup & { fourFour: boolean })[] = pieces.map((piece) => {
    const line = melodyFromCorpusPiece(piece);
    const index = new Map(line.notes.map((n, i) => [n.id, i] as const));
    const lines = analyzePhrases(line).phrases.map((ph) => sliceLine(line, index.get(ph.noteIds[0]!)!, index.get(ph.noteIds[ph.noteIds.length - 1]!)!));
    return { id: piece.id, lines, fourFour: piece.measures.every((m) => m.meter.text === "4/4") };
  });
  const generatorGroups: PhraseGroup[] = runs.filter((r) => r.phrases.length > 0).map((r) => ({ id: `${r.key}-${r.mode}-s${r.seed}`, lines: r.phrases.map((p) => sliceLine(p.line, 0, p.line.notes.length - 1)) }));

  const gen = measureGroups(generatorGroups);
  const cor = measureGroups(corpusGroups);
  const ff = measureGroups(corpusGroups.filter((g) => g.fourFour));
  const dev = measureGroups(corpusGroups.filter((g) => split.development.includes(g.id)));
  const held = measureGroups(corpusGroups.filter((g) => split.heldOut.includes(g.id)));

  const rows: MetricRow[] = METRICS.map((def) => {
    const pieceVals = cor.groups.map((g) => g.metrics[def.id]).filter((x): x is number => x !== undefined);
    const fourVals = ff.groups.map((g) => g.metrics[def.id]).filter((x): x is number => x !== undefined);
    const genVals = gen.groups.map((g) => g.metrics[def.id]).filter((x): x is number => x !== undefined);
    const g = gen.pooled[def.id] ?? 0;
    return {
      ...def,
      generator: round(g),
      generatorSpread: spread(genVals),
      corpus: round(cor.pooled[def.id] ?? 0),
      corpusSpread: spread(pieceVals),
      corpusFourFour: round(ff.pooled[def.id] ?? 0),
      corpusDevelopment: round(dev.pooled[def.id] ?? 0),
      corpusHeldOut: round(held.pooled[def.id] ?? 0),
      verdict: verdictOf(g, spread(pieceVals)),
      verdictFourFour: fourVals.length >= 3 ? verdictOf(g, spread(fourVals)) : "within",
    };
  });

  const genLines = generatorGroups.flatMap((g) => g.lines).filter((l) => l.notes.length >= MIN_NOTES);
  const corLines = corpusGroups.flatMap((g) => g.lines).filter((l) => l.notes.length >= MIN_NOTES);
  const seeds = [...new Set(runs.map((r) => r.seed))].sort((a, b) => a - b);
  return {
    schema: "nugget-generator-comparison",
    version: 1,
    sample: { runs: runs.length, failedRuns: runs.filter((r) => r.phrases.length === 0).length, phrases: gen.phrases, keys: [...new Set(runs.map((r) => r.key))], seeds, meter: "4/4" },
    corpus: { pieces: pieces.length, phrases: cor.phrases, fourFourPieces: corpusGroups.filter((g) => g.fourFour).length, fourFourPhrases: ff.phrases, split },
    rows,
    distributions: { generator: gen.dist, corpus: cor.dist, corpusFourFour: ff.dist },
    examples: {
      generator: evenly(genLines, input.examples ?? 6).map((l) => exampleOf("generator", l, l.id)),
      corpus: evenly(corLines, input.examples ?? 6).map((l) => exampleOf("corpus", l, l.id)),
    },
    caveats: [
      "The corpus is 23 machine-converted Nottingham dance tunes; the generator writes jazz-style lines over a ii–V–I. A difference is not a defect.",
      "Generator phrases are 1–1½ bars and every one is in 4/4; corpus phrases are about 2 bars and mostly compound or triple. Measures are per beat, and the 4/4-only column controls for meter, not for length.",
      "A verdict compares the generator's pooled value with the 10th–90th percentile of individual corpus pieces: it says the value lies outside how much real tunes differ from each other, nothing about quality.",
      "The corpus holds only 2 written rests (the rest of the converted file's rests are converter padding), so it cannot say how much silence is right.",
      "Phrase boundaries in the corpus are hypotheses (see the phrase analysis); the generator's phrases are exactly what it was asked to build.",
      "I have not listened to either side.",
    ],
  };
}
