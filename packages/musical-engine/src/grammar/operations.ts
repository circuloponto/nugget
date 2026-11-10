/**
 * The grammar of melodic movement: a small vocabulary of composable operations on spelled
 * pitches. Each returns the pitches it produces AND a description of itself (`OpDescription`),
 * so a phrase can record how it was built and a user can later change one operation.
 *
 * Gestures (enclosure, arpeggiation, passing motion ...) are NOT separate algorithms: they are
 * compositions of these operations (see gestures.ts).
 *
 *   move       go by an interval, or by n scale / chromatic steps
 *   connect    fill the space between two pitches (diatonic, chromatic or chord tones)
 *   approach   reach a target from one side, by step
 *   surround   reach a target from both sides
 *   neighbor   leave a pitch by a step (the caller returns to it)
 *   repeat     the same pitch again
 *   leap       move by a larger interval
 *   transpose  / invert   transform a pitch sequence
 *   arpeggiate outline a chord as a sequence of its tones
 *
 * (hold and displace act on durations and onsets, not pitches: see line.ts.)
 */
import { MusicTheoryError } from "../errors";
import { addInterval, diatonicIndex, intervalBetween, LETTERS, midi, mod, pitchFromMidi, type Interval, type Note, type Pitch } from "../theory/pitch";
import { chordPitchesIn, type Chord } from "./chords";

export type OpParam = string | number | boolean;
export interface OpDescription {
  readonly op: string;
  readonly params: Readonly<Record<string, OpParam>>;
}
export interface OpResult {
  readonly pitches: Pitch[];
  readonly description: OpDescription;
}

export type MotionStepKind = "diatonic" | "chromatic";
export type Side = "above" | "below";

/** The diatonic collection that "diatonic step" refers to. Empty = chromatic only. */
export interface PitchSpace {
  readonly scale: readonly Note[];
}
export const CHROMATIC_ONLY: PitchSpace = { scale: [] };

const noteOfLetter = (space: PitchSpace, letterIndex: number): Note | undefined => space.scale.find((n) => n.letter === LETTERS[mod(letterIndex, 7)]);

/** Pitch at a diatonic index (octave*7 + letter) spelled as the space spells that letter. */
function pitchAtLetterIndex(index: number, space: PitchSpace): Pitch {
  const letter = LETTERS[mod(index, 7)]!;
  const spelled = noteOfLetter(space, mod(index, 7));
  return { letter, accidental: spelled?.accidental ?? 0, octave: Math.floor(index / 7) };
}

/** The next pitch of the scale strictly above/below `p` (works from pitches that are not in the scale). */
export function stepInScale(p: Pitch, direction: 1 | -1, space: PitchSpace): Pitch {
  if (space.scale.length === 0) throw new MusicTheoryError("A diatonic step needs a scale");
  let index = diatonicIndex(p);
  // start at the pitch's own letter: from an off-scale pitch such as D#, the scale's D lies below it
  for (let k = 0; k < 9; k++) {
    const candidate = pitchAtLetterIndex(index, space);
    if (direction > 0 ? midi(candidate) > midi(p) : midi(candidate) < midi(p)) return candidate;
    index += direction;
  }
  throw new MusicTheoryError("No scale step found");
}

/**
 * A semitone above or below, spelled the way tonal music spells chromatic neighbours: of the two
 * candidate spellings (the neighbouring letter, or the same letter altered) take the one with the
 * fewer accidentals. A tie goes to the raised spelling below (D# under E) and the lowered one
 * above (Eb over D). So E is surrounded by F and D#, F# is approached from F, and C from B.
 */
export function chromaticStep(p: Pitch, direction: 1 | -1): Pitch {
  const viaLetter = addInterval(p, { steps: direction, semitones: direction });
  const sameLetter: Pitch = { letter: p.letter, octave: p.octave, accidental: p.accidental + direction };
  const a = Math.abs(viaLetter.accidental);
  const b = Math.abs(sameLetter.accidental);
  if (a < b) return viaLetter;
  if (b < a) return sameLetter;
  return direction < 0 ? (viaLetter.accidental > 0 ? viaLetter : sameLetter) : viaLetter.accidental < 0 ? viaLetter : sameLetter;
}

/** One step of the given kind. */
export function stepOf(p: Pitch, direction: 1 | -1, kind: MotionStepKind, space: PitchSpace): Pitch {
  return kind === "chromatic" ? chromaticStep(p, direction) : stepInScale(p, direction, space);
}

const desc = (op: string, params: Record<string, OpParam>): OpDescription => ({ op, params });

// ── MOVE ──────────────────────────────────────────────────────────────────
export type MoveSpec =
  | { readonly interval: Interval }
  | { readonly direction: 1 | -1; readonly steps: number; readonly kind: MotionStepKind; readonly space?: PitchSpace };

/** Move by an interval, or by n steps of a kind. Returns the pitches passed through, ending at the destination. */
export function move(from: Pitch, spec: MoveSpec): OpResult {
  if ("interval" in spec) {
    return { pitches: [addInterval(from, spec.interval)], description: desc("move", { semitones: spec.interval.semitones, steps: spec.interval.steps }) };
  }
  const out: Pitch[] = [];
  let p = from;
  for (let i = 0; i < spec.steps; i++) {
    p = stepOf(p, spec.direction, spec.kind, spec.space ?? CHROMATIC_ONLY);
    out.push(p);
  }
  return { pitches: out, description: desc("move", { direction: spec.direction > 0 ? "up" : "down", count: spec.steps, kind: spec.kind }) };
}

// ── CONNECT ───────────────────────────────────────────────────────────────
export type ConnectVia = "diatonic" | "chromatic" | "chord-tones";

/** The pitches strictly between `from` and `to`, filling the gap in one of three ways. */
export function connect(from: Pitch, to: Pitch, via: ConnectVia, context: { space?: PitchSpace; chord?: Chord } = {}): OpResult {
  const dir: 1 | -1 = midi(to) >= midi(from) ? 1 : -1;
  const out: Pitch[] = [];
  if (via === "chord-tones") {
    if (!context.chord) throw new MusicTheoryError("connect via chord tones needs a chord");
    const lo = Math.min(midi(from), midi(to));
    const hi = Math.max(midi(from), midi(to));
    const inside = chordPitchesIn(context.chord, lo + 1, hi - 1).filter((p) => midi(p) !== midi(from) && midi(p) !== midi(to));
    out.push(...(dir > 0 ? inside : inside.reverse()));
  } else {
    let p = from;
    for (let guard = 0; guard < 40; guard++) {
      p = stepOf(p, dir, via, context.space ?? CHROMATIC_ONLY);
      if (dir > 0 ? midi(p) >= midi(to) : midi(p) <= midi(to)) break;
      out.push(p);
    }
  }
  return { pitches: out, description: desc("connect", { via, from: midi(from), to: midi(to) }) };
}

// ── APPROACH / SURROUND / NEIGHBOR ────────────────────────────────────────
/**
 * `count` pitches that lead into `target` from one side, by step, in playing order. The last of
 * them is adjacent to the target. Two chromatic approaches from below to E are D then D#.
 */
export function approach(target: Pitch, spec: { from: Side; kind: MotionStepKind; count?: number; space?: PitchSpace }): OpResult {
  const count = spec.count ?? 1;
  const dir: 1 | -1 = spec.from === "below" ? -1 : 1;
  const out: Pitch[] = [];
  let p = target;
  for (let i = 0; i < count; i++) {
    p = stepOf(p, dir, spec.kind, spec.space ?? CHROMATIC_ONLY);
    out.unshift(p);
  }
  return { pitches: out, description: desc("approach", { from: spec.from, kind: spec.kind, count }) };
}

/** An enclosure: approach the target from both sides, `first` side first, then the other. */
export function surround(target: Pitch, spec: { first: Side; upper: MotionStepKind; lower: MotionStepKind; space?: PitchSpace }): OpResult {
  const space = spec.space ?? CHROMATIC_ONLY;
  const upper = stepOf(target, 1, spec.upper, space);
  const lower = stepOf(target, -1, spec.lower, space);
  return {
    pitches: spec.first === "above" ? [upper, lower] : [lower, upper],
    description: desc("surround", { first: spec.first, upper: spec.upper, lower: spec.lower }),
  };
}

/** The neighbour of `anchor` on one side (the caller returns to the anchor). */
export function neighbor(anchor: Pitch, spec: { side: Side; kind: MotionStepKind; space?: PitchSpace }): OpResult {
  return {
    pitches: [stepOf(anchor, spec.side === "above" ? 1 : -1, spec.kind, spec.space ?? CHROMATIC_ONLY)],
    description: desc("neighbor", { side: spec.side, kind: spec.kind }),
  };
}

export function repeatPitch(p: Pitch, times: number): OpResult {
  return { pitches: Array.from({ length: times }, () => p), description: desc("repeat", { times }) };
}

/** A leap by an interval (the same as `move` with an interval; named for intent). */
export function leap(from: Pitch, interval: Interval): OpResult {
  const r = move(from, { interval });
  return { pitches: r.pitches, description: desc("leap", { semitones: interval.semitones }) };
}

// ── TRANSPOSE / INVERT ────────────────────────────────────────────────────
export function transpose(pitches: readonly Pitch[], interval: Interval): OpResult {
  return { pitches: pitches.map((p) => addInterval(p, interval)), description: desc("transpose", { semitones: interval.semitones, steps: interval.steps }) };
}

/** Mirror every pitch around `axis`: an interval of n semitones up becomes n semitones down, respelled. */
export function invert(pitches: readonly Pitch[], axis: Pitch): OpResult {
  const out = pitches.map((p) => {
    const iv = intervalBetween(axis, p);
    return addInterval(axis, { steps: -iv.steps, semitones: -iv.semitones });
  });
  return { pitches: out, description: desc("invert", { axis: midi(axis) }) };
}

/** Spell a MIDI number in the space if that pitch class is in it, else with the nearest chromatic spelling to `hint`. */
export function spellInSpace(m: number, space: PitchSpace, hint?: Pitch): Pitch {
  for (const n of space.scale) {
    try {
      return pitchFromMidi(m, n);
    } catch {
      /* not this note */
    }
  }
  if (hint) {
    const up = m >= midi(hint);
    let p = hint;
    for (let i = 0; i < 12 && midi(p) !== m; i++) p = chromaticStep(p, up ? 1 : -1);
    if (midi(p) === m) return p;
  }
  const names: Note[] = [{ letter: "C", accidental: 0 }, { letter: "C", accidental: 1 }, { letter: "D", accidental: 0 }, { letter: "E", accidental: -1 }, { letter: "E", accidental: 0 }, { letter: "F", accidental: 0 }, { letter: "F", accidental: 1 }, { letter: "G", accidental: 0 }, { letter: "A", accidental: -1 }, { letter: "A", accidental: 0 }, { letter: "B", accidental: -1 }, { letter: "B", accidental: 0 }];
  return pitchFromMidi(m, names[mod(m, 12)]!);
}

// ── ARPEGGIATE ────────────────────────────────────────────────────────────
export type ArpDirection = "up" | "down" | "updown" | "mixed";

export interface ArpeggioSpec {
  readonly direction: ArpDirection;
  readonly count: number;
  /** MIDI range of the pool of chord tones the arpeggio moves through. */
  readonly range: readonly [number, number];
  /** Degrees to use (default root, third, fifth, seventh). */
  readonly degrees?: readonly string[];
  /** Index into the pool to start from (0 = lowest). */
  readonly startIndex?: number;
}

/** The pool of chord pitches an arpeggio draws from. */
export function arpeggioPool(chord: Chord, range: readonly [number, number], degrees?: readonly string[]): Pitch[] {
  return chordPitchesIn(chord, range[0], range[1], degrees);
}

/**
 * Outline a chord: walk through its tones. "up" and "down" bounce at the ends of the range;
 * "updown" turns after reaching the highest tone or lowest; "mixed" goes two up, one down. All
 * pitches come from the chord, none are stored.
 */
export function arpeggiate(chord: Chord, spec: ArpeggioSpec): OpResult {
  const pool = arpeggioPool(chord, spec.range, spec.degrees);
  if (pool.length === 0) throw new MusicTheoryError(`No ${chord.symbol} tones in the requested range`);
  let index = Math.min(Math.max(spec.startIndex ?? (spec.direction === "down" ? pool.length - 1 : 0), 0), pool.length - 1);
  let dir = spec.direction === "down" ? -1 : 1;
  const shape = spec.direction === "mixed" ? [1, 1, -1] : null;
  const out: Pitch[] = [];
  for (let i = 0; i < spec.count; i++) {
    out.push(pool[index]!);
    if (shape) {
      const next = index + shape[i % shape.length]!;
      index = Math.min(Math.max(next, 0), pool.length - 1);
    } else {
      let next = index + dir;
      if (next < 0 || next >= pool.length) {
        dir = -dir;
        next = index + dir;
      }
      index = Math.min(Math.max(next, 0), pool.length - 1);
      if (spec.direction === "updown" && index === 0) dir = 1;
    }
  }
  return { pitches: out, description: desc("arpeggiate", { chord: chord.symbol, direction: spec.direction, count: spec.count }) };
}

/**
 * A guide-tone line: for each chord, its third or seventh, whichever is closest to the previous
 * guide tone (the first chord starts from `first`). The classic ii–V–I line F–F–E falls out of this.
 */
export function guideToneLine(chords: readonly Chord[], opts: { near: number; first?: "3" | "7" }): OpResult {
  const out: Pitch[] = [];
  let prev = opts.near;
  chords.forEach((chord, i) => {
    const labels = chord.tones.length > 3 ? ["3", "7"] : ["3"];
    const options = labels.flatMap((label) => {
      const d = chord.tones[label === "3" ? 1 : 3]!;
      const base = ((midi({ ...d, octave: 4 }) % 12) + 12) % 12;
      return [-1, 0, 1].map((k) => ({ label, p: pitchFromMidi(base + 12 * (Math.round((prev - base) / 12) + k), d) }));
    });
    const pool = i === 0 && opts.first ? options.filter((o) => o.label === opts.first) : options;
    const best = pool.reduce((a, b) => (Math.abs(midi(b.p) - prev) < Math.abs(midi(a.p) - prev) ? b : a));
    out.push(best.p);
    prev = midi(best.p);
  });
  return { pitches: out, description: desc("guide-tone-line", { chords: chords.map((c) => c.symbol).join(" ") }) };
}
