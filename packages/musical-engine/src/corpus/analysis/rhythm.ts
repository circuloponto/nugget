/**
 * Rhythmic analysis of a MelodyLine. Deliberately NOT a single density number: it reports how attacks are
 * strung together (streaks), where silence and sustain fall, which cells recur, and how activity moves
 * through time, because eight consecutive eighths and a burst-then-hold phrase can share an average density.
 */
import { fnum, fstr, type Fraction } from "../../time/rational";
import type { MelodyBar, MelodyEvent, MelodyLine, MelodyNote } from "./melody";
import { histogram, round, share, summarize, topEntries, type Histogram, type Summary } from "./stats";

export interface BarRhythm {
  readonly bar: number;
  readonly number: string;
  readonly attacks: number;
  /** Bar length in beats. */
  readonly beats: number;
  /** Attacks per beat. */
  readonly density: number;
  readonly restBeats: number;
  /** Notes at least one beat long that start in the bar. */
  readonly sustained: number;
  /** Onsets in beats from the start of the bar's beat grid. */
  readonly onsets: readonly number[];
  /** Attack counts per beat, e.g. [2,1,2] ("2-1-2"). */
  readonly perBeat: readonly number[];
}

export interface RhythmCell {
  readonly tokens: readonly string[];
  readonly length: number;
  readonly count: number;
  /** Every token identical (e.g. a run of eighths). */
  readonly uniform: boolean;
  readonly starts: readonly string[];
}

export interface RhythmAnalysis {
  readonly noteCount: number;
  /** Written rests only: rests flagged as converter padding are not silence the composer wrote. */
  readonly restCount: number;
  /** Rests flagged as suspected converter padding; they occupy time but are excluded from every silence statistic. */
  readonly suspectRests: number;
  readonly bars: readonly BarRhythm[];
  readonly notesPerBar: Summary;
  /** Streaks of notes with no rest between them (each starts where the last ended). */
  readonly streaks: { readonly lengths: readonly number[]; readonly longest: number; readonly histogram: Histogram };
  /** Runs of consecutive SHORT notes (no longer than half a beat), contiguous in time. Runs of one are not runs. */
  readonly shortRuns: { readonly lengths: readonly number[]; readonly longest: number; readonly shareOfNotesInRunsOf4Plus: number; readonly shareOfNotesInRunsOf8Plus: number; readonly histogram: Histogram };
  readonly durations: { readonly byValue: readonly { readonly duration: string; readonly beats: number; readonly count: number; readonly share: number; readonly timeShare: number }[]; readonly distinct: number };
  /** short ≤ ½ beat, medium between, long ≥ 1 beat, held ≥ 2 beats. */
  readonly sustain: { readonly short: number; readonly medium: number; readonly long: number; readonly held: number; readonly longToShort: number; readonly longTimeShare: number };
  readonly rests: { readonly count: number; readonly totalBeats: number; readonly timeShare: number; readonly durations: Histogram; readonly byMetricWeight: Histogram; readonly startsPiece: boolean };
  readonly metric: { readonly attacksByWeight: Histogram; readonly offbeatShare: number; readonly syncopatedNotes: number; readonly syncopationShare: number };
  readonly cells: { readonly repeated: readonly RhythmCell[]; readonly distinctBarRhythms: number; readonly repeatedBarShare: number };
  /** Attacks in each beat-long window of the piece, in order. */
  readonly densityCurve: readonly number[];
  readonly groupings: { readonly unevenBeatShare: number; readonly beatPatterns: Histogram; readonly asymmetricBarShare: number; readonly iotPatterns: Histogram };
}

const EPS = 1e-9;
const beatsOf = (f: Fraction, bar: MelodyBar): number => round(fnum(f) / fnum(bar.beat), 6);

/** Tokens for a rhythm: note durations as exact fractions, rests prefixed with "r". */
export const rhythmTokens = (events: readonly MelodyEvent[]): string[] => events.map((e) => (e.kind === "rest" ? `r${fstr(e.duration)}` : fstr(e.duration)));

export function rhythmAnalysis(line: MelodyLine): RhythmAnalysis {
  const { events, notes, bars } = line;
  const allRests = events.filter((e) => e.kind === "rest");
  const rests = allRests.filter((e) => e.kind === "rest" && !e.suspect);
  const totalLen = fnum(line.length) || 1;

  // ── per bar ───────────────────────────────────────────────────────────
  const barRows: BarRhythm[] = bars.map((bar) => {
    const inBar = events.filter((e) => e.bar === bar.index);
    const ns = inBar.filter((e): e is MelodyNote => e.kind === "note");
    const beats = round(fnum(bar.length) / fnum(bar.beat), 4);
    const startBeats = fnum(bar.startPhase) / fnum(bar.beat);
    const onsets = ns.map((n) => round(fnum(n.phase) / fnum(bar.beat), 4));
    const nBeatSlots = Math.max(1, Math.ceil(startBeats + beats - EPS));
    const perBeat = new Array<number>(nBeatSlots).fill(0);
    for (const o of onsets) perBeat[Math.min(nBeatSlots - 1, Math.floor(o + EPS))]!++;
    return {
      bar: bar.index,
      number: bar.number,
      attacks: ns.length,
      beats,
      density: beats === 0 ? 0 : round(ns.length / beats),
      restBeats: round(inBar.filter((e) => e.kind === "rest" && !e.suspect).reduce((a, e) => a + fnum(e.duration) / fnum(bar.beat), 0)),
      sustained: ns.filter((n) => fnum(n.duration) / fnum(bar.beat) >= 1 - EPS).length,
      onsets,
      perBeat: bar.pickup ? perBeat.slice(Math.floor(startBeats + EPS)) : perBeat,
    };
  });
  const fullBars = barRows.filter((_, i) => !bars[i]!.pickup);

  // ── streaks and short runs ────────────────────────────────────────────
  const streaks: number[] = [];
  let cur = 0;
  for (const e of events) {
    if (e.kind === "note") cur++;
    else {
      if (cur) streaks.push(cur);
      cur = 0;
    }
  }
  if (cur) streaks.push(cur);

  const isShort = (n: MelodyNote) => fnum(n.duration) <= fnum(bars[n.bar]!.beat) / 2 + EPS;
  const shortRuns: number[] = [];
  let run = 0;
  let prev: MelodyNote | null = null;
  for (const n of notes) {
    const contiguous = prev !== null && fnum(prev.end) === fnum(n.onset);
    if (isShort(n) && (run === 0 || contiguous)) run++;
    else {
      if (run >= 2) shortRuns.push(run);
      run = isShort(n) ? 1 : 0;
    }
    prev = n;
  }
  if (run >= 2) shortRuns.push(run);
  const inRuns = (min: number) => shortRuns.filter((r) => r >= min).reduce((a, b) => a + b, 0);

  // ── durations ─────────────────────────────────────────────────────────
  const byDur = new Map<string, { beats: number; count: number; time: number }>();
  for (const n of notes) {
    const k = fstr(n.duration);
    const row = byDur.get(k) ?? { beats: beatsOf(n.duration, bars[n.bar]!), count: 0, time: 0 };
    row.count++;
    row.time += fnum(n.duration);
    byDur.set(k, row);
  }
  const noteTime = notes.reduce((a, n) => a + fnum(n.duration), 0) || 1;
  const byValue = [...byDur.entries()]
    .map(([duration, r]) => ({ duration, beats: r.beats, count: r.count, share: share(r.count, notes.length), timeShare: round(r.time / noteTime) }))
    .sort((a, b) => b.count - a.count || (a.duration < b.duration ? -1 : 1));

  const beatLen = (n: MelodyEvent) => fnum(n.duration) / fnum(bars[n.bar]!.beat);
  const shortN = notes.filter((n) => beatLen(n) <= 0.5 + EPS).length;
  const longN = notes.filter((n) => beatLen(n) >= 1 - EPS).length;
  const heldN = notes.filter((n) => beatLen(n) >= 2 - EPS).length;
  const longTime = notes.filter((n) => beatLen(n) >= 1 - EPS).reduce((a, n) => a + fnum(n.duration), 0);

  // ── rests ─────────────────────────────────────────────────────────────
  const restBeatsTotal = rests.reduce((a, r) => a + beatLen(r), 0);
  const restTime = rests.reduce((a, r) => a + fnum(r.duration), 0);

  // ── metric placement and syncopation ──────────────────────────────────
  const offbeat = notes.filter((n) => n.weight <= 1).length;
  let syncopated = 0;
  for (const n of notes) {
    const bar = bars[n.bar]!;
    const unit = 1 / bar.meter.beatType;
    const step = unit / 2;
    const start = fnum(n.phase);
    const end = start + fnum(n.duration);
    let crossed = -1;
    for (let p = Math.floor(start / step + EPS) * step + step; p < end - EPS; p += step) {
      const barLen = bar.meter.beats / bar.meter.beatType;
      const inBarPos = p % barLen;
      const wPos = Math.abs(inBarPos) < EPS || Math.abs(inBarPos - barLen) < EPS ? 4 : weightAt(inBarPos, bar);
      crossed = Math.max(crossed, wPos);
    }
    if (crossed > n.weight) syncopated++;
  }

  // ── cells ─────────────────────────────────────────────────────────────
  const toks = rhythmTokens(events);
  const found: RhythmCell[] = [];
  for (let n = 2; n <= 6; n++) {
    const where = new Map<string, number[]>();
    for (let i = 0; i + n <= toks.length; i++) {
      const key = toks.slice(i, i + n).join(" ");
      where.set(key, [...(where.get(key) ?? []), i]);
    }
    for (const [key, starts] of where) {
      const kept: number[] = [];
      for (const s of starts) if (kept.length === 0 || s >= kept[kept.length - 1]! + n) kept.push(s);
      if (kept.length < 2) continue;
      const tokens = key.split(" ");
      found.push({ tokens, length: n, count: kept.length, uniform: tokens.every((t) => t === tokens[0]), starts: kept.map((s) => events[s]!.id) });
    }
  }
  // keep the most informative: longest and most frequent, dropping cells wholly inside a longer, equally frequent one
  found.sort((a, b) => b.length * b.count - a.length * a.count || (a.tokens.join() < b.tokens.join() ? -1 : 1));
  const repeated: RhythmCell[] = [];
  for (const c of found) {
    if (repeated.length >= 12) break;
    if (repeated.some((r) => r.count === c.count && r.tokens.join(" ").includes(c.tokens.join(" ")))) continue;
    repeated.push(c);
  }
  const barSigs = bars.map((b) => events.filter((e) => e.bar === b.index).map((e) => `${e.kind === "rest" ? "r" : ""}${fstr(e.phase)}:${fstr(e.duration)}`).join(" "));
  const seen = new Set<string>();
  let repeatBars = 0;
  barSigs.forEach((s, i) => {
    if (bars[i]!.pickup) return;
    if (seen.has(s)) repeatBars++;
    seen.add(s);
  });

  // ── density curve: attacks per beat-long window ───────────────────────
  const curve: number[] = [];
  for (const b of bars) {
    const startBeat = fnum(b.startPhase) / fnum(b.beat);
    const len = fnum(b.length) / fnum(b.beat);
    const slots = Math.max(1, Math.ceil(len - EPS));
    const counts = new Array<number>(slots).fill(0);
    for (const n of notes) {
      if (n.bar !== b.index) continue;
      const pos = fnum(n.phase) / fnum(b.beat) - startBeat;
      counts[Math.min(slots - 1, Math.max(0, Math.floor(pos + EPS)))]!++;
    }
    curve.push(...counts);
  }

  // ── groupings ─────────────────────────────────────────────────────────
  const beatPatterns = histogram(fullBars.filter((r) => r.attacks > 0), (r) => r.perBeat.join("-"));
  const uneven = fullBars.filter((r) => r.attacks > 0 && new Set(r.perBeat).size > 1).length;
  const iotPatterns: Histogram = {};
  let asym = 0;
  let asymBase = 0;
  for (const b of bars) {
    if (b.pickup) continue;
    const ns = notes.filter((n) => n.bar === b.index);
    if (ns.length < 3) continue;
    asymBase++;
    // each note's inter-onset interval runs to the NEXT attack, even across the barline, so a 3+3+2 bar is seen whole
    const iois = ns.map((n) => {
      const next = notes[notes.indexOf(n) + 1];
      return round(((next ? fnum(next.onset) : fnum(n.end)) - fnum(n.onset)) * 8, 3);
    });
    const key = iois.join("-");
    iotPatterns[key] = (iotPatterns[key] ?? 0) + 1;
    const big = new Set(iois.filter((x) => x >= 2 && Number.isInteger(x)));
    if (big.size >= 2) asym++;
  }

  return {
    noteCount: notes.length,
    restCount: rests.length,
    suspectRests: allRests.length - rests.length,
    bars: barRows,
    notesPerBar: summarize(fullBars.map((r) => r.attacks)),
    streaks: { lengths: streaks, longest: Math.max(0, ...streaks), histogram: histogram(streaks) },
    shortRuns: { lengths: shortRuns, longest: Math.max(0, ...shortRuns), shareOfNotesInRunsOf4Plus: share(inRuns(4), notes.length), shareOfNotesInRunsOf8Plus: share(inRuns(8), notes.length), histogram: histogram(shortRuns) },
    durations: { byValue: byValue.slice(0, 16), distinct: byValue.length },
    sustain: { short: shortN, medium: notes.length - shortN - longN, long: longN, held: heldN, longToShort: shortN === 0 ? 0 : round(longN / shortN), longTimeShare: round(longTime / noteTime) },
    rests: {
      count: rests.length,
      totalBeats: round(restBeatsTotal),
      timeShare: round(restTime / totalLen),
      durations: histogram(rests, (r) => fstr(r.duration)),
      byMetricWeight: histogram(rests, (r) => String(r.kind === "rest" ? r.weight : 0)),
      startsPiece: events[0]?.kind === "rest" && !events[0].suspect,
    },
    metric: { attacksByWeight: histogram(notes, (n) => String(n.weight)), offbeatShare: share(offbeat, notes.length), syncopatedNotes: syncopated, syncopationShare: share(syncopated, notes.length) },
    cells: { repeated, distinctBarRhythms: new Set(barSigs.filter((_, i) => !bars[i]!.pickup)).size, repeatedBarShare: share(repeatBars, Math.max(1, bars.filter((b) => !b.pickup).length)) },
    densityCurve: curve,
    groupings: { unevenBeatShare: share(uneven, Math.max(1, fullBars.filter((r) => r.attacks > 0).length)), beatPatterns: Object.fromEntries(topEntries(beatPatterns, 8)), asymmetricBarShare: share(asym, Math.max(1, asymBase)), iotPatterns: Object.fromEntries(topEntries(iotPatterns, 8)) },
  };
}

/** Metric weight of an in-bar position given as a whole-note number (float), for a bar's meter. */
function weightAt(pos: number, bar: MelodyBar): number {
  const unit = 1 / bar.meter.beatType;
  const compound = bar.meter.beats > 3 && bar.meter.beats % 3 === 0 && bar.meter.beatType >= 8;
  const group = unit * (compound ? 3 : bar.meter.beats === 4 ? 2 : 1);
  const on = (s: number) => Math.abs(pos / s - Math.round(pos / s)) < 1e-9;
  if (on(group)) return 3;
  if (on(unit)) return compound ? 1 : 2;
  if (on(unit / 2)) return compound ? 0 : 1;
  return 0;
}
