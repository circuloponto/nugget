/**
 * Phrase analysis: boundary HYPOTHESES with evidence, and a profile of every hypothesised phrase.
 *
 * A boundary candidate sits in the gap after each note. Eight kinds of evidence are scored 0..1 and combined
 * with a noisy-OR (so no single cue decides, and several weak cues can add up):
 *   written   a notated repeat, volta ending, fermata or slur end (observed in the score)
 *   rest      a written rest between the notes
 *   long-note a note held much longer than its neighbours
 *   lbdm      Local Boundary Detection Model (Cambouropoulos 2001): jumps in pitch interval, inter-onset interval and rest
 *   bar       the note ends a bar, a 2-bar or a 4-bar unit
 *   activity  the attack density changes across the gap
 *   recurrence the music after the gap restates earlier music (or the music before it does)
 *   cadence   a tonic/chord-root arrival on a strong or long note (only with a tonal context)
 *
 * Boundaries are never facts. The result names every candidate with its score, the evidence behind it, and
 * keeps coarser and finer segmentations alongside the chosen one.
 */
import { fadd, fnum, fstr, type Fraction } from "../../time/rational";
import type { MelodyBar, MelodyLine, MelodyNote } from "./melody";
import { contourClassOfMidi, contourShapeOfMidi, intervalClass, intervalsOfMidi, type ContourKind } from "./melodic";
import { jaccard, round } from "./stats";

export type EvidenceKind = "written" | "rest" | "long-note" | "lbdm" | "bar" | "activity" | "recurrence" | "cadence";
export const EVIDENCE_WEIGHTS: Readonly<Record<EvidenceKind, number>> = { written: 0.85, rest: 0.6, "long-note": 0.3, lbdm: 0.45, bar: 0.45, activity: 0.15, recurrence: 0.25, cadence: 0.3 };

/** Each level has a score threshold and a minimum length in bars: figures (≥1 bar), phrases (≥2, the primary reading), periods (≥4). */
export const PHRASE_LEVELS = {
  figure: { threshold: 0.3, minBars: 1 },
  phrase: { threshold: 0.45, minBars: 2 },
  period: { threshold: 0.65, minBars: 4 },
} as const;
export const PHRASE_THRESHOLDS = { coarse: PHRASE_LEVELS.period.threshold, primary: PHRASE_LEVELS.phrase.threshold, fine: PHRASE_LEVELS.figure.threshold, floor: 0.15 } as const;
const EPS = 1e-9;

export interface Evidence {
  readonly kind: EvidenceKind;
  /** 0..1 strength of the cue itself. */
  readonly strength: number;
  readonly detail: string;
}
export interface BoundaryHypothesis {
  /** The note before the gap. */
  readonly afterNote: string;
  readonly index: number;
  /** Where the next material starts (exact). */
  readonly at: string;
  readonly bar: number;
  readonly score: number;
  readonly evidence: readonly Evidence[];
  /** How many different kinds of evidence agree. */
  readonly independentKinds: number;
  readonly level: "firm" | "likely" | "possible";
  /** Chosen at the primary threshold after suppressing neighbours. */
  readonly selected: boolean;
}

export type ActivityShape = "even" | "rising" | "falling" | "arch" | "valley" | "burst-hold";

export interface PhraseProfile {
  readonly noteCount: number;
  readonly beats: number;
  readonly bars: number;
  readonly attacksPerBeat: number;
  /** Attacks in each third of the phrase's time. */
  readonly activityThirds: readonly [number, number, number];
  readonly activityShape: ActivityShape;
  readonly contour: { readonly kind: ContourKind; readonly shape: string };
  readonly range: { readonly lowest: number; readonly highest: number; readonly span: number; readonly mean: number };
  readonly opening: { readonly firstWeight: number; readonly afterRest: boolean; readonly pickup: boolean };
  readonly ending: {
    readonly finalBeats: number;
    readonly finalWeight: number;
    readonly finalInterval: number | null;
    readonly finalIntervalClass: string | null;
    readonly approach: "up" | "down" | "level" | "none";
    /** The last note is at least 1.5× the phrase's mean note length, and a beat or more. */
    readonly decelerates: boolean;
    readonly followedByRest: boolean;
    readonly shareOfPhrase: number;
  };
  readonly rhythm: readonly string[];
  readonly intervals: readonly number[];
}

export interface PhraseHypothesis {
  readonly id: string;
  readonly noteIds: readonly string[];
  readonly startBar: number;
  readonly endBar: number;
  /** Product of the confidence in its two edges (the piece's own start and end are observed, confidence 1). */
  readonly confidence: number;
  readonly profile: PhraseProfile;
}

export type PhraseRelationKind = "exact-repeat" | "repeat-modified-ending" | "same-rhythm-new-pitches" | "same-contour-new-rhythm" | "contrast";
export interface PhraseRelation {
  readonly from: string;
  readonly to: string;
  readonly kind: PhraseRelationKind;
  readonly rhythmSimilarity: number;
  readonly intervalSimilarity: number;
}

export interface WrittenSection {
  readonly startBar: number;
  readonly endBar: number;
  readonly kind: "repeated-section" | "first-ending" | "second-ending" | "ending";
}

export interface PhraseAnalysis {
  readonly method: { readonly name: string; readonly version: 1; readonly weights: Readonly<Record<EvidenceKind, number>>; readonly thresholds: typeof PHRASE_THRESHOLDS };
  readonly candidates: readonly BoundaryHypothesis[];
  readonly phrases: readonly PhraseHypothesis[];
  /** Phrase counts when the boundaries are chosen at other thresholds: the segmentation is not unique. */
  readonly alternatives: readonly { readonly name: "period" | "figure"; readonly threshold: number; readonly minBars: number; readonly boundaries: readonly number[]; readonly phraseCount: number }[];
  readonly relations: readonly PhraseRelation[];
  readonly sections: readonly WrittenSection[];
  readonly uncertainty: { readonly meanBoundaryScore: number; readonly ambiguousBoundaries: number; readonly firmShare: number };
  /** Phrase-to-phrase rhythmic variation: mean distance between adjacent phrases' onset patterns (0 identical, 1 disjoint). */
  readonly rhythmicVariation: number;
}

const barEnd = (b: MelodyBar): Fraction => fadd(b.onset, b.length);

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function lbdmStrengths(values: readonly number[]): number[] {
  // r_i: degree of change between neighbouring intervals; s_i = x_i * (r_{i-1} + r_i)
  const M = values.length;
  const change = (a: number, b: number) => (a + b === 0 ? 0 : Math.abs(a - b) / (a + b));
  return values.map((x, i) => {
    const left = i > 0 ? change(values[i - 1]!, x) : 0;
    const right = i + 1 < M ? change(x, values[i + 1]!) : 0;
    return x * (left + right);
  });
}
const normalize = (xs: readonly number[]): number[] => {
  const m = Math.max(...xs, 0);
  return m === 0 ? xs.map(() => 0) : xs.map((x) => x / m);
};

export function analyzePhrases(line: MelodyLine): PhraseAnalysis {
  const notes = line.notes;
  const N = notes.length;
  const beatLen = (n: MelodyNote) => fnum(line.bars[n.bar]!.beat);
  const gaps = Math.max(0, N - 1);

  // ── raw per-gap quantities ────────────────────────────────────────────
  const pitchJump = notes.slice(1).map((n, i) => Math.abs(n.midi - notes[i]!.midi));
  const ioi = notes.slice(1).map((n, i) => (fnum(n.onset) - fnum(notes[i]!.onset)) / beatLen(notes[i]!));
  // only silence the score really writes counts: a rest flagged as converter padding is not evidence of a phrase end
  const restBeats = notes.slice(1).map((n, i) => {
    let t = 0;
    for (let x = notes[i]!.index + 1; x < n.index; x++) {
      const e = line.events[x]!;
      if (e.kind === "rest" && !e.suspect) t += fnum(e.duration);
    }
    return t / beatLen(notes[i]!);
  });
  const sp = normalize(lbdmStrengths(pitchJump));
  const si = normalize(lbdmStrengths(ioi));
  const sr = normalize(lbdmStrengths(restBeats));
  const lbdm = sp.map((x, i) => 0.25 * x + 0.5 * si[i]! + 0.25 * sr[i]!);

  // recurrence: signature of the next / previous 4 notes (intervals + onset gaps)
  const sigAfter = (k: number): string | null => {
    if (k + 4 > N - 0 || k + 1 >= N) return null;
    const seg = notes.slice(k + 1, k + 5);
    if (seg.length < 4) return null;
    return seg.map((n, i) => (i === 0 ? "" : `${n.midi - seg[i - 1]!.midi}/${fstr(n.duration)}`)).join("|") + `|${fstr(seg[0]!.duration)}`;
  };
  const sigBefore = (k: number): string | null => {
    if (k - 3 < 0) return null;
    const seg = notes.slice(k - 3, k + 1);
    return seg.map((n, i) => (i === 0 ? "" : `${n.midi - seg[i - 1]!.midi}/${fstr(n.duration)}`)).join("|") + `|${fstr(seg[0]!.duration)}`;
  };
  const afterSigs = Array.from({ length: gaps }, (_, k) => sigAfter(k));
  const beforeSigs = Array.from({ length: gaps }, (_, k) => sigBefore(k));
  const countOf = (arr: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const s of arr) if (s) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  };
  const afterCounts = countOf(afterSigs);
  const beforeCounts = countOf(beforeSigs);

  // bars completed (full bars) up to each bar index, for 2- and 4-bar units
  const fullBarsDone: number[] = [];
  {
    let done = 0;
    for (const b of line.bars) {
      if (!b.pickup) done++;
      fullBarsDone.push(done);
    }
  }

  const candidates: Omit<BoundaryHypothesis, "selected">[] = [];
  for (let k = 0; k < gaps; k++) {
    const a = notes[k]!;
    const b = notes[k + 1]!;
    const bar = line.bars[a.bar]!;
    const ev: Evidence[] = [];
    const add = (kind: EvidenceKind, strength: number, detail: string) => {
      if (strength > 0.02) ev.push({ kind, strength: round(clamp01(strength), 3), detail });
    };

    // written structure
    const endsBar = Math.abs(fnum(a.end) - fnum(barEnd(bar))) < EPS || b.bar !== a.bar;
    const nextBar = line.bars[b.bar]!;
    if (b.bar !== a.bar || endsBar) {
      if (bar.repeat?.backward) add("written", 1, "repeat sign ends the section after this note");
      else if (bar.ending && (bar.ending.type === "stop" || bar.ending.type === "discontinue")) add("written", 0.9, `volta ending ${bar.ending.numbers} ends`);
      if (nextBar !== bar && nextBar.repeat?.forward) add("written", 0.9, "a repeated section begins next");
      else if (nextBar !== bar && nextBar.ending?.type === "start" && !bar.ending) add("written", 0.7, `volta ending ${nextBar.ending.numbers} begins next`);
    }
    if (a.marks.includes("fermata")) add("written", 0.9, "fermata on the note");
    if (a.marks.includes("slur-stop")) add("written", 0.55, "a slur ends on the note");

    // rest
    if (restBeats[k]! > EPS) add("rest", Math.min(1, restBeats[k]! / 1), `a rest of ${round(restBeats[k]!, 2)} beat(s)`);

    // long note
    const d = fnum(a.duration) / beatLen(a);
    const prev = notes[k - 1];
    const neighbours = [prev, b].filter((x): x is MelodyNote => !!x).map((x) => fnum(x.duration) / beatLen(x));
    const mean = neighbours.length ? neighbours.reduce((x, y) => x + y, 0) / neighbours.length : d;
    if (d >= 1 - EPS && mean > 0) add("long-note", clamp01((d / mean - 1) / 1.5), `${round(d, 2)} beats against neighbours averaging ${round(mean, 2)}`);

    // lbdm
    add("lbdm", lbdm[k]!, "local jump in pitch interval, inter-onset interval or rest");

    // bar and hyper-metric position
    if (endsBar) {
      const done = fullBarsDone[a.bar]!;
      const unit = done > 0 && done % 4 === 0 ? 1 : done > 0 && done % 2 === 0 ? 0.7 : 0.4;
      add("bar", unit, `the note ends bar ${bar.number} (${done} full bar(s) so far${done % 4 === 0 && done ? ", a 4-bar unit" : done % 2 === 0 && done ? ", a 2-bar unit" : ""})`);
    }

    // activity change: attacks per beat, one bar-length before and after the gap
    const win = fnum(bar.length);
    const t = fnum(b.onset);
    const before = notes.filter((n) => fnum(n.onset) >= t - win - EPS && fnum(n.onset) < t - EPS).length;
    const after = notes.filter((n) => fnum(n.onset) >= t - EPS && fnum(n.onset) < t + win - EPS).length;
    if (before > 0 && after > 0) add("activity", clamp01(Math.abs(Math.log(after / before)) / Math.log(3)), `${before} attacks before, ${after} after (one bar each side)`);

    // recurrence of the next or previous material
    const sa = afterSigs[k];
    const sb = beforeSigs[k];
    if (sa && (afterCounts.get(sa) ?? 0) > 1) add("recurrence", 0.8, "the next four notes restate earlier (or later) music");
    if (sb && (beforeCounts.get(sb) ?? 0) > 1) add("recurrence", 0.5, "the last four notes restate earlier (or later) music");

    // cadence: tonic or chord-root arrival, strong or long
    if (line.tonal && line.tuning === "12-tet") {
      const chord = line.chords.find((c) => fnum(c.onset) <= fnum(a.onset) + EPS && fnum(a.onset) < fnum(c.end) - EPS);
      const pc = ((Math.round(a.midi) % 12) + 12) % 12;
      const isTonic = pc === line.tonal.tonicPc;
      const isRoot = chord ? pc === chord.rootPc : false;
      const arrival = a.weight >= 3 || d >= 1 - EPS;
      if (arrival && (isTonic || (isRoot && chord && chord.rootPc === line.tonal.tonicPc))) add("cadence", (isTonic ? 0.6 : 0.4) * line.tonal.confidence + (isTonic && isRoot ? 0.2 : 0), isRoot ? "tonic arrival over a tonic-root chord" : "tonic arrival on a strong or long note");
    }

    const score = 1 - ev.reduce((p, e) => p * (1 - EVIDENCE_WEIGHTS[e.kind] * e.strength), 1);
    const kinds = new Set(ev.filter((e) => e.strength >= 0.3).map((e) => e.kind)).size;
    candidates.push({
      afterNote: a.id,
      index: k,
      at: fstr(b.onset),
      bar: a.bar,
      score: round(score, 3),
      evidence: ev,
      independentKinds: kinds,
      level: score >= 0.65 && kinds >= 2 ? "firm" : score >= PHRASE_THRESHOLDS.primary ? "likely" : "possible",
    });
  }

  // ── choose boundaries at a threshold, suppressing weaker neighbours within one bar ──
  const choose = (threshold: number, minBars: number): number[] => {
    const eligible = candidates.filter((c) => c.score >= threshold).sort((a, b) => b.score - a.score || a.index - b.index);
    const taken: number[] = [];
    for (const c of eligible) {
      const t = fnum(notes[c.index + 1]!.onset);
      // a unit at this level is at least `minBars` long: a weaker boundary closer than that to a stronger one is suppressed
      const m = line.bars[notes[c.index]!.bar]!.meter;
      const minGap = (minBars * m.beats) / m.beatType;
      // and not within half a unit of either end of the piece (no one-note stub phrases at the edges)
      if (t - fnum(notes[0]!.onset) < minGap / 2 - EPS || fnum(notes[N - 1]!.end) - t < minGap / 2 - EPS) continue;
      if (taken.some((i) => Math.abs(fnum(notes[i + 1]!.onset) - t) < minGap - EPS)) continue;
      taken.push(c.index);
    }
    return taken.sort((a, b) => a - b);
  };
  const primary = choose(PHRASE_LEVELS.phrase.threshold, PHRASE_LEVELS.phrase.minBars);
  const selectedSet = new Set(primary);
  const cands: BoundaryHypothesis[] = candidates.filter((c) => c.score >= PHRASE_THRESHOLDS.floor).map((c) => ({ ...c, selected: selectedSet.has(c.index) }));

  // ── phrases between chosen boundaries ─────────────────────────────────
  const scoreAt = new Map(candidates.map((c) => [c.index, c.score] as const));
  const edges = [-1, ...primary, N - 1];
  const phrases: PhraseHypothesis[] = [];
  for (let e = 0; e + 1 < edges.length; e++) {
    const from = edges[e]! + 1;
    const to = edges[e + 1]!;
    if (to < from) continue;
    const seg = notes.slice(from, to + 1);
    const startScore = e === 0 ? 1 : scoreAt.get(edges[e]!)!;
    const endScore = e + 2 === edges.length ? 1 : scoreAt.get(edges[e + 1]!)!;
    phrases.push({
      id: `ph${phrases.length + 1}`,
      noteIds: seg.map((n) => n.id),
      startBar: seg[0]!.bar,
      endBar: seg[seg.length - 1]!.bar,
      confidence: round(startScore * endScore, 3),
      profile: phraseProfile(line, from, to),
    });
  }

  // ── relations among phrases ──────────────────────────────────────────
  const relations: PhraseRelation[] = [];
  for (let i = 0; i < phrases.length; i++) {
    for (let j = i + 1; j < Math.min(phrases.length, i + 4); j++) {
      const a = phrases[i]!.profile;
      const b = phrases[j]!.profile;
      const { kind, rhythmSimilarity: rs, intervalSimilarity: isim } = relateProfiles(a, b);
      if (kind !== "contrast" || j === i + 1) relations.push({ from: phrases[i]!.id, to: phrases[j]!.id, kind, rhythmSimilarity: round(rs, 3), intervalSimilarity: round(isim, 3) });
    }
  }
  let variation = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < phrases.length; i++) {
    variation += 1 - jaccard(phrases[i]!.profile.rhythm.map((t, k) => `${k}:${t}`), phrases[i + 1]!.profile.rhythm.map((t, k) => `${k}:${t}`));
    pairs++;
  }

  // ── written sections from repeat signs and endings ────────────────────
  const sections: WrittenSection[] = [];
  let sectionStart = 0;
  line.bars.forEach((b, i) => {
    if (b.repeat?.forward) sectionStart = i;
    if (b.repeat?.backward) {
      sections.push({ startBar: sectionStart, endBar: i, kind: "repeated-section" });
      sectionStart = i + 1;
    }
    if (b.ending && (b.ending.type === "stop" || b.ending.type === "discontinue")) {
      sections.push({ startBar: i, endBar: i, kind: b.ending.numbers.startsWith("1") ? "first-ending" : b.ending.numbers.startsWith("2") ? "second-ending" : "ending" });
    }
  });

  const near = candidates.filter((c) => Math.abs(c.score - PHRASE_THRESHOLDS.primary) <= 0.08).length;
  const coarse = choose(PHRASE_LEVELS.period.threshold, PHRASE_LEVELS.period.minBars);
  const fine = choose(PHRASE_LEVELS.figure.threshold, PHRASE_LEVELS.figure.minBars);
  return {
    method: { name: "boundary-evidence/noisy-or", version: 1, weights: EVIDENCE_WEIGHTS, thresholds: PHRASE_THRESHOLDS },
    candidates: cands,
    phrases,
    alternatives: [
      { name: "period", threshold: PHRASE_LEVELS.period.threshold, minBars: PHRASE_LEVELS.period.minBars, boundaries: coarse, phraseCount: coarse.length + 1 },
      { name: "figure", threshold: PHRASE_LEVELS.figure.threshold, minBars: PHRASE_LEVELS.figure.minBars, boundaries: fine, phraseCount: fine.length + 1 },
    ],
    relations,
    sections,
    uncertainty: {
      meanBoundaryScore: primary.length ? round(primary.reduce((a, i) => a + scoreAt.get(i)!, 0) / primary.length, 3) : 0,
      ambiguousBoundaries: near,
      firmShare: primary.length ? round(cands.filter((c) => c.selected && c.level === "firm").length / primary.length, 3) : 0,
    },
    rhythmicVariation: pairs ? round(variation / pairs, 3) : 0,
  };
}

/** Profile of the notes `from..to` (inclusive indices into line.notes). Also usable for any phrase of any line. */
export function phraseProfile(line: MelodyLine, from: number, to: number): PhraseProfile {
  const seg = line.notes.slice(from, to + 1);
  const first = seg[0]!;
  const last = seg[seg.length - 1]!;
  const bl = (n: MelodyNote) => fnum(line.bars[n.bar]!.beat);
  const t0 = fnum(first.onset);
  const t1 = fnum(last.end);
  const span = Math.max(EPS, t1 - t0);
  const beats = span / bl(first);
  const ms = seg.map((n) => n.midi);
  const thirds: [number, number, number] = [0, 0, 0];
  for (const n of seg) thirds[Math.min(2, Math.floor(((fnum(n.onset) - t0) / span) * 3))]!++;
  const lastBeats = fnum(last.duration) / bl(last);
  const meanBeats = seg.reduce((a, n) => a + fnum(n.duration) / bl(n), 0) / seg.length;
  const [a, b, c] = thirds;
  const hi = Math.max(a, b, c);
  const lo = Math.min(a, b, c);
  let shape: ActivityShape;
  const lastShare = fnum(last.duration) / span;
  if (lastBeats >= 1.5 - EPS && lastShare >= 0.2 && seg.length >= 4) shape = "burst-hold";
  else if (hi <= 1.3 * Math.max(lo, 1e-9)) shape = "even";
  else if (b === hi && b > a && b > c) shape = "arch";
  else if (b === lo && b < a && b < c) shape = "valley";
  else shape = c > a ? "rising" : "falling";
  const finalIv = seg.length > 1 ? round(last.midi - seg[seg.length - 2]!.midi, 3) : null;
  const before = line.events[first.index - 1];
  const after = line.events[last.index + 1];
  return {
    noteCount: seg.length,
    beats: round(beats, 3),
    bars: round(span / (line.bars[first.bar]!.meter.beats / line.bars[first.bar]!.meter.beatType), 3),
    attacksPerBeat: round(seg.length / beats, 3),
    activityThirds: thirds,
    activityShape: shape,
    contour: { kind: contourClassOfMidi(ms), shape: contourShapeOfMidi(ms) },
    range: { lowest: Math.min(...ms), highest: Math.max(...ms), span: Math.max(...ms) - Math.min(...ms), mean: round(ms.reduce((x, y) => x + y, 0) / ms.length, 2) },
    opening: { firstWeight: first.weight, afterRest: before?.kind === "rest" && !before.suspect, pickup: line.bars[first.bar]!.pickup },
    ending: {
      finalBeats: round(lastBeats, 3),
      finalWeight: last.weight,
      finalInterval: finalIv,
      finalIntervalClass: finalIv === null ? null : intervalClass(finalIv),
      approach: finalIv === null ? "none" : finalIv > 0 ? "up" : finalIv < 0 ? "down" : "level",
      decelerates: lastBeats >= 1 - EPS && lastBeats >= 1.5 * meanBeats - EPS,
      followedByRest: after?.kind === "rest" && !after.suspect,
      shareOfPhrase: round(lastShare, 3),
    },
    rhythm: seg.map((n) => fstr(n.duration)),
    intervals: intervalsOfMidi(ms),
  };
}

// ── relating and comparing two phrases ───────────────────────────────────
const posKeys = (xs: readonly string[]) => xs.map((t, k) => `${k}:${t}`);

/** How two phrases relate, by the same rules used between neighbouring phrases of one piece. */
export function relateProfiles(a: PhraseProfile, b: PhraseProfile): { kind: PhraseRelationKind; rhythmSimilarity: number; intervalSimilarity: number } {
  const rs = jaccard(posKeys(a.rhythm), posKeys(b.rhythm));
  const n = Math.min(a.intervals.length, b.intervals.length);
  const eq = Array.from({ length: n }, (_, k) => a.intervals[k] === b.intervals[k]);
  const isim = n === 0 ? 0 : eq.filter(Boolean).length / Math.max(a.intervals.length, b.intervals.length);
  const sameBody = n >= 4 && eq.slice(0, Math.max(0, n - 2)).every(Boolean);
  let kind: PhraseRelationKind;
  if (a.intervals.length === b.intervals.length && eq.every(Boolean) && rs > 0.99) kind = "exact-repeat";
  else if (sameBody && rs >= 0.6) kind = "repeat-modified-ending";
  else if (rs >= 0.8 && isim < 0.6) kind = "same-rhythm-new-pitches";
  else if (a.contour.shape === b.contour.shape && rs < 0.6) kind = "same-contour-new-rhythm";
  else kind = "contrast";
  return { kind, rhythmSimilarity: rs, intervalSimilarity: isim };
}

function lcsRatio<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  return dp[0]![0]! / Math.max(a.length, b.length);
}

/** Onset positions (exact fractions of a whole note from the phrase start) of a profile's notes. */
export function profileOnsets(p: PhraseProfile): string[] {
  const out: string[] = [];
  let t: Fraction = { num: 0, den: 1 };
  for (const d of p.rhythm) {
    out.push(fstr(t));
    const [n, den] = d.split("/");
    t = fadd(t, { num: Number(n), den: den === undefined ? 1 : Number(den) });
  }
  return out;
}

export interface PhraseComparison {
  /** Similarity 0 (nothing shared) .. 1 (identical), per aspect. */
  readonly aspects: { readonly rhythm: number; readonly intervals: number; readonly contour: number; readonly activity: number; readonly ending: number; readonly register: number };
  readonly overall: number;
  readonly relation: PhraseRelationKind;
  /** Plain statements of what is alike and what differs. */
  readonly statements: readonly string[];
}

const COMPARE_WEIGHTS = { rhythm: 0.3, intervals: 0.25, contour: 0.15, activity: 0.1, ending: 0.1, register: 0.1 } as const;

/** Compare two phrase profiles aspect by aspect. Symmetric. Each aspect is a similarity in 0..1. */
export function comparePhraseProfiles(a: PhraseProfile, b: PhraseProfile): PhraseComparison {
  const rhythm = (jaccard(profileOnsets(a), profileOnsets(b)) + lcsRatio(a.rhythm, b.rhythm)) / 2;
  const intervals = lcsRatio(a.intervals, b.intervals);
  const contour = lcsRatio([...a.contour.shape], [...b.contour.shape]);
  const norm = (t: readonly number[]) => {
    const s = t.reduce((x, y) => x + y, 0) || 1;
    return t.map((x) => x / s);
  };
  const na = norm(a.activityThirds);
  const nb = norm(b.activityThirds);
  const activity = 1 - na.reduce((acc, x, i) => acc + Math.abs(x - nb[i]!), 0) / 2;
  const fb = Math.min(a.ending.finalBeats, b.ending.finalBeats) / Math.max(a.ending.finalBeats, b.ending.finalBeats, 1e-9);
  const ending = (fb + (a.ending.approach === b.ending.approach ? 1 : 0) + (a.ending.finalIntervalClass === b.ending.finalIntervalClass ? 1 : 0)) / 3;
  const register = (1 - Math.min(1, Math.abs(a.range.mean - b.range.mean) / 12) + (1 - Math.min(1, Math.abs(a.range.span - b.range.span) / Math.max(a.range.span, b.range.span, 1)))) / 2;
  const aspects = { rhythm: round(rhythm, 3), intervals: round(intervals, 3), contour: round(contour, 3), activity: round(activity, 3), ending: round(ending, 3), register: round(register, 3) };
  const overall = (Object.keys(COMPARE_WEIGHTS) as (keyof typeof COMPARE_WEIGHTS)[]).reduce((acc, k) => acc + COMPARE_WEIGHTS[k] * aspects[k], 0);
  const statements: string[] = [];
  const say = (k: keyof typeof aspects, name: string) => {
    if (aspects[k] >= 0.85) statements.push(`nearly the same ${name}`);
    else if (aspects[k] <= 0.35) statements.push(`very different ${name}`);
  };
  say("rhythm", "rhythm");
  say("intervals", "melodic intervals");
  say("contour", "contour");
  say("activity", "activity shape");
  say("ending", "ending");
  say("register", "register");
  if (a.activityShape !== b.activityShape) statements.push(`activity: ${a.activityShape} against ${b.activityShape}`);
  if (a.contour.kind !== b.contour.kind) statements.push(`contour: ${a.contour.kind} against ${b.contour.kind}`);
  return { aspects, overall: round(overall, 3), relation: relateProfiles(a, b).kind, statements };
}
