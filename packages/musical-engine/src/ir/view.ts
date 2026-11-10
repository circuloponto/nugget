/**
 * What a front end needs to draw one moment of a document, derived from the document and
 * its frame schedule alone (no engine objects, no UI): the chord at that moment and, for
 * each voice of its voicing, where it is played and whether it is sounding right now.
 * Because it reads only MusicIR, it works the same for a generated document and for one
 * loaded from a file.
 */
import { MusicTheoryError } from "../errors";
import { parseNote, pitchClass } from "../theory/pitch";
import { chordIndexAtFrame, soundingAtFrame, type FrameSchedule } from "./frames";
import { chordVoicing } from "./rhythmize";
import type { IRChordSegment, MusicIR } from "./types";

export interface PositionView {
  readonly voice: string;
  readonly pitch: string;
  readonly midi: number;
  /** Fretted position, when the document gives one (string 0 = lowest). */
  readonly string?: number;
  readonly fret?: number;
  /** root / third / fifth, when the pitch is one of the chord's first three tones. */
  readonly role?: "root" | "third" | "fifth";
  /** A note of this voice is sounding at this frame. */
  readonly sounding: boolean;
}

export interface ChordView {
  readonly index: number;
  readonly chord: IRChordSegment;
  /** The voicing, lowest voice first. */
  readonly positions: readonly PositionView[];
}

const ROLES = ["root", "third", "fifth"] as const;

/** The chord at `frame` (looping) with its voices and which of them are sounding; null if no chord covers it. */
export function chordViewAtFrame(ir: MusicIR, schedule: FrameSchedule, frame: number): ChordView | null {
  const index = chordIndexAtFrame(schedule, frame);
  if (index < 0) return null;
  const chord = ir.chords[index];
  if (!chord) return null;
  const sounding = soundingAtFrame(schedule, frame);
  const pcs = chord.tones.map((t) => pitchClass(parseNote(t)));
  const positions: PositionView[] = chordVoicing(ir, chord).map((v) => {
    const role = pcs.indexOf(((v.pitch.midi % 12) + 12) % 12);
    return {
      voice: v.voice,
      pitch: v.pitch.name,
      midi: v.pitch.midi,
      ...(v.instrument ? { string: v.instrument.string, fret: v.instrument.fret } : {}),
      ...(role >= 0 && role < ROLES.length && chord.tones.length >= 3 ? { role: ROLES[role]! } : {}),
      sounding: sounding.some((e) => e.voice === v.voice && e.midi === v.pitch.midi),
    };
  });
  return { index, chord, positions };
}

/** The tuning the document states for its instrument (lowest string first), or null. */
export function irTuning(ir: MusicIR): readonly string[] | null {
  for (const v of ir.voices) if (v.instrument?.tuning && v.instrument.tuning.length > 0) return v.instrument.tuning;
  return null;
}

/** Distinct voice ids in the document, lowest-pitched first (by their lowest note). */
export function voiceOrder(ir: MusicIR): string[] {
  const low = new Map<string, number>();
  for (const e of ir.events) {
    if (e.kind !== "note") continue;
    low.set(e.voice, Math.min(low.get(e.voice) ?? Infinity, e.pitch.midi));
  }
  for (const v of ir.voices) if (!low.has(v.id)) low.set(v.id, Infinity);
  return [...low.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/** Throws unless every position needed to draw this chord on a fretboard is present. */
export function requirePositions(view: ChordView): void {
  for (const p of view.positions) {
    if (p.string === undefined || p.fret === undefined) throw new MusicTheoryError(`${p.pitch} has no fretted position`);
  }
}
