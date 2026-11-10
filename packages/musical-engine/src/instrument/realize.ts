/**
 * Realization: map an abstract voicing (exact pitches) to every physically
 * valid way of playing it on a fretboard. Matching is by MIDI number only, so
 * an inversion on the fretboard is correct by construction: the bass voice is
 * the lowest sounding note and every voice sounds its exact pitch.
 */
import { midi, type Pitch } from "../theory/pitch";
import { type Scale } from "../theory/scale";
import { closeVoicing, shiftVoicingOctaves, type Inversion, type TriadVoicing } from "../theory/voicing";
import { positionsForMidi, type Fretboard } from "./fretboard";
import {
  fingersRequired,
  validateVoicing,
  withDefaults,
  type GuitarNote,
  type PlayabilityConstraints,
} from "./playability";

export interface GuitarVoicing {
  /** Notes in voice order, bass first. */
  readonly notes: readonly GuitarNote[];
  /** String indices used, ascending (lowest string first). */
  readonly strings: readonly number[];
  readonly lowestFret: number;
  readonly highestFret: number;
  /** Mean of the fretted frets (open strings ignored); 0 if all open. */
  readonly center: number;
  /** Stretch across fretted notes. */
  readonly span: number;
  readonly fingers: number;
}

export function describeVoicing(notes: readonly GuitarNote[]): GuitarVoicing {
  const fretted = notes.filter((n) => n.fret > 0).map((n) => n.fret);
  const frets = notes.map((n) => n.fret);
  return {
    notes,
    strings: notes.map((n) => n.string).sort((a, b) => a - b),
    lowestFret: Math.min(...frets),
    highestFret: Math.max(...frets),
    center: fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : 0,
    span: fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0,
    fingers: fingersRequired(notes),
  };
}

/**
 * All physically valid ways to play `pitches` (ascending, bass first) as
 * simultaneous notes. Deterministic order: lowest string set first, then
 * lowest fret center.
 */
export function realizePitches(
  pitches: readonly Pitch[],
  fb: Fretboard,
  constraintOverrides: Partial<PlayabilityConstraints> = {},
): GuitarVoicing[] {
  const constraints = withDefaults(constraintOverrides);
  const maxFret = Math.min(constraints.maxFret, fb.fretCount);
  const candidates = pitches.map((p) =>
    positionsForMidi(fb, midi(p), constraints.minFret, maxFret).filter(
      (pos) => constraints.allowOpenStrings || pos.fret > 0,
    ),
  );
  if (pitches.length === 0 || candidates.some((c) => c.length === 0)) return [];

  const results: GuitarVoicing[] = [];
  const chosen: GuitarNote[] = [];

  const search = (voice: number): void => {
    if (voice === pitches.length) {
      if (validateVoicing(chosen, fb, constraints, pitches).length === 0) {
        results.push(describeVoicing([...chosen]));
      }
      return;
    }
    for (const pos of candidates[voice]!) {
      const prev = chosen[voice - 1];
      // Early pruning (the validator remains the final authority).
      if (chosen.some((n) => n.string === pos.string)) continue;
      if (constraints.requireAscendingStrings && prev && pos.string <= prev.string) continue;
      chosen.push({ string: pos.string, fret: pos.fret, midi: midi(pitches[voice]!), pitch: pitches[voice]! });
      const fretted = chosen.filter((n) => n.fret > 0).map((n) => n.fret);
      const spanOk = fretted.length < 2 || Math.max(...fretted) - Math.min(...fretted) <= constraints.maxFretSpan;
      if (spanOk) search(voice + 1);
      chosen.pop();
    }
  };
  search(0);

  return results.sort(
    (a, b) =>
      compareArrays(a.strings, b.strings) || a.center - b.center || compareArrays(fretsOf(a), fretsOf(b)),
  );
}

const fretsOf = (v: GuitarVoicing): number[] => v.notes.map((n) => n.fret);

function compareArrays(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** All valid guitar realizations of one abstract triad voicing. */
export function realizeVoicing(
  voicing: TriadVoicing,
  fb: Fretboard,
  constraints: Partial<PlayabilityConstraints> = {},
): GuitarVoicing[] {
  return realizePitches(voicing.pitches, fb, constraints);
}

export interface FoundTriadVoicing {
  readonly voicing: TriadVoicing;
  readonly guitar: GuitarVoicing;
}

/**
 * Every playable close-position voicing of the triad on `degree` in the given
 * inversion, across all octaves the instrument can reach.
 */
export function findTriadVoicings(
  scale: Scale,
  degree: number,
  inversion: Inversion,
  fb: Fretboard,
  constraints: Partial<PlayabilityConstraints> = {},
  tonicOctave = 3,
): FoundTriadVoicing[] {
  const found: FoundTriadVoicing[] = [];
  const base = closeVoicing(scale, degree, inversion, tonicOctave);
  for (let octaves = -4; octaves <= 4; octaves++) {
    const voicing = shiftVoicingOctaves(base, octaves);
    for (const guitar of realizeVoicing(voicing, fb, constraints)) found.push({ voicing, guitar });
  }
  return found.sort((a, b) => a.guitar.center - b.guitar.center || compareArrays(a.guitar.strings, b.guitar.strings));
}
