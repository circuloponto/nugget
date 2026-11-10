/**
 * A rhythmic vocabulary for phrases: small rhythmic gestures (cells with exact durations, rests,
 * dotted figures, triplets, syncopations, unequal groups) that are combined to fill a span of
 * time exactly. The generator chooses a rhythm PLAN for a given number of notes while it chooses
 * the pitches, so pitch and rhythm are decided together.
 *
 * All times are exact fractions of a whole note, from the existing temporal engine.
 */
import { fadd, fcmp, frac, fsub, fnum, type Fraction } from "../time/rational";

export type RhythmTag = "straight" | "triplet" | "dotted" | "syncopated" | "rest" | "dense" | "sparse" | "unequal";

export interface RhythmicSlot {
  /** Offset from the start of the gesture. */
  readonly offset: Fraction;
  readonly duration: Fraction;
  readonly rest: boolean;
}

export interface RhythmicGesture {
  readonly id: string;
  readonly name: string;
  readonly length: Fraction;
  readonly slots: readonly RhythmicSlot[];
  readonly tags: readonly RhythmTag[];
}

function gesture(id: string, name: string, parts: readonly (string | [string])[], tags: RhythmTag[]): RhythmicGesture {
  const slots: RhythmicSlot[] = [];
  let at = frac(0);
  for (const part of parts) {
    const rest = Array.isArray(part);
    const text = Array.isArray(part) ? part[0] : part;
    const [n, d] = text.split("/").map(Number) as [number, number | undefined];
    const duration = frac(n, d ?? 1);
    slots.push({ offset: at, duration, rest });
    at = fadd(at, duration);
  }
  return { id, name, length: at, slots, tags };
}

/** The vocabulary. A beat is a quarter note (1/4). */
export const RHYTHMIC_GESTURES: readonly RhythmicGesture[] = [
  gesture("quarter", "quarter", ["1/4"], ["straight", "sparse"]),
  gesture("eighths", "two eighths", ["1/8", "1/8"], ["straight"]),
  gesture("sixteenths", "four sixteenths", ["1/16", "1/16", "1/16", "1/16"], ["straight", "dense"]),
  gesture("dotted-eighth", "dotted eighth + sixteenth", ["3/16", "1/16"], ["dotted"]),
  gesture("scotch-snap", "sixteenth + dotted eighth", ["1/16", "3/16"], ["dotted", "syncopated"]),
  gesture("eighth-triplet", "eighth-note triplet", ["1/12", "1/12", "1/12"], ["triplet", "dense"]),
  gesture("two-sixteenths-eighth", "two sixteenths + eighth", ["1/16", "1/16", "1/8"], ["straight", "dense"]),
  gesture("eighth-two-sixteenths", "eighth + two sixteenths", ["1/8", "1/16", "1/16"], ["straight", "dense"]),
  gesture("rest-eighth", "eighth rest + eighth", [["1/8"], "1/8"], ["rest", "syncopated"]),
  gesture("eighth-rest", "eighth + eighth rest", ["1/8", ["1/8"]], ["rest"]),
  gesture("half", "half note", ["1/2"], ["straight", "sparse"]),
  gesture("whole", "whole note", ["1"], ["straight", "sparse"]),
  gesture("rest-quarter", "quarter rest", [["1/4"]], ["rest"]),
  gesture("rest-half", "half rest", [["1/2"]], ["rest"]),
  gesture("syncopated-eighths", "eighth, quarter, eighth", ["1/8", "1/4", "1/8"], ["syncopated"]),
  gesture("dotted-quarter", "dotted quarter + eighth", ["3/8", "1/8"], ["dotted", "sparse"]),
  gesture("quarter-triplet", "quarter-note triplet", ["1/6", "1/6", "1/6"], ["triplet"]),
  gesture("rest-quarter-eighth", "eighth rest, quarter, eighth", [["1/8"], "1/4", "1/8"], ["rest", "syncopated"]),
  gesture("three-three-two", "3 + 3 + 2 eighths", ["3/8", "3/8", "1/4"], ["unequal", "syncopated"]),
];

export interface RhythmIntent {
  /** Which feel(s) may be used. Default any. */
  readonly feel?: "straight" | "triplet" | "any";
  /** Allow rests inside the phrase. Default true. */
  readonly rests?: boolean;
  /** Preferred syncopation 0..1 (used for ranking, not required). Default 0.3. */
  readonly syncopation?: number;
  /** Preferred notes per quarter-note beat (used for ranking). Default 2. */
  readonly density?: number;
  /** Shape of the density across the span. Default "any". */
  readonly shape?: "even" | "accelerating" | "decelerating" | "any";
}

export interface RhythmPlanSlot {
  /** Offset from the start of the span. */
  readonly offset: Fraction;
  readonly duration: Fraction;
  readonly rest: boolean;
}

export interface RhythmPlan {
  readonly id: string;
  readonly gestures: readonly string[];
  readonly slots: readonly RhythmPlanSlot[];
  /** Number of sounding notes. */
  readonly hits: number;
}

const allowed = (g: RhythmicGesture, intent: RhythmIntent): boolean => {
  if (intent.rests === false && g.tags.includes("rest")) return false;
  if (intent.feel === "straight" && g.tags.includes("triplet")) return false;
  if (intent.feel === "triplet" && !g.tags.includes("triplet")) return false;
  return true;
};

/** The one definition of "syncopated" used for both ranking and reporting: a syncopated, dotted or rest-bearing figure. */
const isOffbeatFigure = (g: RhythmicGesture | undefined): boolean => !!g && (g.tags.includes("syncopated") || g.tags.includes("dotted") || g.tags.includes("rest"));

const hitsIn = (g: RhythmicGesture): number => g.slots.filter((s) => !s.rest).length;
const density = (g: RhythmicGesture): number => hitsIn(g) / (fnum(g.length) * 4); // notes per quarter beat

/**
 * Every way of filling exactly `span` with `hits` sounding notes from the vocabulary (up to `limit`),
 * ordered by how well each fits the intent. Deterministic. An empty list means the span cannot be
 * filled with that many notes: a hard fact the caller must handle.
 */
export function rhythmPlans(span: Fraction, hits: number, intent: RhythmIntent = {}, limit = 60): RhythmPlan[] {
  const vocab = RHYTHMIC_GESTURES.filter((g) => allowed(g, intent));
  const found: RhythmicGesture[][] = [];
  const CAP = 4000;

  const walk = (remaining: Fraction, left: number, chosen: RhythmicGesture[]): void => {
    if (found.length >= CAP) return;
    if (remaining.num === 0) {
      if (left === 0) found.push([...chosen]);
      return;
    }
    for (const g of vocab) {
      if (fcmp(g.length, remaining) > 0) continue;
      const h = hitsIn(g);
      if (h > left) continue;
      chosen.push(g);
      walk(fsub(remaining, g.length), left - h, chosen);
      chosen.pop();
    }
  };
  walk(span, hits, []);

  const want = intent.density ?? 2;
  const syncWant = intent.syncopation ?? 0.3;
  const scored = found.map((gs) => {
    const hitsTotal = gs.reduce((a, g) => a + hitsIn(g), 0);
    const meanDensity = hitsTotal / (fnum(span) * 4);
    const syncShare = gs.filter(isOffbeatFigure).length / gs.length;
    const dens = gs.map(density);
    let shapePenalty = 0;
    const nonDecreasing = dens.every((d, i) => i === 0 || d >= dens[i - 1]!);
    const nonIncreasing = dens.every((d, i) => i === 0 || d <= dens[i - 1]!);
    if (intent.shape === "accelerating" && !(nonDecreasing && dens[dens.length - 1]! > dens[0]!)) shapePenalty = 5;
    if (intent.shape === "decelerating" && !(nonIncreasing && dens[0]! > dens[dens.length - 1]!)) shapePenalty = 5;
    if (intent.shape === "even" && new Set(dens).size > 1) shapePenalty = 2;
    const variety = new Set(gs.map((g) => g.id)).size / gs.length;
    const fit = Math.abs(meanDensity - want) + 2 * Math.abs(syncShare - syncWant) + shapePenalty - 0.3 * variety;
    return { gs, fit, key: gs.map((g) => g.id).join(">") };
  });
  scored.sort((a, b) => a.fit - b.fit || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return scored.slice(0, limit).map(({ gs, key }) => {
    const slots: RhythmPlanSlot[] = [];
    let at = frac(0);
    for (const g of gs) {
      for (const s of g.slots) slots.push({ offset: fadd(at, s.offset), duration: s.duration, rest: s.rest });
      at = fadd(at, g.length);
    }
    return { id: key, gestures: gs.map((g) => g.id), slots, hits: slots.filter((s) => !s.rest).length };
  });
}

/** Share of the plan's gestures that are syncopated, dotted or contain rests (0..1). */
export function syncopationOf(plan: RhythmPlan): number {
  const tagged = plan.gestures.filter((id) => isOffbeatFigure(RHYTHMIC_GESTURES.find((x) => x.id === id)));
  return plan.gestures.length ? tagged.length / plan.gestures.length : 0;
}
