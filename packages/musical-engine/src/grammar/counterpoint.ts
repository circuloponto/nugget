/**
 * Voice relationships as calculable facts: motion between two voices, consonance of what sounds
 * together, voice exchange, imitation, and how much of a chord progression's voicing is retained.
 * This is NOT a species-counterpoint system: it states what is there so that rules can be built
 * on it later. Nothing here says a passage is "correct".
 */
import { fadd, fcmp, fsub, type Fraction } from "../time/rational";

export interface VoiceEvent {
  readonly id: string;
  readonly midi: number;
  readonly onset: Fraction;
  readonly duration: Fraction;
}

export type MotionType = "contrary" | "parallel" | "similar" | "oblique" | "static";

/**
 * Motion of two voices from one moment to the next. Same direction with the same interval between
 * the voices before and after is parallel; same direction otherwise is similar; opposite
 * directions are contrary; one voice still is oblique.
 */
export function classifyMotion(a0: number, a1: number, b0: number, b1: number): MotionType {
  const da = Math.sign(a1 - a0);
  const db = Math.sign(b1 - b0);
  if (da === 0 && db === 0) return "static";
  if (da === 0 || db === 0) return "oblique";
  if (da !== db) return "contrary";
  return Math.abs(a1 - b1) === Math.abs(a0 - b0) ? "parallel" : "similar";
}

export type Consonance = "perfect-consonance" | "imperfect-consonance" | "dissonance" | "contextual";

const intervalClass = (semitones: number): number => ((Math.abs(semitones) % 12) + 12) % 12;

/** Interval class of a vertical interval. A fourth is "contextual": it depends on whether the bass is involved. */
export function consonanceOf(semitones: number): Consonance {
  const c = intervalClass(semitones);
  if (c === 0 || c === 7) return "perfect-consonance";
  if (c === 3 || c === 4 || c === 8 || c === 9) return "imperfect-consonance";
  if (c === 5) return "contextual";
  return "dissonance";
}

export interface Moment {
  readonly onset: Fraction;
  readonly a: VoiceEvent;
  readonly b: VoiceEvent;
  /** Pitch of a minus pitch of b, in semitones. */
  readonly interval: number;
  readonly consonance: Consonance;
}

export interface MotionStep {
  readonly from: Fraction;
  readonly to: Fraction;
  readonly motion: MotionType;
  /** Parallel motion in perfect fifths or octaves, which classical counterpoint forbids and other styles do not. */
  readonly parallelPerfect: boolean;
}

export interface Imitation {
  /** How much later the second voice enters. */
  readonly delay: Fraction;
  /** Pitch shift of the answer in semitones. */
  readonly transposition: number;
  /** Number of notes imitated. */
  readonly length: number;
}

export interface CounterpointAnalysis {
  readonly moments: readonly Moment[];
  readonly motions: readonly MotionStep[];
  /** Pairs of moments at which the voices swap their pitches. */
  readonly voiceExchanges: readonly { readonly from: Fraction; readonly to: Fraction }[];
  readonly imitation: Imitation | null;
  readonly independence: {
    /** Share of motions that are contrary or oblique (the voices not moving together). */
    readonly contraryOrOblique: number;
    /** Share of attack times at which only one voice begins a note. */
    readonly rhythmic: number;
  };
}

const end = (e: VoiceEvent): Fraction => fadd(e.onset, e.duration);
const sounding = (v: readonly VoiceEvent[], t: Fraction): VoiceEvent | undefined => v.find((e) => fcmp(e.onset, t) <= 0 && fcmp(t, end(e)) < 0);

export function analyzeVoices(a: readonly VoiceEvent[], b: readonly VoiceEvent[]): CounterpointAnalysis {
  const attacks = [...new Map([...a, ...b].map((e) => [`${e.onset.num}/${e.onset.den}`, e.onset] as const)).values()].sort(fcmp);
  const moments: Moment[] = [];
  for (const t of attacks) {
    const x = sounding(a, t);
    const y = sounding(b, t);
    if (x && y) moments.push({ onset: t, a: x, b: y, interval: x.midi - y.midi, consonance: consonanceOf(x.midi - y.midi) });
  }
  const motions: MotionStep[] = [];
  const exchanges: { from: Fraction; to: Fraction }[] = [];
  const perfect = (n: number) => intervalClass(n) === 0 || intervalClass(n) === 7;
  for (let i = 1; i < moments.length; i++) {
    const p = moments[i - 1]!;
    const q = moments[i]!;
    const motion = classifyMotion(p.a.midi, q.a.midi, p.b.midi, q.b.midi);
    motions.push({ from: p.onset, to: q.onset, motion, parallelPerfect: motion === "parallel" && perfect(p.interval) && perfect(q.interval) && p.interval !== 0 });
    if (p.a.midi === q.b.midi && p.b.midi === q.a.midi && p.a.midi !== p.b.midi) exchanges.push({ from: p.onset, to: q.onset });
  }
  const moving = motions.filter((m) => m.motion !== "static");
  const free = moving.filter((m) => m.motion === "contrary" || m.motion === "oblique").length;
  const solo = attacks.filter((t) => a.some((e) => fcmp(e.onset, t) === 0) !== b.some((e) => fcmp(e.onset, t) === 0)).length;
  return {
    moments,
    motions,
    voiceExchanges: exchanges,
    imitation: findImitation(a, b),
    independence: { contraryOrOblique: moving.length ? free / moving.length : 0, rhythmic: attacks.length ? solo / attacks.length : 0 },
  };
}

/** The longest run (3 notes or more) of the first voice that the second repeats later with the same intervals and rhythm. */
export function findImitation(a: readonly VoiceEvent[], b: readonly VoiceEvent[]): Imitation | null {
  let best: Imitation | null = null;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const delay = fsub(b[j]!.onset, a[i]!.onset);
      if (delay.num <= 0) continue;
      let k = 0;
      while (i + k < a.length && j + k < b.length) {
        const sameTime = fcmp(fsub(b[j + k]!.onset, a[i + k]!.onset), delay) === 0 && fcmp(a[i + k]!.duration, b[j + k]!.duration) === 0;
        const sameShape = b[j + k]!.midi - a[i + k]!.midi === b[j]!.midi - a[i]!.midi;
        if (!(sameTime && sameShape)) break;
        k++;
      }
      if (k >= 3 && (!best || k > best.length)) best = { delay, transposition: b[j]!.midi - a[i]!.midi, length: k };
    }
  }
  return best;
}

export interface VoicingTransition {
  /** Per voice (matched by index, lowest first): semitones moved. */
  readonly moves: readonly number[];
  /** Pitches present in both voicings. */
  readonly commonTones: readonly number[];
  /** Voices that stay on the same pitch. */
  readonly retainedVoices: readonly number[];
  readonly totalMotion: number;
}

/** How one voicing becomes the next, voice by voice. Total motion is the same quantity the guitar voice-leading planner minimizes. */
export function voicingTransition(prev: readonly number[], next: readonly number[]): VoicingTransition {
  const p = [...prev].sort((x, y) => x - y);
  const n = [...next].sort((x, y) => x - y);
  const len = Math.min(p.length, n.length);
  const moves = Array.from({ length: len }, (_, i) => n[i]! - p[i]!);
  return {
    moves,
    commonTones: p.filter((m) => n.includes(m)),
    retainedVoices: moves.map((m, i) => (m === 0 ? i : -1)).filter((i) => i >= 0),
    totalMotion: moves.reduce((s, m) => s + Math.abs(m), 0),
  };
}
