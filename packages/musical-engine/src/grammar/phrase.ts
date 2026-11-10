/**
 * Deterministic, constraint-based phrase generation.
 *
 * The generator does not store licks. It builds a phrase from the grammar:
 *
 *   target      a degree of a chord, arriving at an exact time          (MusicalTarget)
 *   embellish   an enclosure / approach built with `surround`/`approach` (operations.ts)
 *   outline     an arpeggio built from the chord with `arpeggiate`
 *   rhythm      a plan of exact durations and rests from the vocabulary (rhythmic.ts)
 *
 * Pitch and rhythm are decided together: the number of notes the pitch material needs fixes the
 * rhythm plans that can carry it, and the rhythm's accents then decide how the pitch material is
 * judged (chord tones on strong beats, approach notes lighter than the arrival).
 *
 * HARD constraints must hold for a candidate to exist at all (target and exact arrival time,
 * register, maximum leap, fret range, a playable fingering). SOFT preferences only rank what
 * survives. The ranking is a transparent sum of named heuristics. It measures adherence to those
 * heuristics, NOT musical beauty, and says so.
 */
import { makeFretboard, positionsForMidi, STANDARD_TUNING, type Tuning } from "../instrument/fretboard";
import { formatNote, formatPitch, midi, pitchFromMidi, type Pitch } from "../theory/pitch";
import { fadd, fcmp, fnum, frac, fstr, fsub, type Fraction } from "../time/rational";
import type { IRConstructionStep } from "../ir/types";
import { chordPitchesIn, classifyPitch, degreeOf, hasDegree, type Chord } from "./chords";
import type { LineEvent, LineNote, MetricFrame, NoteFunctions } from "./line";
import { contourClassOf, contourOf, contourShape, FOUR_FOUR_FRAME, isNote, metricPosition, type ContourClass } from "./line";
import {
  approach,
  arpeggiate,
  arpeggioPool,
  connect,
  surround,
  type ArpDirection,
  type OpDescription,
  type PitchSpace,
  type Side,
} from "./operations";
import { rhythmPlans, syncopationOf, type RhythmIntent, type RhythmPlan } from "./rhythmic";

export interface ProgressionChord {
  readonly chord: Chord;
  readonly onset: Fraction;
  readonly duration: Fraction;
  readonly roman?: string;
}

export interface TargetSpec {
  /** Index into the progression. */
  readonly chordIndex: number;
  /** "3", "7", "9" ... any degree label the chord can name. */
  readonly degree: string;
  /** Default: the onset of that chord. */
  readonly arrival?: Fraction;
  /** Default: until the end of that chord. */
  readonly duration?: Fraction;
  /** Only target pitches inside this MIDI range (selects an octave). Default: the whole register. */
  readonly range?: readonly [number, number];
}

export interface OutlineSpec {
  /** The chord to outline. Default: the chord before the target's. */
  readonly chordIndex?: number;
  /** "any" tries up, down, up-down and mixed shapes and lets the ranking choose. */
  readonly direction: ArpDirection | "any";
  /** How many notes. Default tries 3 and 4. */
  readonly counts?: readonly number[];
  /** Chord degrees the arpeggio uses. Default 1 3 5 7. */
  readonly degrees?: readonly string[];
  /** An earlier arpeggio over an earlier chord (the ii before the V), played before the main outline. */
  readonly lead?: { readonly chordIndex: number; readonly direction: ArpDirection | "any"; readonly counts?: readonly number[]; readonly degrees?: readonly string[] };
}

export type StepChoice = "chromatic" | "diatonic" | "mixed" | "any";

export interface EmbellishmentSpec {
  readonly kind: "enclosure" | "approach" | "run" | "none";
  readonly step: StepChoice;
  /** Which side an enclosure begins on, or an approach comes from. Default any. */
  readonly side?: Side | "any";
  /** Notes in an approach (1 or 2). Ignored by enclosures. Default 1. */
  readonly count?: number;
  /** For a run: the chord whose tones it starts from. Default: the chord before the target's. */
  readonly runFrom?: number;
}

export interface HardConstraints {
  /** Every note lies within these MIDI numbers. */
  readonly register: readonly [number, number];
  /** Largest allowed melodic leap in semitones. Default 9. */
  readonly maxLeap?: number;
  /** Fret window used to realize the phrase on the guitar. Default 0-15. */
  readonly fretRange?: readonly [number, number];
  /** Largest hand shift between consecutive fretted notes. Default 5 frets. */
  readonly maxFretShift?: number;
}

export interface SoftPreferences {
  readonly direction?: "ascending" | "descending" | "arch";
  /** Preferred share of moves that are steps (0..1). */
  readonly stepwise?: number;
  /** Preferred share of notes that repeat the previous pitch (0..1). */
  readonly repetition?: number;
}

export interface PhraseSpec {
  readonly space: PitchSpace;
  readonly progression: readonly ProgressionChord[];
  readonly start: Fraction;
  readonly target: TargetSpec;
  readonly outline: OutlineSpec | null;
  readonly embellishment: EmbellishmentSpec;
  readonly rhythm?: RhythmIntent;
  readonly hard: HardConstraints;
  readonly soft?: SoftPreferences;
  /** A HARD requirement on the overall contour: its class, or its exact up/down shape. */
  readonly contour?: { readonly cls?: ContourClass; readonly shape?: string };
  /** How many candidates to return. Default 5. */
  readonly candidates?: number;
  readonly tuning?: Tuning;
  readonly fretCount?: number;
  readonly metric?: MetricFrame;
  /** Hold some part of an earlier result fixed (see transform functions). */
  readonly fixed?: {
    /** Use exactly this rhythm; the pitch material is generated around it. */
    readonly rhythm?: RhythmPlan;
    /** Keep this candidate's pitches, gestures and roles; only the rhythm is generated. */
    readonly template?: PhraseCandidate;
  };
  /** Exclude candidates whose pitch sequence equals one of these (MIDI lists). */
  readonly avoidPitchSequences?: readonly (readonly number[])[];
}

export interface ScorePart {
  readonly name: string;
  /** 0..1 */
  readonly value: number;
  readonly weight: number;
  readonly why: string;
}

export interface Score {
  readonly total: number;
  readonly parts: readonly ScorePart[];
  readonly disclaimer: string;
}

export const SCORE_DISCLAIMER =
  "A score ranks how well a candidate satisfies the stated heuristics (structure, continuity, target alignment, rhythmic variety, playability, preferences). It is not a measure of musical beauty.";

export interface GestureRecord {
  readonly id: string;
  readonly kind: string;
  readonly notes: readonly string[];
  readonly target?: string;
  readonly steps: readonly IRConstructionStep[];
  readonly params: Readonly<Record<string, string | number>>;
}

export interface PhraseCandidate {
  readonly id: string;
  readonly events: readonly LineEvent[];
  readonly gestures: readonly GestureRecord[];
  readonly targetNote: string;
  readonly score: Score;
  /** Human-readable summary of the choices that built it. */
  readonly summary: string;
  /** The choices, so the phrase can be regenerated with part of it held fixed. */
  readonly choices: {
    readonly rhythm: RhythmPlan;
    readonly pitches: readonly Pitch[];
    readonly outline: string;
    readonly embellishment: string;
  };
}

export type PhraseResult =
  | { readonly ok: true; readonly candidates: readonly PhraseCandidate[]; readonly considered: number }
  | { readonly ok: false; readonly reason: string };

interface Variant {
  readonly pitches: Pitch[];
  readonly roles: string[];
  readonly label: string;
  readonly description: OpDescription;
}

const chordAt = (prog: readonly ProgressionChord[], at: Fraction): ProgressionChord | undefined =>
  prog.find((p) => fcmp(at, p.onset) >= 0 && fcmp(at, fadd(p.onset, p.duration)) < 0);

const sideRole = (kind: string, side: "upper" | "lower"): string => `${side}-${kind}-neighbor`;

interface RunContext {
  readonly chord: Chord | undefined;
  readonly range: readonly [number, number];
  readonly maxLeap: number;
}

/**
 * A scalar run into the target: start on a tone of a chord and connect to the target by scale steps
 * (`connect`), so the notes in between are passing tones. The start must be at least a minor third
 * from the target, otherwise there is nothing to connect.
 */
function runVariants(target: Pitch, space: PitchSpace, ctx: RunContext | undefined): Variant[] {
  if (!ctx?.chord || space.scale.length === 0) return [];
  const found: { v: Variant; d: number }[] = [];
  const seen = new Set<string>();
  for (const start of chordPitchesIn(ctx.chord, ctx.range[0], ctx.range[1])) {
    const d = midi(start) - midi(target);
    if (Math.abs(d) < 3 || Math.abs(d) > ctx.maxLeap) continue;
    const mid = connect(start, target, "diatonic", { space });
    const pitches = [start, ...mid.pitches];
    if (pitches.length < 2 || pitches.length > 6) continue;
    const key = pitches.map(midi).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      d,
      v: {
        pitches,
        roles: ["run-start", ...mid.pitches.map(() => "passing-tone")],
        label: `scale run ${d > 0 ? "down" : "up"} from ${formatPitch(start)}`,
        description: mid.description,
      },
    });
  }
  return found.sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || a.d - b.d).slice(0, 4).map((x) => x.v);
}

/** Embellishment variants for one target pitch, in a fixed order, with duplicates (same pitches) removed. */
function embellishmentVariants(target: Pitch, spec: EmbellishmentSpec, space: PitchSpace, ctx?: RunContext): Variant[] {
  if (spec.kind === "none") return [];
  if (spec.kind === "run") return runVariants(target, space, ctx);
  const out: Variant[] = [];
  const seen = new Set<string>();
  const add = (v: Variant) => {
    const key = v.pitches.map(midi).join(",");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  };
  const diatonicOk = space.scale.length > 0;
  const steps: ("chromatic" | "diatonic")[] = spec.step === "chromatic" ? ["chromatic"] : spec.step === "diatonic" ? ["diatonic"] : spec.step === "mixed" ? [] : ["chromatic", "diatonic"];
  const sides: Side[] = spec.side === "above" || spec.side === "below" ? [spec.side] : ["above", "below"];

  if (spec.kind === "enclosure") {
    const combos: ["chromatic" | "diatonic", "chromatic" | "diatonic"][] =
      spec.step === "mixed" ? [["diatonic", "chromatic"], ["chromatic", "diatonic"]] : steps.map((s) => [s, s] as ["chromatic" | "diatonic", "chromatic" | "diatonic"]);
    if (spec.step === "any") combos.push(["diatonic", "chromatic"], ["chromatic", "diatonic"]);
    for (const [upper, lower] of combos) {
      if ((upper === "diatonic" || lower === "diatonic") && !diatonicOk) continue;
      for (const first of sides) {
        const r = surround(target, { first, upper, lower, space });
        const kindWord = upper === lower ? upper : "mixed";
        const roles = first === "above" ? [`upper-${upper}-neighbor`, `lower-${lower}-neighbor`] : [`lower-${lower}-neighbor`, `upper-${upper}-neighbor`];
        add({ pitches: r.pitches, roles, label: `${kindWord} enclosure from ${first}`, description: r.description });
      }
    }
  } else {
    const counts = spec.count ? [spec.count] : [1];
    for (const kind of steps.length ? steps : (["chromatic"] as const)) {
      if (kind === "diatonic" && !diatonicOk) continue;
      for (const from of sides) {
        for (const count of counts) {
          const r = approach(target, { from, kind, count, space });
          const side = from === "below" ? "lower" : "upper";
          add({ pitches: r.pitches, roles: r.pitches.map(() => sideRole(kind, side)), label: `${kind} approach from ${from}${count > 1 ? ` (${count} notes)` : ""}`, description: r.description });
        }
      }
    }
  }
  return out;
}

interface Fingering {
  readonly positions: { string: number; fret: number }[];
  readonly cost: number;
}

/** The cheapest hand path through the notes within the fret window, or null if none exists. */
function fingerPath(midis: readonly number[], tuning: Tuning, fretCount: number, window: readonly [number, number], maxShift: number): Fingering | null {
  const fb = makeFretboard(tuning, fretCount);
  const opts = midis.map((m) => positionsForMidi(fb, m, window[0], window[1]));
  if (opts.some((o) => o.length === 0)) return null;
  if (midis.length === 0) return { positions: [], cost: 0 };
  type Cell = { cost: number; prev: number };
  const table: Cell[][] = [opts[0]!.map((p) => ({ cost: Math.abs(p.fret - 5) * 0.05, prev: -1 }))];
  for (let i = 1; i < opts.length; i++) {
    const row: Cell[] = [];
    opts[i]!.forEach((p) => {
      let best: Cell = { cost: Infinity, prev: -1 };
      opts[i - 1]!.forEach((q, k) => {
        const shift = p.fret === 0 || q.fret === 0 ? 0 : Math.abs(p.fret - q.fret);
        if (shift > maxShift) return;
        const c = table[i - 1]![k]!.cost + shift + Math.abs(p.string - q.string) * 0.3;
        if (c < best.cost) best = { cost: c, prev: k };
      });
      row.push(best);
    });
    table.push(row);
  }
  const last = table[table.length - 1]!;
  let bi = -1;
  let bc = Infinity;
  last.forEach((c, i) => {
    if (c.cost < bc) {
      bc = c.cost;
      bi = i;
    }
  });
  if (bi < 0 || !Number.isFinite(bc)) return null;
  const positions: { string: number; fret: number }[] = new Array(midis.length);
  for (let i = midis.length - 1, k = bi; i >= 0; i--) {
    positions[i] = opts[i]![k]!;
    k = table[i]![k]!.prev;
  }
  return { positions, cost: bc };
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Generate ranked candidate phrases. Deterministic: the same spec always gives the same list. */
export function generatePhrase(spec: PhraseSpec): PhraseResult {
  const prog = spec.progression;
  const targetEntry = prog[spec.target.chordIndex];
  if (!targetEntry) return { ok: false, reason: `There is no chord at index ${spec.target.chordIndex}.` };
  if (!hasDegree(targetEntry.chord, spec.target.degree)) {
    return { ok: false, reason: `${targetEntry.chord.symbol} has no degree "${spec.target.degree}".` };
  }
  const arrival = spec.target.arrival ?? targetEntry.onset;
  const span = fsub(arrival, spec.start);
  if (span.num < 0) return { ok: false, reason: "The target arrives before the phrase starts." };
  const frame = spec.metric ?? FOUR_FOUR_FRAME;
  const hard = spec.hard;
  const [lo, hi] = hard.register;
  const maxLeap = hard.maxLeap ?? 9;
  const fretWindow = hard.fretRange ?? [0, 15];
  const maxShift = hard.maxFretShift ?? 5;
  const tuning = spec.tuning ?? STANDARD_TUNING;
  const fretCount = spec.fretCount ?? 22;

  // 1. target pitches inside the register
  const targetDegree = degreeOf(targetEntry.chord, spec.target.degree);
  const [tlo, thi] = spec.target.range ?? [lo, hi];
  const targetPitches = chordPitchesIn(targetEntry.chord, Math.max(lo, tlo), Math.min(hi, thi), [spec.target.degree]);
  if (targetPitches.length === 0) return { ok: false, reason: `No ${targetDegree.note.letter}-class pitch lies in the register ${Math.max(lo, tlo)}-${Math.min(hi, thi)}.` };
  const runChord = prog[spec.embellishment.runFrom ?? spec.target.chordIndex - 1]?.chord;

  // 2. the outline's chord and pool
  const outlineChordIndex = spec.outline ? (spec.outline.chordIndex ?? spec.target.chordIndex - 1) : -1;
  const outlineEntry = spec.outline ? prog[outlineChordIndex] : undefined;
  if (spec.outline && !outlineEntry) return { ok: false, reason: "There is no chord to outline before the target." };

  const rhythmCache = new Map<number, RhythmPlan[]>();
  const plansFor = (n: number): RhythmPlan[] => {
    if (spec.fixed?.rhythm) return spec.fixed.rhythm.hits === n ? [spec.fixed.rhythm] : [];
    if (n === 0) return [{ id: "silence", gestures: [], slots: span.num > 0 ? [{ offset: frac(0), duration: span, rest: true }] : [], hits: 0 }];
    let v = rhythmCache.get(n);
    if (!v) {
      v = rhythmPlans(span, n, spec.rhythm ?? {}, 30);
      rhythmCache.set(n, v);
    }
    return v;
  };

  const candidates: (PhraseCandidate & { _key: string })[] = [];
  let considered = 0;
  let sawPitches = false;

  for (const T of targetPitches) {
    const embellish = spec.fixed?.template ? [null] : embellishmentVariants(T, spec.embellishment, spec.space, { chord: runChord, range: [lo, hi], maxLeap });
    const variants: (Variant | null)[] = embellish.length ? embellish : [null];

    for (const E of variants) {
      // outline variants that connect well to E (or to T when there is no embellishment)
      const entry: Pitch = E ? E.pitches[0]! : T;
      type Seg = { count: number; chordIndex: number; label: string; description: OpDescription };
      type O = { pitches: Pitch[]; label: string; description: OpDescription; segments?: Seg[] };
      const outlines: O[] = [];
      if (spec.fixed?.template) {
        outlines.push({ pitches: [], label: "fixed", description: { op: "fixed", params: {} } });
      } else if (spec.outline && outlineEntry) {
        const dirs: ArpDirection[] = spec.outline.direction === "any" ? ["up", "down", "updown", "mixed"] : [spec.outline.direction];
        const counts = spec.outline.counts ?? [3, 4];
        const pool = arpeggioPool(outlineEntry.chord, [lo, hi], spec.outline.degrees);
        for (const count of counts) {
          for (const direction of dirs) {
            const local: (O & { leap: number })[] = [];
            for (let startIndex = 0; startIndex < pool.length; startIndex++) {
              const r = arpeggiate(outlineEntry.chord, { direction, count, range: [lo, hi], ...(spec.outline.degrees ? { degrees: spec.outline.degrees } : {}), startIndex });
              const leap = Math.abs(midi(entry) - midi(r.pitches[r.pitches.length - 1]!));
              if (leap > maxLeap || leap === 0) continue;
              local.push({ pitches: r.pitches, label: `${direction} ${count}-note arpeggio of ${outlineEntry.chord.symbol}`, description: r.description, leap });
            }
            local.sort((a, b) => a.leap - b.leap || midi(a.pitches[0]!) - midi(b.pitches[0]!));
            outlines.push(...local.slice(0, 4));
          }
        }
        // a lead arpeggio over an earlier chord, joined to the main outline
        const lead = spec.outline.lead;
        const leadEntry = lead ? prog[lead.chordIndex] : undefined;
        if (lead && leadEntry) {
          const mains = outlines.splice(0, outlines.length);
          const leadDirs: ArpDirection[] = lead.direction === "any" ? ["up", "down", "updown", "mixed"] : [lead.direction];
          const poolL = arpeggioPool(leadEntry.chord, [lo, hi], lead.degrees);
          for (const m of mains.slice(0, 12)) {
            for (const count of lead.counts ?? [2, 3]) {
              for (const direction of leadDirs) {
                const local: { r: ReturnType<typeof arpeggiate>; leap: number }[] = [];
                for (let startIndex = 0; startIndex < poolL.length; startIndex++) {
                  const r = arpeggiate(leadEntry.chord, { direction, count, range: [lo, hi], ...(lead.degrees ? { degrees: lead.degrees } : {}), startIndex });
                  const leap = Math.abs(midi(m.pitches[0]!) - midi(r.pitches[r.pitches.length - 1]!));
                  if (leap > maxLeap || leap === 0) continue;
                  local.push({ r, leap });
                }
                local.sort((a, b) => a.leap - b.leap || midi(a.r.pitches[0]!) - midi(b.r.pitches[0]!));
                for (const { r } of local.slice(0, 2)) {
                  const leadLabel = `${direction} ${count}-note arpeggio of ${leadEntry.chord.symbol}`;
                  outlines.push({
                    pitches: [...r.pitches, ...m.pitches],
                    label: `${leadLabel}, then ${m.label}`,
                    description: m.description,
                    segments: [
                      { count: r.pitches.length, chordIndex: lead.chordIndex, label: leadLabel, description: r.description },
                      { count: m.pitches.length, chordIndex: outlineChordIndex, label: m.label, description: m.description },
                    ],
                  });
                }
              }
            }
          }
        }
      } else {
        outlines.push({ pitches: [], label: "no outline", description: { op: "none", params: {} } });
      }

      for (const O of outlines) {
        const tpl = spec.fixed?.template?.choices.pitches;
        const before: Pitch[] = tpl ? tpl.slice(0, -1) : [...O.pitches, ...(E?.pitches ?? [])];
        const tgt: Pitch = tpl ? tpl[tpl.length - 1]! : T;
        const seq = [...before, tgt];
        if (spec.contour?.cls !== undefined && contourClassOf(seq) !== spec.contour.cls) continue;
        if (spec.contour?.shape !== undefined && contourShape(seq) !== spec.contour.shape) continue;
        if (spec.avoidPitchSequences?.some((a) => a.length === seq.length && a.every((m, i) => m === midi(seq[i]!)))) continue;
        sawPitches = true;
        // hard: register and leaps
        if (seq.some((p) => midi(p) < lo || midi(p) > hi)) continue;
        let leapOk = true;
        for (let i = 1; i < seq.length; i++) if (Math.abs(midi(seq[i]!) - midi(seq[i - 1]!)) > maxLeap) leapOk = false;
        if (!leapOk) continue;
        // hard: playable on the guitar
        const finger = fingerPath(seq.map(midi), tuning, fretCount, fretWindow, maxShift);
        if (!finger) continue;

        for (const plan of plansFor(before.length)) {
          // each outline segment's notes must sound during its own chord (an arpeggio of G7 belongs over G7)
          if (!spec.fixed?.template && O.pitches.length > 0) {
            const onsets = plan.slots.filter((x) => !x.rest).map((x) => fadd(spec.start, x.offset));
            const segs: { count: number; chordIndex: number }[] = O.segments ?? [{ count: O.pitches.length, chordIndex: outlineChordIndex }];
            let at = 0;
            let ok = true;
            for (const sg of segs) {
              const win = prog[sg.chordIndex];
              for (let k = 0; k < sg.count && win; k++) {
                const o = onsets[at + k];
                if (!o || fcmp(o, win.onset) < 0 || fcmp(o, fadd(win.onset, win.duration)) >= 0) ok = false;
              }
              at += sg.count;
            }
            if (!ok) continue;
          }
          considered++;
          const built = buildCandidate(spec, prog, frame, plan, before, tgt, targetDegree.label, spec.target.chordIndex, arrival, O.pitches.length, O, E, finger, targetEntry, spec.fixed?.template);
          candidates.push(built);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: sawPitches
        ? "No candidate satisfies every hard constraint (register, leap, fret range, playable fingering and a rhythm that fits the span). Loosen one of them."
        : "No pitch material could be built from the chosen outline and embellishment inside the register.",
    };
  }

  // rank, then pick a diverse top list: a near-duplicate of a chosen one is penalized
  candidates.sort((a, b) => b.score.total - a.score.total || (a._key < b._key ? -1 : a._key > b._key ? 1 : 0));
  const want = spec.candidates ?? 5;
  const chosen: typeof candidates = [];
  const pool = candidates.slice(0, 400);
  while (chosen.length < want && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const sim = chosen.reduce((m, o) => Math.max(m, similarity(c, o)), 0);
      const val = c.score.total - 0.25 * sim;
      if (val > bestVal + 1e-12) {
        bestVal = val;
        bestIdx = i;
      }
    });
    chosen.push(pool.splice(bestIdx, 1)[0]!);
  }
  const final = chosen.map((c, i) => {
    const { _key, ...rest } = c;
    void _key;
    return renumber(rest, i + 1);
  });
  return { ok: true, candidates: final, considered };
}

function similarity(a: PhraseCandidate, b: PhraseCandidate): number {
  const pa = a.choices.pitches.map(midi);
  const pb = b.choices.pitches.map(midi);
  const samePitch = pa.length === pb.length ? pa.filter((m, i) => m === pb[i]).length / pa.length : 0;
  const sameRhythm = a.choices.rhythm.id === b.choices.rhythm.id ? 1 : 0;
  return 0.5 * samePitch + 0.5 * sameRhythm;
}

/** Candidate ids and note ids are numbered per result, so they are stable and readable. */
function renumber(c: PhraseCandidate, n: number): PhraseCandidate {
  return { ...c, id: `phrase-${n}` };
}

function buildCandidate(
  spec: PhraseSpec,
  prog: readonly ProgressionChord[],
  frame: MetricFrame,
  plan: RhythmPlan,
  before: readonly Pitch[],
  target: Pitch,
  targetLabel: string,
  targetChordIndex: number,
  arrival: Fraction,
  outlineCount: number,
  O: { label: string; description: OpDescription; segments?: { count: number; chordIndex: number; label: string; description: OpDescription }[] },
  E: Variant | null,
  finger: Fingering,
  targetEntry: ProgressionChord,
  template?: PhraseCandidate,
): PhraseCandidate & { _key: string } {
  const events: LineEvent[] = [];
  const hits: LineNote[] = [];
  let ni = 0;
  let ri = 0;
  const idOf = (i: number) => `n-mel-${i + 1}`;
  const segments = O.segments ?? (outlineCount ? [{ count: outlineCount, chordIndex: targetChordIndex - 1, label: O.label, description: O.description }] : []);
  const segGestureId = (si: number): string => (segments.length > 1 && si < segments.length - 1 ? `g-outline-lead${segments.length > 2 ? si + 1 : ""}` : "g-outline");
  const hitRoles: { gesture: "outline" | "embellishment" | "target"; role: string; gid?: string }[] = [
    ...segments.flatMap((sg, si) => Array.from({ length: sg.count }, () => ({ gesture: "outline" as const, role: "arpeggio-tone", gid: segGestureId(si) }))),
    ...(E ? E.roles.map((role) => ({ gesture: "embellishment" as const, role })) : []),
  ];
  const tplNotes = template ? template.events.filter(isNote) : [];

  const mk = (rawPitch: Pitch, onset: Fraction, duration: Fraction, info: { gesture: "outline" | "embellishment" | "target"; role: string; gid?: string }, index: number): LineNote => {
    const entry = chordAt(prog, onset) ?? targetEntry;
    const deg = classifyPitch(entry.chord, rawPitch);
    // a chord tone is spelled the way its chord spells it (an Eb, not a D#, over Cm7)
    const pitch = deg && deg.kind === "chord-tone" && formatPitch(rawPitch).replace(/-?\d+$/, "") !== formatNote(deg.note) ? pitchFromMidi(midi(rawPitch), deg.note) : rawPitch;
    const mp = metricPosition(onset, frame);
    const harmonic = deg ? [deg.role] : [];
    const tpl = index < tplNotes.length ? tplNotes[index] : undefined;
    const structural = tpl ? [...tpl.functions.structural] : info.gesture === "target" ? ["target"] : info.gesture === "outline" ? ["outline"] : [E?.label.includes("enclosure") ? "enclosure-member" : E?.label.includes("scale run") ? "run-note" : "approach-note"];
    const melodic = tpl ? [...tpl.functions.melodic] : info.gesture === "target" ? ["arrival"] : [info.role];
    const functions: NoteFunctions = { harmonic, melodic, metric: mp.label, structural };
    return { kind: "note", id: idOf(index), pitch, onset, duration, accent: mp.accent, functions, position: finger.positions[index]!, gesture: tpl?.gesture ?? info.gid ?? (info.gesture === "target" ? "g-target" : info.gesture === "outline" ? "g-outline" : "g-embellishment") };
  };

  for (const slot of plan.slots) {
    const onset = fadd(spec.start, slot.offset);
    if (slot.rest) {
      events.push({ kind: "rest", id: `r-mel-${ri++ + 1}`, onset, duration: slot.duration });
      continue;
    }
    const note = mk(before[ni]!, onset, slot.duration, hitRoles[ni] ?? { gesture: "outline", role: "arpeggio-tone" }, ni);
    hits.push(note);
    events.push(note);
    ni++;
  }
  const tDuration = spec.target.duration ?? fsub(fadd(targetEntry.onset, targetEntry.duration), arrival);
  const tNote = mk(target, arrival, tDuration, { gesture: "target", role: "arrival" }, before.length);
  hits.push(tNote);
  events.push(tNote);

  // gestures: each records the operations that built it (a rhythm-only transform keeps the template's)
  const gestures: GestureRecord[] = template ? [...template.gestures] : [];
  const embIds = hits.slice(outlineCount, before.length).map((n) => n.id);
  if (!template) {
    let at = 0;
    segments.forEach((sg, si) => {
      const ids = hits.slice(at, at + sg.count).map((n) => n.id);
      at += sg.count;
      gestures.push({
        id: segGestureId(si),
        kind: "arpeggiation",
        notes: ids,
        steps: [{ op: sg.description.op, params: { ...sg.description.params }, outputs: ids }],
        params: { chord: prog[sg.chordIndex]?.chord.symbol ?? "" },
      });
    });
  }
  if (!template && E && embIds.length) {
    gestures.push({
      id: "g-embellishment",
      kind: E.label.includes("enclosure") ? "enclosure" : E.label.includes("scale run") ? "scalar-run" : "approach",
      notes: embIds,
      target: "tg-1",
      steps: [
        { op: "target", params: { degree: targetLabel }, inputs: ["tg-1"], outputs: [tNote.id] },
        { op: E.description.op, params: { ...E.description.params }, inputs: [tNote.id], outputs: embIds },
      ],
      params: { label: E.label },
    });
  }
  if (!template) gestures.push({ id: "g-target", kind: "target-arrival", notes: [tNote.id], target: "tg-1", steps: [{ op: "arrive", params: { degree: targetLabel, chord: targetEntry.chord.symbol }, outputs: [tNote.id] }], params: {} });

  const score = scoreCandidate(spec, hits, plan, finger);
  const pitchesAll = [...before, target];
  const key = `${pitchesAll.map(midi).join(",")}|${plan.id}`;
  return {
    id: "phrase",
    events,
    gestures,
    targetNote: tNote.id,
    score,
    summary: template ? `${template.summary} (new rhythm)` : [outlineCount ? O.label : null, E ? E.label : null, `to ${targetLabel} of ${targetEntry.chord.symbol} (${formatPitch(target)})`].filter(Boolean).join(" · "),
    choices: { rhythm: plan, pitches: pitchesAll, outline: template ? template.choices.outline : outlineCount ? O.label : "none", embellishment: template ? template.choices.embellishment : E ? E.label : "none" },
    _key: key,
  };
}

function scoreCandidate(spec: PhraseSpec, notes: readonly LineNote[], plan: RhythmPlan, finger: Fingering): Score {
  const parts: ScorePart[] = [];
  const target = notes[notes.length - 1]!;
  const body = notes.slice(0, -1);

  // structure: strong-beat notes are chord tones; the target lands on a strong position
  const strong = body.filter((n) => n.accent >= 2);
  const strongChordTones = strong.filter((n) => n.functions.harmonic.length > 0).length;
  const strongShare = strong.length ? strongChordTones / strong.length : 1;
  const arrivalAccent = clamp01(target.accent / 3);
  parts.push({
    name: "structural coherence",
    value: 0.6 * strongShare + 0.4 * (0.4 + 0.6 * arrivalAccent),
    weight: 0.25,
    why: `${strongChordTones}/${strong.length} strong-beat notes are chord tones; the target arrives on a ${target.functions.metric}`,
  });

  // continuity: mostly small moves, few big leaps
  const ms = notes.map((n) => midi(n.pitch));
  const moves = ms.slice(1).map((m, i) => Math.abs(m - ms[i]!));
  const stepShare = moves.length ? moves.filter((d) => d <= 2).length / moves.length : 1;
  const leapPenalty = moves.length ? moves.reduce((a, d) => a + Math.max(0, d - 4), 0) / (moves.length * 8) : 0;
  parts.push({ name: "melodic continuity", value: clamp01(0.6 * stepShare + 0.4 * (1 - leapPenalty)), weight: 0.2, why: `${Math.round(stepShare * 100)}% of moves are steps; leaps cost ${leapPenalty.toFixed(2)}` });

  // target alignment: the last move into the target is a step, and the approach notes are lighter than the arrival
  const lastMove = moves.length ? moves[moves.length - 1]! : 0;
  const approachGroup = body.filter((n) => n.functions.structural.some((s) => s === "enclosure-member" || s === "approach-note"));
  const lighter = approachGroup.length ? approachGroup.filter((n) => n.accent < target.accent).length / approachGroup.length : 1;
  parts.push({
    name: "target alignment",
    value: clamp01((lastMove === 0 ? 0.3 : lastMove <= 2 ? 1 : lastMove <= 4 ? 0.6 : 0.2) * 0.6 + 0.4 * lighter),
    weight: 0.25,
    why: `the final move into the target is ${lastMove} semitone${lastMove === 1 ? "" : "s"}; ${approachGroup.length ? `${Math.round(lighter * 100)}% of approach notes are metrically lighter than the arrival` : "no approach notes"}`,
  });

  // rhythmic variety: different durations, not all the same
  const durs = new Set(notes.map((n) => fstr(n.duration)));
  const varietyTarget = Math.min(3, notes.length);
  parts.push({ name: "rhythmic variety", value: clamp01(durs.size / varietyTarget), weight: 0.1, why: `${durs.size} distinct note length${durs.size === 1 ? "" : "s"}` });

  // practicality
  const perNote = finger.cost / Math.max(1, notes.length);
  parts.push({ name: "instrumental practicality", value: clamp01(1 - perNote / 4), weight: 0.1, why: `hand-movement cost ${perNote.toFixed(2)} per note on the fretboard` });

  // optional preferences
  const soft = spec.soft ?? {};
  const prefs: ScorePart[] = [];
  const net = ms[ms.length - 1]! - ms[0]!;
  if (soft.direction) {
    const c = contourOf(notes);
    const v = soft.direction === "ascending" ? (net > 0 ? 1 : 0) : soft.direction === "descending" ? (net < 0 ? 1 : 0) : c.highest > 0 && c.highest < notes.length - 1 ? 1 : 0.2;
    prefs.push({ name: "direction preference", value: v, weight: 0.05, why: `${soft.direction} requested; net movement ${net} semitones` });
  }
  if (soft.stepwise !== undefined) prefs.push({ name: "stepwise preference", value: clamp01(1 - Math.abs(stepShare - soft.stepwise)), weight: 0.05, why: `${Math.round(stepShare * 100)}% steps vs ${Math.round(soft.stepwise * 100)}% wanted` });
  if (soft.repetition !== undefined) {
    const rep = moves.length ? moves.filter((d) => d === 0).length / moves.length : 0;
    prefs.push({ name: "repetition preference", value: clamp01(1 - Math.abs(rep - soft.repetition)), weight: 0.05, why: `${Math.round(rep * 100)}% repeated notes vs ${Math.round(soft.repetition * 100)}% wanted` });
  }
  const intent = spec.rhythm ?? {};
  if (intent.syncopation !== undefined) prefs.push({ name: "syncopation preference", value: clamp01(1 - Math.abs(syncopationOf(plan) - intent.syncopation)), weight: 0.05, why: `${Math.round(syncopationOf(plan) * 100)}% syncopated gestures vs ${Math.round(intent.syncopation * 100)}% wanted` });
  if (intent.density !== undefined) {
    const per = (plan.hits + 1) / (fnum(fsub(fadd(notes[notes.length - 1]!.onset, frac(0)), notes[0]!.onset)) * 4 || 1);
    prefs.push({ name: "density preference", value: clamp01(1 - Math.abs(per - intent.density) / Math.max(1, intent.density)), weight: 0.05, why: `${per.toFixed(1)} notes per beat vs ${intent.density} wanted` });
  }
  const all = [...parts, ...prefs];
  const wsum = all.reduce((a, p) => a + p.weight, 0);
  const total = all.reduce((a, p) => a + p.value * p.weight, 0) / wsum;
  return { total: Math.round(total * 1000) / 1000, parts: all, disclaimer: SCORE_DISCLAIMER };
}
