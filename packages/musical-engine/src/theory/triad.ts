/**
 * Diatonic triads. Quality, Roman numeral and chord symbol are *derived* from
 * the spelled scale, so harmonic minor correctly yields i, ii°, III+, iv, V,
 * VI, vii° and natural minor yields i, ii°, III, iv, v, VI, VII.
 */
import { MusicTheoryError } from "../errors";
import { formatNote, type Note } from "./pitch";
import { degreeNote, intervalAtStep, pitchAtStep, type Scale } from "./scale";

export type TriadQuality = "major" | "minor" | "diminished" | "augmented";
export type TriadRole = "root" | "third" | "fifth";
export const TRIAD_ROLES: readonly TriadRole[] = ["root", "third", "fifth"];

export interface DiatonicTriad {
  /** Scale degree of the root, 1-7. */
  readonly degree: number;
  readonly root: Note;
  readonly third: Note;
  readonly fifth: Note;
  readonly quality: TriadQuality;
  /** e.g. "I", "ii", "vii°", "III+" */
  readonly roman: string;
  /** e.g. "C", "Dm", "Bdim", "Eaug" */
  readonly symbol: string;
  /** Notes in root-third-fifth order. */
  readonly notes: readonly [Note, Note, Note];
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

function classify(thirdSemis: number, fifthSemis: number): TriadQuality {
  if (thirdSemis === 4 && fifthSemis === 7) return "major";
  if (thirdSemis === 3 && fifthSemis === 7) return "minor";
  if (thirdSemis === 3 && fifthSemis === 6) return "diminished";
  if (thirdSemis === 4 && fifthSemis === 8) return "augmented";
  throw new MusicTheoryError(
    `Stacked thirds (${thirdSemis}, ${fifthSemis} semitones) do not form a triad`,
  );
}

export function romanNumeral(degree: number, quality: TriadQuality): string {
  const base = ROMAN[degree - 1]!;
  switch (quality) {
    case "major":
      return base;
    case "minor":
      return base.toLowerCase();
    case "diminished":
      return `${base.toLowerCase()}°`;
    case "augmented":
      return `${base}+`;
  }
}

export function chordSymbol(root: Note, quality: TriadQuality): string {
  const r = formatNote(root);
  switch (quality) {
    case "major":
      return r;
    case "minor":
      return `${r}m`;
    case "diminished":
      return `${r}dim`;
    case "augmented":
      return `${r}aug`;
  }
}

/** The diatonic triad built on `degree` (1-7) of `scale`. */
export function triadAt(scale: Scale, degree: number): DiatonicTriad {
  const root = degreeNote(scale, degree); // validates the degree
  const s = degree - 1;
  const third = degreeNote(scale, ((s + 2) % 7) + 1);
  const fifth = degreeNote(scale, ((s + 4) % 7) + 1);
  // Semitone sizes measured on absolute steps so wrap-around is exact.
  const base = intervalAtStep(scale.type, s).semitones;
  const thirdSemis = intervalAtStep(scale.type, s + 2).semitones - base;
  const fifthSemis = intervalAtStep(scale.type, s + 4).semitones - base;
  const quality = classify(thirdSemis, fifthSemis);
  return {
    degree,
    root,
    third,
    fifth,
    quality,
    roman: romanNumeral(degree, quality),
    symbol: chordSymbol(root, quality),
    notes: [root, third, fifth],
  };
}

export function diatonicTriads(scale: Scale): DiatonicTriad[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => triadAt(scale, d));
}
