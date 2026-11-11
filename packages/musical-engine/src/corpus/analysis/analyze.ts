/**
 * The analysis entry points. `analyzeMelody` measures one MelodyLine (corpus piece or generated phrase) with
 * the same code either way; `aggregateAnalyses` pools many into corpus-level statistics that keep a reference
 * to the pieces behind every figure. Pure and deterministic: the same input always gives the same JSON.
 */
import { harmonicAnalysis, type HarmonicAnalysis } from "./harmony";
import { melodicAnalysis, type MelodicAnalysis } from "./melodic";
import { melodyFromCorpusPiece, type MelodyLine, type TonalContext } from "./melody";
import { analyzePhrases, type PhraseAnalysis } from "./phrases";
import { rhythmAnalysis, type RhythmAnalysis } from "./rhythm";
import { histogram, mergeHistograms, round, share, summarize, topEntries, type Histogram, type Summary } from "./stats";
import type { CorpusPiece } from "../types";

export const ANALYSIS_VERSION = 1 as const;

export const ANALYSIS_METHODS = [
  { id: "rhythm", version: 1, description: "attack streaks, short runs, duration/rest distributions, metric placement, syncopation (onset weight below the strongest grid point crossed), repeated cells, per-beat density curve, groupings" },
  { id: "melody", version: 1, description: "interval classes (repeat 0, step ≤2, skip ≤4, leap ≥5 semitones), direction runs and changes, contour class, repeated interval/rhythm motifs, transposed sequences, registral trend, gap-fill, melody-with-rhythm relations" },
  { id: "phrases", version: 1, description: "boundary hypotheses by noisy-OR of written structure, rests, long notes, LBDM (Cambouropoulos 2001), bar/hypermeter position, activity change, recurrence and cadence; per-phrase profiles; relations between phrases" },
  { id: "harmony", version: 1, description: "melody against explicit chord symbols only; roles as semitones above the chord root; nothing is inferred when chords are absent" },
] as const;

export interface MelodyAnalysis {
  readonly schema: "nugget-melody-analysis";
  readonly version: typeof ANALYSIS_VERSION;
  readonly source: { readonly id: string; readonly title: string; readonly origin: "corpus" | "generated"; readonly tuning: string; readonly tonal: TonalContext | null; readonly bars: number; readonly notes: number };
  readonly methods: typeof ANALYSIS_METHODS;
  readonly rhythm: RhythmAnalysis;
  readonly melody: MelodicAnalysis;
  readonly phrases: PhraseAnalysis;
  readonly harmony: HarmonicAnalysis;
}

export function analyzeMelody(line: MelodyLine): MelodyAnalysis {
  return {
    schema: "nugget-melody-analysis",
    version: ANALYSIS_VERSION,
    source: { id: line.id, title: line.title, origin: line.origin, tuning: line.tuning, tonal: line.tonal, bars: line.bars.length, notes: line.notes.length },
    methods: ANALYSIS_METHODS,
    rhythm: rhythmAnalysis(line),
    melody: melodicAnalysis(line),
    phrases: analyzePhrases(line),
    harmony: harmonicAnalysis(line),
  };
}

export const analyzeCorpusPiece = (piece: CorpusPiece): MelodyAnalysis => analyzeMelody(melodyFromCorpusPiece(piece));

// ── aggregation ───────────────────────────────────────────────────────────
export interface PieceRow {
  readonly id: string;
  readonly title: string;
  readonly notes: number;
  readonly bars: number;
  readonly phrases: number;
  readonly stepShare: number;
  readonly leapShare: number;
  readonly restTimeShare: number;
  readonly longestShortRun: number;
  readonly syncopationShare: number;
  readonly contour: string;
}

export interface Pooled {
  readonly pieces: number;
  readonly notes: number;
  readonly rhythm: {
    readonly durationShare: Readonly<Record<string, number>>;
    readonly timeShareByDuration: Readonly<Record<string, number>>;
    readonly sustain: { readonly shortShare: number; readonly mediumShare: number; readonly longShare: number; readonly heldShare: number; readonly longTimeShare: number };
    readonly rests: { readonly piecesWithRests: number; readonly meanTimeShare: number; readonly durations: Histogram; readonly byMetricWeight: Histogram };
    readonly shortRuns: { readonly histogram: Histogram; readonly shareOfNotesInRunsOf4Plus: number; readonly shareOfNotesInRunsOf8Plus: number; readonly longestMax: number };
    readonly streaks: { readonly histogram: Histogram; readonly longest: Summary };
    readonly attacksByWeight: Readonly<Record<string, number>>;
    readonly syncopationShare: number;
    readonly notesPerBar: Summary;
    readonly repeatedBarShare: number;
    readonly unevenBeatShare: number;
    /** Rhythmic cells that recur within pieces, by how many pieces contain them. */
    readonly commonCells: readonly { readonly tokens: readonly string[]; readonly pieces: number; readonly occurrences: number; readonly uniform: boolean }[];
    readonly beatPatterns: Histogram;
  };
  readonly melody: {
    readonly intervalHistogram: Histogram;
    readonly intervalClasses: { readonly repeat: number; readonly step: number; readonly skip: number; readonly leap: number };
    readonly meanAbsInterval: Summary;
    readonly spanPerPiece: Summary;
    readonly contourKinds: Histogram;
    readonly directionChangeRate: Summary;
    readonly gapFill: { readonly leaps: number; readonly reversalShare: number };
    readonly commonMotifs: readonly { readonly intervals: readonly number[]; readonly pieces: number }[];
    readonly sequencesPerPiece: Summary;
    readonly joint: { readonly meanIntervalAfterLong: number; readonly meanIntervalAfterShort: number; readonly leapOnStrongShare: number; readonly burstThenHoldShare: number; readonly bursts: number };
  };
  readonly phrases: {
    readonly count: number;
    readonly perPiece: Summary;
    readonly notesPerPhrase: Summary;
    readonly barsPerPhrase: Summary;
    readonly attacksPerBeat: Summary;
    readonly activityShapes: Histogram;
    readonly contourKinds: Histogram;
    readonly opening: { readonly afterRestShare: number; readonly onDownbeatShare: number; readonly pickupShare: number };
    readonly ending: { readonly deceleratesShare: number; readonly followedByRestShare: number; readonly finalBeats: Summary; readonly approach: Histogram; readonly intervalClasses: Histogram; readonly finalWeight: Histogram; readonly shareOfPhrase: Summary };
    readonly relationKinds: Histogram;
    readonly rhythmicVariation: Summary;
    readonly meanBoundaryScore: Summary;
    readonly ambiguousBoundariesPerPiece: Summary;
  };
  readonly harmony: { readonly pieces: number; readonly chordToneShare: number; readonly byStrength: { readonly strong: number; readonly beat: number; readonly weak: number }; readonly nonChordTones: Histogram; readonly changeOnDownbeatShare: number };
}

export interface CorpusAggregate {
  readonly schema: "nugget-corpus-aggregate";
  readonly version: typeof ANALYSIS_VERSION;
  readonly methods: typeof ANALYSIS_METHODS;
  /** The pieces behind every figure. */
  readonly sources: readonly string[];
  readonly pooled: Pooled;
  readonly perPiece: readonly PieceRow[];
}

const mean = (xs: readonly number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export function aggregateAnalyses(items: readonly MelodyAnalysis[]): CorpusAggregate {
  const notes = items.reduce((a, x) => a + x.source.notes, 0);
  const sumBy = (f: (x: MelodyAnalysis) => number) => items.reduce((a, x) => a + f(x), 0);
  const durCount: Record<string, number> = {};
  const durTime: Record<string, number> = {};
  for (const x of items) {
    const n = x.source.notes;
    for (const d of x.rhythm.durations.byValue) {
      durCount[d.duration] = (durCount[d.duration] ?? 0) + d.count;
      durTime[d.duration] = (durTime[d.duration] ?? 0) + d.timeShare * n;
    }
  }
  const norm = (h: Record<string, number>, total: number) => Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([k, v]) => [k, round(v / (total || 1))]));
  const cellMap = new Map<string, { tokens: readonly string[]; pieces: Set<string>; occurrences: number; uniform: boolean }>();
  for (const x of items) for (const c of x.rhythm.cells.repeated) {
    const k = c.tokens.join(" ");
    const e = cellMap.get(k) ?? { tokens: c.tokens, pieces: new Set<string>(), occurrences: 0, uniform: c.uniform };
    e.pieces.add(x.source.id);
    e.occurrences += c.count;
    cellMap.set(k, e);
  }
  const commonCells = [...cellMap.values()].filter((c) => c.pieces.size >= 2).sort((a, b) => b.pieces.size - a.pieces.size || b.occurrences - a.occurrences).slice(0, 12).map((c) => ({ tokens: c.tokens, pieces: c.pieces.size, occurrences: c.occurrences, uniform: c.uniform }));
  const motifMap = new Map<string, { intervals: readonly number[]; pieces: Set<string> }>();
  for (const x of items) for (const m of x.melody.motifs) {
    const k = m.intervals.join(",");
    const e = motifMap.get(k) ?? { intervals: m.intervals, pieces: new Set<string>() };
    e.pieces.add(x.source.id);
    motifMap.set(k, e);
  }
  const commonMotifs = [...motifMap.values()].filter((m) => m.pieces.size >= 2 && !m.intervals.every((v) => v === m.intervals[0])).sort((a, b) => b.pieces.size - a.pieces.size || b.intervals.length - a.intervals.length).slice(0, 12).map((m) => ({ intervals: m.intervals, pieces: m.pieces.size }));

  const allPhrases = items.flatMap((x) => x.phrases.phrases.map((p) => p.profile));
  const harmonic = items.map((x) => x.harmony).filter((h): h is Extract<HarmonicAnalysis, { present: true }> => h.present);
  const totalIv = sumBy((x) => x.melody.intervals.length) || 1;
  const wIv = (key: "repeat" | "step" | "skip" | "leap") => round(sumBy((x) => x.melody.intervalClasses[key] * x.melody.intervals.length) / totalIv);

  const pooled: Pooled = {
    pieces: items.length,
    notes,
    rhythm: {
      durationShare: norm(durCount, notes),
      timeShareByDuration: norm(durTime, notes),
      sustain: {
        shortShare: share(sumBy((x) => x.rhythm.sustain.short), notes),
        mediumShare: share(sumBy((x) => x.rhythm.sustain.medium), notes),
        longShare: share(sumBy((x) => x.rhythm.sustain.long), notes),
        heldShare: share(sumBy((x) => x.rhythm.sustain.held), notes),
        longTimeShare: mean(items.map((x) => x.rhythm.sustain.longTimeShare)),
      },
      rests: {
        piecesWithRests: items.filter((x) => x.rhythm.restCount > 0).length,
        meanTimeShare: mean(items.map((x) => x.rhythm.rests.timeShare)),
        durations: mergeHistograms(items.map((x) => x.rhythm.rests.durations)),
        byMetricWeight: mergeHistograms(items.map((x) => x.rhythm.rests.byMetricWeight)),
      },
      shortRuns: {
        histogram: mergeHistograms(items.map((x) => x.rhythm.shortRuns.histogram)),
        shareOfNotesInRunsOf4Plus: share(sumBy((x) => x.rhythm.shortRuns.shareOfNotesInRunsOf4Plus * x.source.notes), notes),
        shareOfNotesInRunsOf8Plus: share(sumBy((x) => x.rhythm.shortRuns.shareOfNotesInRunsOf8Plus * x.source.notes), notes),
        longestMax: Math.max(0, ...items.map((x) => x.rhythm.shortRuns.longest)),
      },
      streaks: { histogram: mergeHistograms(items.map((x) => x.rhythm.streaks.histogram)), longest: summarize(items.map((x) => x.rhythm.streaks.longest)) },
      attacksByWeight: norm(mergeHistograms(items.map((x) => x.rhythm.metric.attacksByWeight)), notes),
      syncopationShare: share(sumBy((x) => x.rhythm.metric.syncopatedNotes), notes),
      notesPerBar: summarize(items.flatMap((x) => x.rhythm.bars.filter((_, i) => i >= 0).map((b) => b.attacks).filter((a) => a > 0))),
      repeatedBarShare: mean(items.map((x) => x.rhythm.cells.repeatedBarShare)),
      unevenBeatShare: mean(items.map((x) => x.rhythm.groupings.unevenBeatShare)),
      commonCells,
      beatPatterns: Object.fromEntries(topEntries(mergeHistograms(items.map((x) => x.rhythm.groupings.beatPatterns)), 10)),
    },
    melody: {
      intervalHistogram: Object.fromEntries(topEntries(mergeHistograms(items.map((x) => histogram(x.melody.intervals))), 30)),
      intervalClasses: { repeat: wIv("repeat"), step: wIv("step"), skip: wIv("skip"), leap: wIv("leap") },
      meanAbsInterval: summarize(items.map((x) => x.melody.meanAbsInterval)),
      spanPerPiece: summarize(items.map((x) => x.melody.range.span)),
      contourKinds: histogram(items, (x) => x.melody.contour.kind),
      directionChangeRate: summarize(items.map((x) => x.melody.direction.changeRate)),
      gapFill: { leaps: sumBy((x) => x.melody.gapFill.leaps), reversalShare: share(sumBy((x) => x.melody.gapFill.reverseByStep + x.melody.gapFill.reverseByLeap), Math.max(1, sumBy((x) => x.melody.gapFill.reverseByStep + x.melody.gapFill.reverseByLeap + x.melody.gapFill.continues + x.melody.gapFill.repeats))) },
      commonMotifs,
      sequencesPerPiece: summarize(items.map((x) => x.melody.sequences.length)),
      joint: {
        meanIntervalAfterLong: mean(items.map((x) => x.melody.joint.meanIntervalAfterLong)),
        meanIntervalAfterShort: mean(items.map((x) => x.melody.joint.meanIntervalAfterShort)),
        leapOnStrongShare: mean(items.map((x) => x.melody.joint.leapOnStrongShare)),
        burstThenHoldShare: share(sumBy((x) => x.melody.joint.burstThenHold.heldAfter + x.melody.joint.burstThenHold.restAfter), Math.max(1, sumBy((x) => x.melody.joint.burstThenHold.bursts))),
        bursts: sumBy((x) => x.melody.joint.burstThenHold.bursts),
      },
    },
    phrases: {
      count: allPhrases.length,
      perPiece: summarize(items.map((x) => x.phrases.phrases.length)),
      notesPerPhrase: summarize(allPhrases.map((p) => p.noteCount)),
      barsPerPhrase: summarize(allPhrases.map((p) => p.bars)),
      attacksPerBeat: summarize(allPhrases.map((p) => p.attacksPerBeat)),
      activityShapes: histogram(allPhrases, (p) => p.activityShape),
      contourKinds: histogram(allPhrases, (p) => p.contour.kind),
      opening: { afterRestShare: share(allPhrases.filter((p) => p.opening.afterRest).length, allPhrases.length), onDownbeatShare: share(allPhrases.filter((p) => p.opening.firstWeight >= 4).length, allPhrases.length), pickupShare: share(allPhrases.filter((p) => p.opening.pickup).length, allPhrases.length) },
      ending: {
        deceleratesShare: share(allPhrases.filter((p) => p.ending.decelerates).length, allPhrases.length),
        followedByRestShare: share(allPhrases.filter((p) => p.ending.followedByRest).length, allPhrases.length),
        finalBeats: summarize(allPhrases.map((p) => p.ending.finalBeats)),
        approach: histogram(allPhrases, (p) => p.ending.approach),
        intervalClasses: histogram(allPhrases, (p) => String(p.ending.finalIntervalClass)),
        finalWeight: histogram(allPhrases, (p) => String(p.ending.finalWeight)),
        shareOfPhrase: summarize(allPhrases.map((p) => p.ending.shareOfPhrase)),
      },
      relationKinds: histogram(items.flatMap((x) => x.phrases.relations), (r) => r.kind),
      rhythmicVariation: summarize(items.map((x) => x.phrases.rhythmicVariation)),
      meanBoundaryScore: summarize(items.map((x) => x.phrases.uncertainty.meanBoundaryScore)),
      ambiguousBoundariesPerPiece: summarize(items.map((x) => x.phrases.uncertainty.ambiguousBoundaries)),
    },
    harmony: {
      pieces: harmonic.length,
      chordToneShare: share(harmonic.reduce((s, h) => s + h.counts.chordTones, 0), harmonic.reduce((s, h) => s + h.counts.annotated, 0)),
      byStrength: {
        strong: share(harmonic.reduce((s, h) => s + h.counts.strong[0], 0), harmonic.reduce((s, h) => s + h.counts.strong[1], 0)),
        beat: share(harmonic.reduce((s, h) => s + h.counts.beat[0], 0), harmonic.reduce((s, h) => s + h.counts.beat[1], 0)),
        weak: share(harmonic.reduce((s, h) => s + h.counts.weak[0], 0), harmonic.reduce((s, h) => s + h.counts.weak[1], 0)),
      },
      nonChordTones: mergeHistograms(harmonic.map((h) => h.nonChordTones)),
      changeOnDownbeatShare: share(harmonic.reduce((s, h) => s + h.counts.changesOnDownbeat, 0), harmonic.reduce((s, h) => s + h.counts.changes, 0)),
    },
  };
  return {
    schema: "nugget-corpus-aggregate",
    version: ANALYSIS_VERSION,
    methods: ANALYSIS_METHODS,
    sources: items.map((x) => x.source.id),
    pooled,
    perPiece: items.map((x) => ({
      id: x.source.id,
      title: x.source.title,
      notes: x.source.notes,
      bars: x.source.bars,
      phrases: x.phrases.phrases.length,
      stepShare: x.melody.intervalClasses.step,
      leapShare: x.melody.intervalClasses.leap,
      restTimeShare: x.rhythm.rests.timeShare,
      longestShortRun: x.rhythm.shortRuns.longest,
      syncopationShare: x.rhythm.metric.syncopationShare,
      contour: x.melody.contour.kind,
    })),
  };
}
