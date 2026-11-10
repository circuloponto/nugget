/**
 * Step patterns: the editable form of a rhythm. A bar is divided into N equal steps (8 for
 * straight eighths, 12 for triplets, 5 for a quintuplet, ...) and each step is one of four
 * states. A pattern converts to an exact RhythmCell, and prints/parses as a short string
 * so it can be stored in a MusicIR document and restored into the editor.
 *
 *   "." rest        silence for the step
 *   "x" hit         a note starts here (normal strength)
 *   "A" accent      a note starts here (strong)
 *   "-" tie         the previous note keeps sounding through this step
 */
import { MusicTheoryError } from "../errors";
import { fdiv, fmul, frac, type Fraction } from "./rational";
import { makeCell, type RhythmCell, type RhythmEvent } from "./rhythm";

export type StepKind = "rest" | "hit" | "accent" | "tie";

const CHAR_OF: Record<StepKind, string> = { rest: ".", hit: "x", accent: "A", tie: "-" };
const KIND_OF: Record<string, StepKind> = { ".": "rest", x: "hit", A: "accent", "-": "tie" };

/** Accent weights given to hits and accents (see accentProfile for the meter hierarchy). */
export const HIT_ACCENT = 1;
export const ACCENT_ACCENT = 3;

export const stepsToString = (steps: readonly StepKind[]): string => steps.map((s) => CHAR_OF[s]).join("");

export function stepsFromString(text: string): StepKind[] {
  if (text.length === 0) throw new MusicTheoryError("A step pattern needs at least one step");
  return [...text].map((ch) => {
    const k = KIND_OF[ch];
    if (!k) throw new MusicTheoryError(`Unknown step "${ch}" in pattern "${text}" (use . x A -)`);
    return k;
  });
}

/**
 * The exact rhythm cell for a pattern over `length`: step i starts at i·length/N. A hit lasts
 * its step plus any tie steps after it; consecutive rests merge into one rest. A tie with
 * nothing to extend (at the start, or after a rest) is treated as a rest.
 */
export function cellFromSteps(length: Fraction, steps: readonly StepKind[]): RhythmCell {
  if (steps.length === 0) throw new MusicTheoryError("A step pattern needs at least one step");
  const step = fdiv(length, frac(steps.length));
  const events: RhythmEvent[] = [];
  let i = 0;
  while (i < steps.length) {
    const kind = steps[i]!;
    let j = i + 1;
    if (kind === "hit" || kind === "accent") {
      while (j < steps.length && steps[j] === "tie") j++;
      events.push({
        onset: fmul(step, frac(i)),
        duration: fmul(step, frac(j - i)),
        accent: kind === "accent" ? ACCENT_ACCENT : HIT_ACCENT,
        ...(j < steps.length && steps[j] === "tie" ? { tiedToNext: true } : {}),
      });
    } else {
      // rest, or a tie that has nothing to extend: silence until the next hit
      while (j < steps.length && (steps[j] === "rest" || steps[j] === "tie")) j++;
      events.push({ onset: fmul(step, frac(i)), duration: fmul(step, frac(j - i)), rest: true });
    }
    i = j;
  }
  return makeCell(length, events);
}

/** Shift the pattern later by `k` steps, wrapping around (negative k shifts earlier). */
export function rotateSteps<T>(steps: readonly T[], k: number): T[] {
  const n = steps.length;
  if (n === 0) return [];
  const shift = ((k % n) + n) % n;
  return steps.map((_, i) => steps[(i - shift + n) % n]!);
}

export interface RhythmPreset {
  readonly id: string;
  readonly name: string;
  /** Steps per bar the pattern is written for. */
  readonly grid: number;
  readonly pattern: string;
}

/** Starting points for the editor. Every pattern's length equals its grid. */
export const RHYTHM_PRESETS: readonly RhythmPreset[] = [
  { id: "whole", name: "One attack, rings the bar", grid: 4, pattern: "A---" },
  { id: "quarters", name: "Quarter-note pulse", grid: 4, pattern: "Axxx" },
  { id: "eighths", name: "Straight eighths", grid: 8, pattern: "AxxxAxxx" },
  { id: "offbeat", name: "Off-beat eighths", grid: 8, pattern: ".x.x.x.x" },
  { id: "tresillo", name: "Tresillo (3+3+2)", grid: 8, pattern: "A..x..x." },
  { id: "clave", name: "Syncopated 3+3+2, held", grid: 8, pattern: "A--x--x-" },
  { id: "comp", name: "Comping", grid: 8, pattern: "A..x.x.." },
  { id: "sixteenths", name: "Sixteenths", grid: 16, pattern: "AxxxxxxxAxxxxxxx" },
  { id: "charleston", name: "Charleston", grid: 8, pattern: "A--x...." },
  { id: "triplets", name: "Triplets (12 steps)", grid: 12, pattern: "AxxAxxAxxAxx" },
  { id: "shuffle", name: "Shuffle (swung eighths)", grid: 12, pattern: "A-xx-xx-xx-x" },
  { id: "quintuplet", name: "Quintuplet (5 against the bar)", grid: 5, pattern: "Axxxx" },
  { id: "septuplet", name: "Septuplet (7 against the bar)", grid: 7, pattern: "Axxxxxx" },
];

/** Grid sizes the editor offers, with a name for each. */
export const RHYTHM_GRIDS: readonly { grid: number; name: string }[] = [
  { grid: 4, name: "Quarters (4)" },
  { grid: 8, name: "Eighths (8)" },
  { grid: 16, name: "Sixteenths (16)" },
  { grid: 6, name: "Triplet quarters (6)" },
  { grid: 12, name: "Triplet eighths (12)" },
  { grid: 5, name: "Quintuplet (5)" },
  { grid: 7, name: "Septuplet (7)" },
];

/** Resize a pattern to a new grid, keeping its shape: each new step takes the nearest old step's state at the same position. */
export function resamplePattern(steps: readonly StepKind[], toGrid: number): StepKind[] {
  if (toGrid < 1) throw new MusicTheoryError("grid must be at least 1");
  const n = steps.length;
  const out: StepKind[] = Array(toGrid).fill("rest");
  // an old hit lands on the new step that contains its onset; ties and rests follow from the gaps
  steps.forEach((kind, i) => {
    if (kind !== "hit" && kind !== "accent") return;
    const target = Math.min(toGrid - 1, Math.round((i / n) * toGrid));
    out[target] = kind;
    // keep a held note held: extend through the steps that were ties
    let j = i + 1;
    while (j < n && steps[j] === "tie") j++;
    const end = Math.min(toGrid, Math.max(target + 1, Math.round((j / n) * toGrid)));
    for (let t = target + 1; t < end; t++) out[t] = "tie";
  });
  return out;
}
