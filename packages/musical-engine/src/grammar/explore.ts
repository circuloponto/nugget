/**
 * Exploration: a small set of CONTRASTING phrases over one harmonic context.
 *
 * The earlier generator (`generatePhrase`) answers "the best few ways to reach THIS target with THIS
 * strategy". Asked for more, it returns the same idea again, because the ranking is one scalar that
 * saturates and a rhythm-only change counted as a different candidate. Exploration changes the question:
 *
 *   1. A `GenerationSpace` has independent dimensions: target (degree and octave), melodic and harmonic
 *      strategy, contour, rhythmic character, density and phrase length. Each is a list; locking one is
 *      a list of one.
 *   2. Cells of that space (musical INTENTIONS) are sampled with a seeded, balanced sampler, so every
 *      target slot and every value of every dimension is visited, in a reproducible order.
 *   3. Each intention is realised by the existing grammar (`generatePhrase`, restricted to that intention)
 *      into at most two candidates. Rhythm is part of the intention: its character is a hard requirement
 *      on the rhythm plan, chosen for exactly the notes the pitch material needs.
 *   4. Every candidate is verified BEFORE ranking: a valid MusicIR document, hard constraints re-measured
 *      independently, exact arrival, no gaps or overlaps.
 *   5. Selection is by distance, not score: exact duplicates go, near duplicates (a distance below a
 *      threshold, measured over target, register, structure, contour, rhythm and pitch material) go,
 *      then candidates are chosen greedily to cover new ground. If fewer than `count` candidates are
 *      genuinely distinct, fewer are returned. Results are never padded.
 *
 * No licks are stored: every phrase is built from chords, operations and rhythmic gestures, and the
 * seed only chooses WHICH intentions are visited, never what a phrase is.
 */
import type { Tuning } from "../instrument/fretboard";
import { midi, pitchClass, formatPitch, type Pitch } from "../theory/pitch";
import { fadd, fcmp, fnum, frac, fstr, fsub, type Fraction } from "../time/rational";
import { validateMusicIR } from "../ir/validate";
import { chordDegrees, extensionDegrees, hasDegree } from "./chords";
import { phraseToIR } from "./document";
import { contourClassOf, contourShape, notesOf, type ContourClass } from "./line";
import { type OutlineSpec, type PhraseCandidate, type PhraseSpec, type ProgressionChord, type EmbellishmentSpec, generatePhrase } from "./phrase";
import type { PitchSpace } from "./operations";
import { rhythmTraits, type RhythmIntent, type RhythmPlan } from "./rhythmic";

// ── the dimensions ────────────────────────────────────────────────────────
export type Band = "low" | "mid" | "high";
/** The MIDI window a target pitch must lie in for each octave band (12 semitones each, so a degree has at most one pitch per band). */
export const BANDS: Readonly<Record<Band, readonly [number, number]>> = { low: [52, 63], mid: [64, 75], high: [76, 87] };
export const BAND_NAMES: readonly Band[] = ["low", "mid", "high"];

export type Density = "sparse" | "medium" | "busy";
export const DENSITIES: readonly Density[] = ["sparse", "medium", "busy"];
const DENSITY_VALUE: Record<Density, number> = { sparse: 1, medium: 2, busy: 3 };

export type Length = "short" | "standard" | "long";
export const LENGTHS: readonly Length[] = ["short", "standard", "long"];

export interface RhythmCharacter {
  readonly id: string;
  readonly name: string;
  /** Hard requirements on the rhythm plan (tags it must or must not contain, silence at the start or before the target). */
  readonly intent: RhythmIntent;
}

/** Rhythmic character is a hard requirement on the plan, so a "triplet" candidate really contains triplets. */
export const RHYTHM_CHARACTERS: readonly RhythmCharacter[] = [
  { id: "flowing", name: "flowing, even", intent: { feel: "straight", rests: false, forbid: ["dotted", "syncopated", "triplet"] } },
  { id: "lilting", name: "dotted, lilting", intent: { require: ["dotted"], forbid: ["triplet"] } },
  { id: "syncopated", name: "syncopated", intent: { require: ["syncopated"], forbid: ["triplet"] } },
  { id: "triplet", name: "triplet feel", intent: { require: ["triplet"] } },
  { id: "breathing", name: "phrased with rests", intent: { require: ["rest"] } },
  { id: "hesitating", name: "delayed resolution", intent: { endsWithRest: true } },
  { id: "driving", name: "driving, dense", intent: { require: ["dense"], rests: false } },
  { id: "broad", name: "broad, long notes", intent: { require: ["sparse"], forbid: ["dense"] } },
];

export interface Strategy {
  readonly id: string;
  readonly name: string;
  /** What the harmony is doing: which tones outline the chord, or none. */
  readonly harmonic: string;
  /** The melodic shape of the approach, for grouping and display. */
  readonly family: string;
  readonly outline: { readonly direction: OutlineSpec["direction"]; readonly degrees?: readonly string[] } | null;
  /** Also arpeggiate the chord before the outline's chord (a two-chord line; needs the long length). */
  readonly lead?: { readonly direction: OutlineSpec["direction"] };
  readonly embellishment: EmbellishmentSpec;
}

/** Melodic and harmonic strategies, all expressed in the grammar's operations. None is a stored phrase. */
export const STRATEGIES: readonly Strategy[] = [
  { id: "arp-up-enclosure", name: "rising arpeggio, chromatic enclosure", harmonic: "7th-chord arpeggio", family: "arpeggio+enclosure", outline: { direction: "up" }, embellishment: { kind: "enclosure", step: "chromatic", side: "any" } },
  { id: "arp-down-diatonic-enclosure", name: "falling arpeggio, diatonic enclosure", harmonic: "7th-chord arpeggio", family: "arpeggio+enclosure", outline: { direction: "down" }, embellishment: { kind: "enclosure", step: "diatonic", side: "any" } },
  { id: "arp-mixed-approach-below", name: "mixed arpeggio, chromatic approach from below", harmonic: "7th-chord arpeggio", family: "arpeggio+approach", outline: { direction: "mixed" }, embellishment: { kind: "approach", step: "chromatic", side: "below", count: 1 } },
  { id: "arp-updown-approach-above", name: "arch arpeggio, diatonic approach from above", harmonic: "7th-chord arpeggio", family: "arpeggio+approach", outline: { direction: "updown" }, embellishment: { kind: "approach", step: "diatonic", side: "above", count: 1 } },
  { id: "shell-mixed-enclosure", name: "shell tones (root, 3rd, 7th), mixed enclosure", harmonic: "shell tones 1-3-7", family: "shell+enclosure", outline: { direction: "any", degrees: ["1", "3", "7"] }, embellishment: { kind: "enclosure", step: "mixed", side: "any" } },
  { id: "upper-structure-enclosure", name: "upper structure (3-5-7-9), chromatic enclosure", harmonic: "upper structure 3-5-7-9", family: "upper+enclosure", outline: { direction: "up", degrees: ["3", "5", "7", "9"] }, embellishment: { kind: "enclosure", step: "chromatic", side: "any" } },
  { id: "guide-tones-approach", name: "guide tones (3rd, 7th), chromatic approach", harmonic: "guide tones 3-7", family: "guide+approach", outline: { direction: "any", degrees: ["3", "7"] }, embellishment: { kind: "approach", step: "chromatic", side: "any", count: 1 } },
  { id: "scale-run", name: "scale run into the target", harmonic: "scalar line through the chord", family: "scalar", outline: null, embellishment: { kind: "run", step: "diatonic" } },
  { id: "enclosure-direct", name: "enclosure alone", harmonic: "none: direct surround", family: "enclosure-only", outline: null, embellishment: { kind: "enclosure", step: "chromatic", side: "any" } },
  { id: "two-chord-arpeggios", name: "arpeggio of the ii, then of the V, chromatic enclosure", harmonic: "both chords outlined", family: "two-chord", outline: { direction: "any" }, lead: { direction: "any" }, embellishment: { kind: "enclosure", step: "chromatic", side: "any" } },
  { id: "two-chord-approach", name: "rising ii arpeggio, falling V arpeggio, approach below", harmonic: "both chords outlined", family: "two-chord", outline: { direction: "down" }, lead: { direction: "up" }, embellishment: { kind: "approach", step: "diatonic", side: "below", count: 1 } },
];

export const CONTOUR_CHOICES: readonly (ContourClass | "any")[] = ["any", "ascending", "descending", "arch", "valley"];

// ── the space ─────────────────────────────────────────────────────────────
export type TargetChoice =
  | { readonly mode: "explore"; /** Degrees to explore. Default: the chord tones and the natural extensions (9, 13). */ readonly degrees?: readonly string[] }
  | { readonly mode: "focus"; readonly degree: string; /** Octave bands to place it in. Default: all. */ readonly bands?: readonly Band[] };

export interface GenerationSpace {
  readonly progression: readonly ProgressionChord[];
  readonly space: PitchSpace;
  readonly targets: TargetChoice;
  /** Overall register of every note, as MIDI numbers. */
  readonly register: readonly [number, number];
  readonly bands: readonly Band[];
  readonly strategies: readonly string[];
  readonly contours: readonly (ContourClass | "any")[];
  readonly rhythms: readonly string[];
  readonly densities: readonly Density[];
  readonly lengths: readonly Length[];
  readonly hard: { readonly maxLeap?: number; readonly fretRange?: readonly [number, number]; readonly maxFretShift?: number };
  /** How many candidates to return at most. Default 7. */
  readonly count: number;
  /** Chooses which intentions are visited; the same seed gives the same result. Default 1. */
  readonly seed: number;
  /** Intentions to try. Default 100. */
  readonly intentions: number;
  /** Candidates closer than this (0..1) to one already chosen are near duplicates. Default 0.22. */
  readonly distinctness: number;
  /** Hold parts of a chosen phrase fixed. */
  readonly locks?: {
    /** The target's exact pitch (MIDI), so both degree and octave are kept. */
    readonly targetPitch?: number;
    /** Exactly this rhythm. */
    readonly rhythmPlan?: RhythmPlan;
    /** Exactly this up/down contour shape. */
    readonly contourShape?: string;
  };
  readonly tuning?: Tuning;
  readonly fretCount?: number;
}

export const DEFAULT_COUNT = 7;
export const DEFAULT_DISTINCTNESS = 0.22;

/** Degrees explored by default on the target chord: its tones and its natural (not altered) extensions. */
export function exploreDegrees(progression: readonly ProgressionChord[]): string[] {
  const chord = progression[progression.length - 1]?.chord;
  if (!chord) return [];
  return [...chordDegrees(chord, false).map((d) => d.label), ...extensionDegrees(chord).filter((d) => d.kind === "extension").map((d) => d.label)];
}

export function defaultGenerationSpace(progression: readonly ProgressionChord[], space: PitchSpace, over: Partial<GenerationSpace> = {}): GenerationSpace {
  return {
    progression,
    space,
    targets: { mode: "explore" },
    register: [52, 84],
    bands: BAND_NAMES,
    strategies: STRATEGIES.map((s) => s.id),
    contours: CONTOUR_CHOICES,
    rhythms: RHYTHM_CHARACTERS.map((r) => r.id),
    densities: DENSITIES,
    lengths: LENGTHS,
    hard: { maxLeap: 9, fretRange: [0, 15], maxFretShift: 5 },
    count: DEFAULT_COUNT,
    seed: 1,
    intentions: 100,
    distinctness: DEFAULT_DISTINCTNESS,
    ...over,
  };
}

export interface Intention {
  readonly degree: string;
  readonly band: Band;
  readonly strategy: string;
  readonly rhythm: string;
  readonly contour: ContourClass | "any";
  readonly density: Density;
  readonly length: Length;
}

// ── measured traits (what a phrase IS, not what it was asked to be) ───────
export interface Traits {
  readonly targetDegree: string;
  readonly targetPitch: number;
  readonly targetName: string;
  readonly band: Band;
  readonly strategy: string;
  readonly family: string;
  readonly harmonic: string;
  readonly embellishment: string;
  readonly contour: ContourClass;
  readonly shape: string;
  readonly rhythmTags: readonly string[];
  readonly rhythmCharacter: string;
  readonly rhythmSignature: string;
  /** Onsets of the sounding notes relative to the phrase start, as exact fractions. */
  readonly onsets: readonly string[];
  readonly noteCount: number;
  readonly notesPerBeat: number;
  readonly density: Density;
  readonly length: Length;
  readonly gestureKinds: readonly string[];
  readonly pitchClasses: readonly number[];
}

export interface ExploredPhrase extends PhraseCandidate {
  /** The spec that produced it: a phrase can be turned into a document or regenerated with part of it fixed. */
  readonly spec: PhraseSpec;
  readonly intention: Intention;
  readonly traits: Traits;
  /** Short readable descriptors, for display. */
  readonly chips: readonly string[];
  /** What sets it apart from the others returned together with it. */
  readonly distinguishing: readonly string[];
}

export interface DistanceBreakdown {
  readonly target: number;
  readonly register: number;
  readonly structure: number;
  readonly contour: number;
  readonly rhythm: number;
  readonly pitch: number;
  readonly shape: number;
  readonly total: number;
}

const WEIGHTS = { target: 0.2, register: 0.08, structure: 0.2, contour: 0.14, rhythm: 0.22, pitch: 0.1, shape: 0.06 } as const;

const jaccard = <T>(a: readonly T[], b: readonly T[]): number => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : 1 - inter / union;
};

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

/**
 * How different two phrases are, 0 (identical) to 1, as a weighted sum over six independent aspects.
 * A rhythm-only change moves the rhythm term only; a change of octave moves target and register but not
 * the contour: that is the point, since "different" is judged per aspect.
 */
export function phraseDistance(a: Traits, b: Traits): DistanceBreakdown {
  const target = a.targetDegree !== b.targetDegree ? 1 : a.targetPitch !== b.targetPitch ? 0.5 : 0;
  const register = a.band === b.band ? 0 : Math.abs(BAND_NAMES.indexOf(a.band) - BAND_NAMES.indexOf(b.band)) === 1 ? 0.5 : 1;
  const structure = jaccard([a.family, a.harmonic, a.embellishment, ...a.gestureKinds], [b.family, b.harmonic, b.embellishment, ...b.gestureKinds]);
  const contour = (a.contour === b.contour ? 0 : 1) * 0.6 + 0.4 * (editDistance(a.shape, b.shape) / Math.max(1, a.shape.length, b.shape.length));
  const rhythm =
    0.5 * jaccard(a.onsets, b.onsets) +
    0.3 * jaccard(a.rhythmSignature.split(">"), b.rhythmSignature.split(">")) +
    0.2 * jaccard(a.rhythmTags, b.rhythmTags);
  const pitch = jaccard(a.pitchClasses, b.pitchClasses);
  const shape = a.shape === b.shape ? 0 : (a.density === b.density ? 0 : 0.5) + (a.length === b.length ? 0 : 0.5);
  const total = WEIGHTS.target * target + WEIGHTS.register * register + WEIGHTS.structure * structure + WEIGHTS.contour * contour + WEIGHTS.rhythm * rhythm + WEIGHTS.pitch * pitch + WEIGHTS.shape * shape;
  return { target, register, structure, contour, rhythm, pitch, shape, total };
}

// ── a seeded generator: the only source of "randomness" ───────────────────
/** mulberry32: a small deterministic PRNG. The same seed always gives the same stream. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: readonly T[], rnd: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The least-used value so far; ties broken by the seeded stream. Keeps every dimension's marginal balanced. */
function pickBalanced<T extends string>(list: readonly T[], used: Map<string, number>, rnd: () => number): T {
  const min = Math.min(...list.map((v) => used.get(v) ?? 0));
  const tied = list.filter((v) => (used.get(v) ?? 0) === min);
  const v = tied[Math.floor(rnd() * tied.length)]!;
  used.set(v, (used.get(v) ?? 0) + 1);
  return v;
}

// ── realising one intention ───────────────────────────────────────────────
const countsFor = (d: Density, locked: boolean): number[] => (locked ? [1, 2, 3, 4, 5, 6, 7] : d === "sparse" ? [2, 3] : d === "medium" ? [3, 4] : [5, 6]);
const leadCountsFor = (d: Density, locked: boolean): number[] => (locked ? [1, 2, 3, 4] : d === "sparse" ? [2] : d === "medium" ? [2, 3] : [3, 4]);

/** Where a phrase of this length begins: partway through the chord before the target's, or through the one before that. */
function startFor(length: Length, prog: readonly ProgressionChord[]): Fraction | null {
  const last = prog.length - 1;
  const half = (c: ProgressionChord): Fraction => fadd(c.onset, frac(c.duration.num, c.duration.den * 2));
  const prev = prog[last - 1];
  if (!prev) return null;
  if (length === "standard") return prev.onset;
  if (length === "short") return half(prev);
  const lead = prog[last - 2];
  return lead ? half(lead) : null;
}

const strategyById = (id: string): Strategy | undefined => STRATEGIES.find((s) => s.id === id);
const characterById = (id: string): RhythmCharacter | undefined => RHYTHM_CHARACTERS.find((r) => r.id === id);

function applicable(strategy: Strategy, length: Length, prog: readonly ProgressionChord[]): boolean {
  if (strategy.lead) return length === "long" && prog.length >= 3;
  return true;
}

/** The spec of one intention, or null when the space cannot express it (a long phrase needs a chord before the V). */
export function specForIntention(gs: GenerationSpace, ix: Intention): PhraseSpec | null {
  const strategy = strategyById(ix.strategy);
  const character = characterById(ix.rhythm);
  const prog = gs.progression;
  const targetIndex = prog.length - 1;
  const start = startFor(ix.length, prog);
  if (!strategy || !character || !start || targetIndex < 1) return null;
  if (!applicable(strategy, ix.length, prog)) return null;
  if (!hasDegree(prog[targetIndex]!.chord, ix.degree)) return null;

  const [rlo, rhi] = gs.register;
  const band = BANDS[ix.band];
  const lo = Math.max(rlo, band[0] - 9);
  const hi = Math.min(rhi, band[1] + 7);
  const tlo = Math.max(band[0], rlo);
  const thi = Math.min(band[1], rhi);
  const lockedRhythm = gs.locks?.rhythmPlan !== undefined;
  const locks = gs.locks;
  const tRange: readonly [number, number] = locks?.targetPitch !== undefined ? [locks.targetPitch, locks.targetPitch] : [tlo, thi];
  if (tRange[0] > tRange[1] || tRange[1] < lo || tRange[0] > hi) return null;

  const outline: OutlineSpec | null = strategy.outline
    ? {
        direction: strategy.outline.direction,
        counts: countsFor(ix.density, lockedRhythm),
        chordIndex: targetIndex - 1,
        ...(strategy.outline.degrees ? { degrees: strategy.outline.degrees } : {}),
        ...(strategy.lead ? { lead: { chordIndex: targetIndex - 2, direction: strategy.lead.direction, counts: leadCountsFor(ix.density, lockedRhythm) } } : {}),
      }
    : null;
  const rhythm: RhythmIntent = { ...character.intent, density: DENSITY_VALUE[ix.density] };
  const direction = ix.contour === "ascending" || ix.contour === "descending" || ix.contour === "arch" ? ix.contour : undefined;

  return {
    space: gs.space,
    progression: prog,
    start,
    target: { chordIndex: targetIndex, degree: ix.degree, range: tRange },
    outline,
    embellishment: strategy.embellishment,
    rhythm,
    hard: { register: [lo, hi], ...(gs.hard.maxLeap !== undefined ? { maxLeap: gs.hard.maxLeap } : {}), ...(gs.hard.fretRange ? { fretRange: gs.hard.fretRange } : {}), ...(gs.hard.maxFretShift !== undefined ? { maxFretShift: gs.hard.maxFretShift } : {}) },
    ...(direction ? { soft: { direction } } : {}),
    contour: {
      ...(ix.contour !== "any" ? { cls: ix.contour } : {}),
      ...(locks?.contourShape !== undefined ? { shape: locks.contourShape } : {}),
    },
    candidates: 2,
    ...(gs.tuning ? { tuning: gs.tuning } : {}),
    ...(gs.fretCount ? { fretCount: gs.fretCount } : {}),
    ...(lockedRhythm ? { fixed: { rhythm: locks!.rhythmPlan! } } : {}),
  };
}

/** Everything wrong with a candidate, measured independently of the code that built it. Empty means sound. */
export function verifyCandidate(c: PhraseCandidate, spec: PhraseSpec): string[] {
  const problems: string[] = [];
  const doc = phraseToIR(c, spec);
  for (const i of validateMusicIR(doc)) problems.push(`${i.path}: ${i.message}`);
  const notes = notesOf(c.events as never);
  const target = notes[notes.length - 1];
  if (!target || target.id !== c.targetNote) problems.push("the last note is not the target");
  const entry = spec.progression[spec.target.chordIndex]!;
  const arrival = spec.target.arrival ?? entry.onset;
  if (target && fcmp(target.onset, arrival) !== 0) problems.push(`the target arrives at ${fstr(target.onset)}, not ${fstr(arrival)}`);
  const [lo, hi] = spec.hard.register;
  for (const n of notes) if (midi(n.pitch) < lo || midi(n.pitch) > hi) problems.push(`${formatPitch(n.pitch)} is outside the register`);
  const maxLeap = spec.hard.maxLeap ?? 9;
  for (let i = 1; i < notes.length; i++) if (Math.abs(midi(notes[i]!.pitch) - midi(notes[i - 1]!.pitch)) > maxLeap) problems.push(`leap larger than ${maxLeap} before ${notes[i]!.id}`);
  let at = spec.start;
  for (const e of c.events) {
    if (fcmp(e.onset, arrival) >= 0) break;
    if (fcmp(e.onset, at) !== 0) problems.push(`gap or overlap at ${fstr(e.onset)}`);
    at = fadd(e.onset, e.duration);
  }
  if (fcmp(at, arrival) !== 0) problems.push("the phrase does not end exactly where the target arrives");
  return problems;
}

const bandOf = (m: number): Band => (m <= BANDS.low[1] ? "low" : m <= BANDS.mid[1] ? "mid" : "high");

function densityClass(perBeat: number): Density {
  return perBeat < 1.5 ? "sparse" : perBeat < 2.5 ? "medium" : "busy";
}

function rhythmCharacterOf(plan: RhythmPlan): string {
  const t = rhythmTraits(plan);
  const parts: string[] = [];
  if (t.tags.includes("triplet")) parts.push("triplets");
  if (t.tags.includes("dotted")) parts.push("dotted");
  if (t.tags.includes("syncopated")) parts.push("syncopated");
  if (t.endsWithRest) parts.push("delayed resolution");
  else if (t.tags.includes("rest")) parts.push("rests");
  if (t.startsWithRest) parts.push("late entry");
  if (t.tags.includes("dense")) parts.push("dense");
  if (t.tags.includes("unequal")) parts.push("unequal groups");
  return parts.length ? parts.join(" + ") : t.tags.includes("sparse") ? "broad" : "even";
}

export function traitsOf(c: PhraseCandidate, spec: PhraseSpec, ix: Intention, strategy: Strategy): Traits {
  const notes = notesOf(c.events as never);
  const target = notes[notes.length - 1]!;
  const pitches: Pitch[] = [...c.choices.pitches];
  const span = fsub(spec.target.arrival ?? spec.progression[spec.target.chordIndex]!.onset, spec.start);
  const beats = fnum(span) * 4;
  const perBeat = (notes.length) / (beats || 1);
  const rt = rhythmTraits(c.choices.rhythm);
  return {
    targetDegree: ix.degree,
    targetPitch: midi(target.pitch),
    targetName: formatPitch(target.pitch),
    band: bandOf(midi(target.pitch)),
    strategy: strategy.id,
    family: strategy.family,
    harmonic: strategy.harmonic,
    embellishment: c.choices.embellishment.replace(/ from (above|below)/, "").replace(/ \(\d notes\)/, "").replace(/ from [A-G][#b]*\d/, ""),
    contour: contourClassOf(pitches),
    shape: contourShape(pitches),
    rhythmTags: rt.tags,
    rhythmCharacter: rhythmCharacterOf(c.choices.rhythm),
    rhythmSignature: c.choices.rhythm.gestures.join(">") || "silence",
    onsets: notes.map((n) => fstr(fsub(n.onset, spec.start))),
    noteCount: notes.length,
    notesPerBeat: Math.round(perBeat * 100) / 100,
    density: densityClass(perBeat),
    length: ix.length,
    gestureKinds: [...new Set(c.gestures.map((g) => g.kind))].sort(),
    pitchClasses: [...new Set(pitches.map(pitchClass))].sort((x, y) => x - y),
  };
}

const ORDINAL: Record<string, string> = { "1": "root", "3": "3rd", "5": "5th", "7": "7th", "9": "9th", "13": "13th" };

function chipsOf(t: Traits): string[] {
  return [
    `target ${ORDINAL[t.targetDegree] ?? t.targetDegree} · ${t.targetName}`,
    `${t.band} register`,
    t.family.replace("+", " + ").replace("-only", " only"),
    t.contour === "level" ? "level contour" : `${t.contour} contour`,
    t.rhythmCharacter,
    `${t.noteCount} notes · ${t.density}`,
    `${t.length} length`,
  ];
}

/** For each returned phrase, what is true of it and of none of the others (or of few). */
function distinguish(list: readonly ExploredPhrase[]): string[][] {
  const dims: [string, (t: Traits) => string][] = [
    ["target", (t) => `the only one arriving on the ${ORDINAL[t.targetDegree] ?? t.targetDegree} (${t.targetName})`],
    ["octave", (t) => `the only one in the ${t.band} register`],
    ["contour", (t) => `the only ${t.contour} contour`],
    ["strategy", (t) => `the only ${t.family.replace("+", " + ")} strategy`],
    ["rhythm", (t) => `the only ${t.rhythmCharacter} rhythm`],
    ["length", (t) => `the only ${t.length} phrase`],
    ["density", (t) => `the only ${t.density} one`],
  ];
  const key = (name: string, t: Traits): string =>
    name === "target" ? t.targetDegree : name === "octave" ? t.band : name === "contour" ? t.contour : name === "strategy" ? t.family : name === "rhythm" ? t.rhythmCharacter : name === "length" ? t.length : t.density;
  return list.map((c) =>
    dims
      .filter(([name]) => list.filter((o) => key(name, o.traits) === key(name, c.traits)).length === 1)
      .map(([, say]) => say(c.traits)),
  );
}

// ── the result ────────────────────────────────────────────────────────────
export interface ExploreStats {
  readonly seed: number;
  readonly intentionsTried: number;
  readonly intentionsReachable: number;
  readonly poolSize: number;
  readonly rejectedInvalid: number;
  readonly exactDuplicates: number;
  readonly nearDuplicates: number;
  readonly selected: number;
  readonly threshold: number;
  readonly minDistance: number;
  readonly meanDistance: number;
  readonly coverage: { readonly targets: number; readonly registers: number; readonly strategies: number; readonly rhythms: number; readonly contours: number; readonly lengths: number; readonly densities: number };
  /** Set when fewer than requested were returned, saying why. */
  readonly note?: string;
}

export type ExploreResult = { readonly ok: true; readonly candidates: readonly ExploredPhrase[]; readonly stats: ExploreStats } | { readonly ok: false; readonly reason: string };

/** Pairwise distances and coverage of a set of phrases: the measure the tests and the UI report. */
export function measureDiversity(list: readonly { traits: Traits }[]): { min: number; mean: number; coverage: ExploreStats["coverage"]; pairs: number } {
  const ds: number[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) ds.push(phraseDistance(list[i]!.traits, list[j]!.traits).total);
  const count = (f: (t: Traits) => string) => new Set(list.map((c) => f(c.traits))).size;
  return {
    min: ds.length ? Math.min(...ds) : 1,
    mean: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 1,
    pairs: ds.length,
    coverage: {
      targets: count((t) => t.targetDegree),
      registers: count((t) => t.band),
      strategies: count((t) => t.family),
      rhythms: count((t) => t.rhythmCharacter),
      contours: count((t) => t.contour),
      lengths: count((t) => t.length),
      densities: count((t) => t.density),
    },
  };
}

/** Explore the space: a handful of contrasting, verified phrases. Deterministic for a given seed. */
export function explorePhrases(gs: GenerationSpace): ExploreResult {
  const prog = gs.progression;
  if (prog.length < 2) return { ok: false, reason: "Exploration needs at least two chords: one to arrive on and one to lead into it." };
  const targetChord = prog[prog.length - 1]!.chord;
  const degrees = gs.targets.mode === "focus" ? [gs.targets.degree] : (gs.targets.degrees ?? exploreDegrees(prog)).filter((d) => hasDegree(targetChord, d));
  if (degrees.length === 0) return { ok: false, reason: `${targetChord.symbol} has none of the requested target degrees.` };
  if (gs.targets.mode === "focus" && !hasDegree(targetChord, gs.targets.degree)) return { ok: false, reason: `${targetChord.symbol} has no degree "${gs.targets.degree}".` };
  const bands = (gs.targets.mode === "focus" && gs.targets.bands ? gs.targets.bands : gs.bands).filter((b) => BANDS[b][1] >= gs.register[0] && BANDS[b][0] <= gs.register[1]);
  if (bands.length === 0) return { ok: false, reason: "The register excludes every octave band." };
  const strategies = gs.strategies.filter((s) => strategyById(s));
  const rhythms = gs.rhythms.filter((r) => characterById(r));
  if (strategies.length === 0 || rhythms.length === 0) return { ok: false, reason: "No melodic strategy or rhythmic character is selected." };
  if (gs.lengths.length === 0 || gs.contours.length === 0 || gs.densities.length === 0) return { ok: false, reason: "A dimension of the space is empty." };

  const rnd = seededRandom(gs.seed);
  const slots = shuffled(degrees.flatMap((degree) => bands.map((band) => ({ degree, band }))), rnd);
  const used = {
    strategy: new Map<string, number>(),
    rhythm: new Map<string, number>(),
    contour: new Map<string, number>(),
    density: new Map<string, number>(),
    length: new Map<string, number>(),
  };

  type Pooled = ExploredPhrase;
  const pool: Pooled[] = [];
  let tried = 0;
  let reachable = 0;
  let invalid = 0;
  const maxAttempts = gs.intentions * 2;
  let made = 0;
  for (let attempt = 0; attempt < maxAttempts && made < gs.intentions; attempt++) {
    const slot = slots[attempt % slots.length]!;
    const length = pickBalanced(gs.lengths, used.length, rnd);
    const usable = strategies.filter((id) => applicable(strategyById(id)!, length, prog));
    if (usable.length === 0) continue;
    const ix: Intention = {
      degree: slot.degree,
      band: slot.band,
      strategy: pickBalanced(usable, used.strategy, rnd),
      rhythm: pickBalanced(rhythms, used.rhythm, rnd),
      contour: pickBalanced(gs.contours, used.contour, rnd),
      density: pickBalanced(gs.densities, used.density, rnd),
      length,
    };
    const spec = specForIntention(gs, ix);
    if (!spec) continue;
    tried++;
    made++;
    const r = generatePhrase(spec);
    if (!r.ok) continue;
    reachable++;
    const strategy = strategyById(ix.strategy)!;
    for (const c of r.candidates) {
      if (verifyCandidate(c, spec).length > 0) {
        invalid++;
        continue;
      }
      pool.push({ ...c, spec, intention: ix, traits: traitsOf(c, spec, ix, strategy), chips: [], distinguishing: [] });
    }
  }
  if (pool.length === 0) {
    return { ok: false, reason: "No phrase satisfies every constraint in this space (register, leap, fret window, a rhythm that fits). Loosen one of them or explore more widely." };
  }

  // exact duplicates: the same pitches at the same times
  const seen = new Set<string>();
  const unique: Pooled[] = [];
  for (const c of pool) {
    const k = `${c.choices.pitches.map(midi).join(",")}|${c.traits.onsets.join(",")}|${c.choices.rhythm.slots.map((s) => `${fstr(s.duration)}${s.rest ? "r" : ""}`).join(",")}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(c);
    }
  }
  const exact = pool.length - unique.length;

  // greedy, coverage-first selection by distance; near duplicates are dropped, never padded back in
  const best = Math.max(...unique.map((c) => c.score.total));
  const floor = best - 0.25;
  let remaining = unique.filter((c) => c.score.total >= floor).sort((a, b) => b.score.total - a.score.total || (a.choices.pitches.map(midi).join() < b.choices.pitches.map(midi).join() ? -1 : 1));
  const chosen: Pooled[] = [];
  let nearDup = 0;
  const tau = gs.distinctness;
  const coverageKeys = (t: Traits): string[] => [`d:${t.targetDegree}`, `b:${t.band}`, `f:${t.family}`, `r:${t.rhythmCharacter}`, `c:${t.contour}`, `l:${t.length}`, `n:${t.density}`];
  const covered = new Set<string>();
  while (chosen.length < gs.count && remaining.length > 0) {
    let pick = -1;
    let pickValue = -Infinity;
    const keep: Pooled[] = [];
    for (const c of remaining) {
      const minD = chosen.length ? Math.min(...chosen.map((o) => phraseDistance(c.traits, o.traits).total)) : 1;
      if (chosen.length && minD < tau) {
        nearDup++;
        continue; // a near duplicate of something already chosen: gone for good
      }
      keep.push(c);
      const gain = coverageKeys(c.traits).filter((k) => !covered.has(k)).length;
      const value = chosen.length === 0 ? c.score.total : minD + 0.08 * gain + 0.5 * (c.score.total - best);
      if (value > pickValue + 1e-12) {
        pickValue = value;
        pick = keep.length - 1;
      }
    }
    remaining = keep;
    if (pick < 0) break;
    const [c] = remaining.splice(pick, 1);
    chosen.push(c!);
    coverageKeys(c!.traits).forEach((k) => covered.add(k));
  }

  const dist = measureDiversity(chosen);
  const dis = distinguish(chosen);
  const final: ExploredPhrase[] = chosen.map((c, i) => ({ ...c, id: `phrase-${i + 1}`, chips: chipsOf(c.traits), distinguishing: dis[i]! }));
  const stats: ExploreStats = {
    seed: gs.seed,
    intentionsTried: tried,
    intentionsReachable: reachable,
    poolSize: pool.length,
    rejectedInvalid: invalid,
    exactDuplicates: exact,
    nearDuplicates: nearDup,
    selected: final.length,
    threshold: tau,
    minDistance: Math.round(dist.min * 1000) / 1000,
    meanDistance: Math.round(dist.mean * 1000) / 1000,
    coverage: dist.coverage,
    ...(final.length < gs.count ? { note: `Only ${final.length} genuinely distinct phrase${final.length === 1 ? "" : "s"} exist under these constraints (distance ≥ ${tau}); the list was not padded.` } : {}),
  };
  return { ok: true, candidates: final, stats };
}

// ── developing a chosen phrase ────────────────────────────────────────────
export type LockAspect = "target" | "register" | "strategy" | "rhythm" | "contour" | "density" | "length";

/**
 * A new space in which the chosen aspects of a phrase are held fixed, so exploring it produces VARIATIONS
 * of that phrase rather than unrelated ones: the target (degree and exact octave), its register band, its
 * melodic strategy, its exact rhythm, its exact contour shape, density or length.
 */
export function lockAspects(gs: GenerationSpace, c: ExploredPhrase, aspects: readonly LockAspect[], nextSeed?: number): GenerationSpace {
  const t = c.traits;
  const has = (a: LockAspect) => aspects.includes(a);
  return {
    ...gs,
    seed: nextSeed ?? gs.seed + 1,
    targets: has("target") ? { mode: "focus", degree: t.targetDegree, bands: [t.band] } : gs.targets,
    bands: has("register") || has("target") ? [t.band] : gs.bands,
    strategies: has("strategy") ? [t.strategy] : gs.strategies,
    contours: has("contour") ? [t.contour === "level" ? "any" : t.contour] : gs.contours,
    densities: has("density") ? [t.density] : gs.densities,
    lengths: has("length") || has("rhythm") ? [t.length] : gs.lengths,
    locks: {
      ...(has("target") ? { targetPitch: t.targetPitch } : {}),
      ...(has("rhythm") ? { rhythmPlan: c.choices.rhythm } : {}),
      ...(has("contour") ? { contourShape: t.shape } : {}),
    },
  };
}

