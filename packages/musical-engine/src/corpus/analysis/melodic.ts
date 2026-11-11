/**
 * Melodic analysis of a MelodyLine, and of melody together with rhythm.
 *
 * Interval classes are defined on distances in (possibly fractional) semitones and make no assumption
 * about scale or tuning: repeat 0, step ≤ 2, skip ≤ 4, leap ≥ 5 (reported separately from ≥ 8).
 * Scale-degree statistics are produced only when a tonal context exists and the tuning is 12-tone.
 */
import { fnum, fstr } from "../../time/rational";
import { MODE_SCALES, type MelodyLine, type MelodyNote } from "./melody";
import { correlation, histogram, round, share, slope, summarize, topEntries, type Histogram, type Summary } from "./stats";

export type IntervalClass = "repeat" | "step" | "skip" | "leap";
export const intervalClass = (semitones: number): IntervalClass => {
  const a = Math.abs(semitones);
  return a === 0 ? "repeat" : a <= 2 ? "step" : a <= 4 ? "skip" : "leap";
};

export type ContourKind = "ascending" | "descending" | "arch" | "valley" | "level";

/** Same classes and thresholds as the generator's own contour classifier, on plain MIDI numbers. */
export function contourClassOfMidi(ms: readonly number[]): ContourKind {
  if (ms.length < 2) return "level";
  const first = ms[0]!;
  const last = ms[ms.length - 1]!;
  const hi = Math.max(...ms);
  const lo = Math.min(...ms);
  const hiIdx = ms.indexOf(hi);
  const loIdx = ms.indexOf(lo);
  const interior = (i: number) => i > 0 && i < ms.length - 1;
  if (interior(hiIdx) && hi - Math.max(first, last) >= 2) return "arch";
  if (interior(loIdx) && Math.min(first, last) - lo >= 2) return "valley";
  const net = last - first;
  return net >= 3 ? "ascending" : net <= -3 ? "descending" : "level";
}
export const contourShapeOfMidi = (ms: readonly number[]): string => ms.slice(1).map((m, i) => (m > ms[i]! ? "u" : m < ms[i]! ? "d" : "l")).join("");
export const intervalsOfMidi = (ms: readonly number[]): number[] => ms.slice(1).map((m, i) => round(m - ms[i]!, 3));

export interface MotifFinding {
  readonly intervals: readonly number[];
  /** Duration tokens of the motif's notes, when the finding is rhythm-aware. */
  readonly rhythm?: readonly string[];
  readonly count: number;
  /** Id of the first note of each statement. */
  readonly starts: readonly string[];
  /** All intervals equal (a repeated pitch or a scale run), so recurrence is cheap. */
  readonly uniform: boolean;
}
export interface SequenceFinding {
  readonly start: string;
  /** Notes per unit. */
  readonly unitLength: number;
  /** Semitone shift from one unit to the next. */
  readonly shift: number;
  /** How many units in the chain (≥ 2). */
  readonly units: number;
  /** The units also share their rhythm. */
  readonly rhythmMatch: boolean;
}

export interface MelodicAnalysis {
  readonly noteCount: number;
  readonly intervals: readonly number[];
  readonly intervalHistogram: Histogram;
  readonly intervalClasses: { readonly repeat: number; readonly step: number; readonly skip: number; readonly leap: number; readonly largeLeap: number };
  readonly meanAbsInterval: number;
  readonly range: { readonly lowest: number; readonly highest: number; readonly span: number; readonly mean: number };
  readonly direction: { readonly up: number; readonly down: number; readonly level: number; readonly changes: number; readonly changeRate: number; readonly runLengths: Histogram };
  readonly contour: { readonly kind: ContourKind; readonly shape: string; readonly turningPoints: number };
  readonly motifs: readonly MotifFinding[];
  readonly rhythmicMotifs: readonly MotifFinding[];
  readonly sequences: readonly SequenceFinding[];
  readonly registral: { readonly barMean: readonly number[]; readonly barRange: readonly number[]; readonly meanBarRange: Summary; readonly rangeTrend: number; readonly pitchTrend: number };
  readonly gapFill: { readonly leaps: number; readonly reverseByStep: number; readonly reverseByLeap: number; readonly continues: number; readonly repeats: number; readonly reversalShare: number };
  readonly tonal: null | { readonly source: string; readonly confidence: number; readonly degreeHistogram: Histogram; readonly inScaleShare: number | null; readonly finalDegree: number; readonly longNoteTonicShare: number };
  /** Melody and rhythm together. */
  readonly joint: {
    readonly meanIntervalAfterLong: number;
    readonly meanIntervalAfterShort: number;
    readonly durationIntervalCorrelation: number;
    readonly leapArrivalByWeight: Histogram;
    readonly stepArrivalByWeight: Histogram;
    readonly leapOnStrongShare: number;
    readonly meanBeatsAfterLeap: number;
    readonly meanBeatsAfterStep: number;
    /** Runs of ≥3 short notes that end on a note of at least a beat (burst, then hold). */
    readonly burstThenHold: { readonly bursts: number; readonly heldAfter: number; readonly restAfter: number; readonly share: number };
  };
}

const EPS = 1e-9;

/** Non-overlapping repeated n-grams of a key sequence, most informative first (longest × most frequent). */
function repeatedGrams<V>(keys: readonly string[], minLen: number, maxLen: number, build: (starts: number[], len: number, key: string) => V, limit = 10): V[] {
  const found: { value: V; score: number; key: string; count: number }[] = [];
  for (let n = minLen; n <= maxLen; n++) {
    const where = new Map<string, number[]>();
    for (let i = 0; i + n <= keys.length; i++) {
      const k = keys.slice(i, i + n).join(",");
      where.set(k, [...(where.get(k) ?? []), i]);
    }
    for (const [k, starts] of where) {
      const kept: number[] = [];
      for (const s of starts) if (kept.length === 0 || s >= kept[kept.length - 1]! + n) kept.push(s);
      if (kept.length >= 2) found.push({ value: build(kept, n, k), score: n * kept.length, key: k, count: kept.length });
    }
  }
  found.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  const out: typeof found = [];
  for (const f of found) {
    if (out.length >= limit) break;
    if (out.some((o) => o.count === f.count && o.key.includes(f.key))) continue;
    out.push(f);
  }
  return out.map((f) => f.value);
}

export function melodicAnalysis(line: MelodyLine): MelodicAnalysis {
  const notes = line.notes;
  const ms = notes.map((n) => n.midi);
  const ivs = intervalsOfMidi(ms);
  const beatsOf = (n: MelodyNote) => fnum(n.duration) / fnum(line.bars[n.bar]!.beat);

  const classes = ivs.map(intervalClass);
  const count = (c: IntervalClass) => classes.filter((x) => x === c).length;
  const nz = ivs.filter((x) => x !== 0);
  let changes = 0;
  for (let i = 1; i < nz.length; i++) if (Math.sign(nz[i]!) !== Math.sign(nz[i - 1]!)) changes++;
  const runLengths: number[] = [];
  let run = 0;
  let dir = 0;
  for (const x of ivs) {
    const s = Math.sign(x);
    if (s !== 0 && s === dir) run++;
    else {
      if (run) runLengths.push(run);
      run = s === 0 ? 0 : 1;
      dir = s;
    }
  }
  if (run) runLengths.push(run);
  let turning = 0;
  {
    let last = 0;
    for (const x of ivs) {
      const s = Math.sign(x);
      if (s === 0) continue;
      if (last !== 0 && s !== last) turning++;
      last = s;
    }
  }

  // ── motifs: recurring interval patterns, with and without rhythm ──────
  const startsOf = (starts: number[]) => starts.map((s) => notes[s]!.id);
  const ivKeys = ivs.map(String);
  const motifs = repeatedGrams<MotifFinding>(ivKeys, 3, 7, (starts, _len, key) => {
    const intervals = key.split(",").map(Number);
    return { intervals, count: starts.length, starts: startsOf(starts), uniform: intervals.every((x) => x === intervals[0]) };
  });
  const durTok = notes.map((n) => fstr(n.duration));
  const comboKeys = ivs.map((x, i) => `${x}@${durTok[i]}/${durTok[i + 1]}`);
  const rhythmicMotifs = repeatedGrams<MotifFinding>(comboKeys, 3, 7, (starts, len, key) => {
    const intervals = key.split(",").map((t) => Number(t.split("@")[0]));
    const s0 = starts[0]!;
    const rhythm = notes.slice(s0, s0 + len + 1).map((n) => fstr(n.duration));
    return { intervals, rhythm, count: starts.length, starts: startsOf(starts), uniform: intervals.every((x) => x === intervals[0]) };
  });

  // ── transposed sequences: a unit of n notes followed by the same shape, shifted ──
  const sequences: SequenceFinding[] = [];
  for (let n = 3; n <= 5; n++) {
    let i = 0;
    while (i + 2 * n <= notes.length) {
      const shapeA = ivs.slice(i, i + n - 1);
      const shapeB = ivs.slice(i + n, i + 2 * n - 1);
      const shift = round(ms[i + n]! - ms[i]!, 3);
      if (shift !== 0 && shapeA.some((x) => x !== 0) && shapeA.every((x, k) => x === shapeB[k])) {
        let units = 2;
        while (i + (units + 1) * n <= notes.length && ivs.slice(i + units * n, i + (units + 1) * n - 1).every((x, k) => x === shapeA[k]) && round(ms[i + units * n]! - ms[i + (units - 1) * n]!, 3) === shift) units++;
        const rhythmMatch = Array.from({ length: n }, (_, k) => durTok[i + k] === durTok[i + n + k]).every(Boolean);
        sequences.push({ start: notes[i]!.id, unitLength: n, shift, units, rhythmMatch });
        i += units * n;
      } else i++;
    }
  }

  // ── registral movement per bar ────────────────────────────────────────
  const barMean: number[] = [];
  const barRange: number[] = [];
  for (const b of line.bars) {
    const inBar = notes.filter((n) => n.bar === b.index);
    if (inBar.length === 0) continue;
    const m = inBar.map((n) => n.midi);
    barMean.push(round(m.reduce((a, c) => a + c, 0) / m.length, 2));
    barRange.push(Math.max(...m) - Math.min(...m));
  }

  // ── gap-fill ──────────────────────────────────────────────────────────
  let rs = 0;
  let rl = 0;
  let cont = 0;
  let rep = 0;
  let leaps = 0;
  for (let i = 0; i + 1 < ivs.length; i++) {
    if (intervalClass(ivs[i]!) !== "leap") continue;
    leaps++;
    const a = ivs[i]!;
    const b = ivs[i + 1]!;
    if (b === 0) rep++;
    else if (Math.sign(a) === Math.sign(b)) cont++;
    else if (Math.abs(b) <= 2) rs++;
    else rl++;
  }

  // ── tonal context ─────────────────────────────────────────────────────
  let tonal: MelodicAnalysis["tonal"] = null;
  if (line.tonal && line.tuning === "12-tet" && notes.length) {
    const rel = (m: number) => (((Math.round(m) - line.tonal!.tonicPc) % 12) + 12) % 12;
    const scale = line.tonal.mode ? MODE_SCALES[line.tonal.mode] : undefined;
    const long = notes.filter((n) => beatsOf(n) >= 1 - EPS);
    tonal = {
      source: line.tonal.source,
      confidence: line.tonal.confidence,
      degreeHistogram: histogram(notes, (n) => String(rel(n.midi))),
      inScaleShare: scale ? share(notes.filter((n) => scale.includes(rel(n.midi))).length, notes.length) : null,
      finalDegree: rel(notes[notes.length - 1]!.midi),
      longNoteTonicShare: share(long.filter((n) => rel(n.midi) === 0).length, long.length),
    };
  }

  // ── melody with rhythm ────────────────────────────────────────────────
  const leaving = (n: MelodyNote, i: number) => (i < ivs.length ? Math.abs(ivs[i]!) : null);
  const afterLong: number[] = [];
  const afterShort: number[] = [];
  const durs: number[] = [];
  const nextAbs: number[] = [];
  notes.forEach((n, i) => {
    const out = leaving(n, i);
    if (out === null) return;
    (beatsOf(n) >= 1 - EPS ? afterLong : afterShort).push(out);
    durs.push(beatsOf(n));
    nextAbs.push(out);
  });
  const leapArrival: Histogram = {};
  const stepArrival: Histogram = {};
  const beatsAfterLeap: number[] = [];
  const beatsAfterStep: number[] = [];
  let leapStrong = 0;
  ivs.forEach((x, i) => {
    const arrive = notes[i + 1]!;
    const c = intervalClass(x);
    if (c === "leap") {
      leapArrival[String(arrive.weight)] = (leapArrival[String(arrive.weight)] ?? 0) + 1;
      if (arrive.weight >= 3) leapStrong++;
      beatsAfterLeap.push(beatsOf(arrive));
    } else if (c === "step") {
      stepArrival[String(arrive.weight)] = (stepArrival[String(arrive.weight)] ?? 0) + 1;
      beatsAfterStep.push(beatsOf(arrive));
    }
  });
  // a gap only counts as a rest if the score writes one: converter padding is not silence
  const writtenRestBetween = (x: MelodyNote, y: MelodyNote) => line.events.slice(x.index + 1, y.index).some((e) => e.kind === "rest" && !e.suspect);
  // bursts: contiguous runs of >= 3 short notes, then what follows
  let bursts = 0;
  let held = 0;
  let restAfter = 0;
  {
    let i = 0;
    while (i < notes.length) {
      if (beatsOf(notes[i]!) > 0.5 + EPS) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < notes.length && beatsOf(notes[j + 1]!) <= 0.5 + EPS && fnum(notes[j]!.end) === fnum(notes[j + 1]!.onset)) j++;
      if (j - i + 1 >= 3) {
        bursts++;
        const next = notes[j + 1];
        if (next && fnum(notes[j]!.end) === fnum(next.onset) && beatsOf(next) >= 1 - EPS) held++;
        else if (next && fnum(notes[j]!.end) < fnum(next.onset) && writtenRestBetween(notes[j]!, next)) restAfter++;
      }
      i = j + 1;
    }
  }
  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

  return {
    noteCount: notes.length,
    intervals: ivs,
    intervalHistogram: Object.fromEntries(topEntries(histogram(ivs), 40)),
    intervalClasses: { repeat: share(count("repeat"), ivs.length), step: share(count("step"), ivs.length), skip: share(count("skip"), ivs.length), leap: share(count("leap"), ivs.length), largeLeap: share(ivs.filter((x) => Math.abs(x) >= 8).length, ivs.length) },
    meanAbsInterval: mean(ivs.map(Math.abs)),
    range: { lowest: Math.min(...ms), highest: Math.max(...ms), span: ms.length ? Math.max(...ms) - Math.min(...ms) : 0, mean: mean(ms) },
    direction: { up: ivs.filter((x) => x > 0).length, down: ivs.filter((x) => x < 0).length, level: ivs.filter((x) => x === 0).length, changes, changeRate: share(changes, Math.max(1, notes.length)), runLengths: histogram(runLengths) },
    contour: { kind: contourClassOfMidi(ms), shape: contourShapeOfMidi(ms), turningPoints: turning },
    motifs,
    rhythmicMotifs,
    sequences,
    registral: { barMean, barRange, meanBarRange: summarize(barRange), rangeTrend: slope(barRange), pitchTrend: slope(barMean) },
    gapFill: { leaps, reverseByStep: rs, reverseByLeap: rl, continues: cont, repeats: rep, reversalShare: share(rs + rl, Math.max(1, rs + rl + cont + rep)) },
    tonal,
    joint: {
      meanIntervalAfterLong: mean(afterLong),
      meanIntervalAfterShort: mean(afterShort),
      durationIntervalCorrelation: correlation(durs, nextAbs),
      leapArrivalByWeight: leapArrival,
      stepArrivalByWeight: stepArrival,
      leapOnStrongShare: share(leapStrong, Math.max(1, Object.values(leapArrival).reduce((a, b) => a + b, 0))),
      meanBeatsAfterLeap: mean(beatsAfterLeap),
      meanBeatsAfterStep: mean(beatsAfterStep),
      burstThenHold: { bursts, heldAfter: held, restAfter, share: share(held + restAfter, Math.max(1, bursts)) },
    },
  };
}
