/**
 * MusicIR → sample frames. This is where the exact fractions of a document become integer
 * audio frames, once and without accumulating error: every position is converted from its
 * exact rational value (see toSampleFrameExact), so event n of a steady pulse lands on
 * exactly n·period frames at any length, and three triplets in a beat land on exact thirds.
 *
 * The result is plain data (no Web Audio): the renderer mixes it into samples, and the UI
 * uses it to answer "which chord / which notes are sounding at this frame?".
 */
import { MusicTheoryError } from "../errors";
import { fadd, flt, frac, parseFraction, type Fraction } from "../time/rational";
import { toSampleFrameExact } from "../time/tempo";
import { irEnd } from "./schedule";
import type { MusicIR } from "./types";

export interface FrameEvent {
  readonly id: string;
  readonly voice: string;
  readonly midi: number;
  /** First frame the note sounds on. */
  readonly startFrame: number;
  /** One past the last frame of the note (its notated length; ring-out is the renderer's business). */
  readonly endFrame: number;
  readonly velocity: number;
  readonly accent: number;
  readonly instrument?: { readonly string: number; readonly fret: number };
  /** The chord segment this note starts in, if any. */
  readonly chordId?: string;
}

export interface FrameChord {
  readonly id: string;
  readonly symbol: string;
  readonly roman?: string;
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface FrameSchedule {
  readonly sampleRate: number;
  /** Length of the document in frames; the loop length. */
  readonly totalFrames: number;
  /** Ascending by start frame, then pitch. */
  readonly events: readonly FrameEvent[];
  readonly chords: readonly FrameChord[];
}

export interface FrameTempo {
  /** Beats per minute: an integer, or an exact fraction. */
  bpm: Fraction | number;
  /** Beat unit as a fraction of a whole note. Default 1/4. */
  beat?: Fraction;
}

/** The tempo to use for a document: the override if given, else the document's own. */
export function resolveFrameTempo(ir: MusicIR, tempo?: FrameTempo): { bpm: Fraction; beat: Fraction } {
  if (tempo) {
    return { bpm: typeof tempo.bpm === "number" ? frac(tempo.bpm) : tempo.bpm, beat: tempo.beat ?? frac(1, 4) };
  }
  if (!ir.tempo) throw new MusicTheoryError("The document has no tempo; pass one to scheduleFrames");
  return { bpm: parseFraction(ir.tempo.bpm), beat: parseFraction(ir.tempo.beat) };
}

/** Convert a document to integer sample frames at `sampleRate`. */
export function scheduleFrames(ir: MusicIR, sampleRate: number, tempo?: FrameTempo): FrameSchedule {
  const { bpm, beat } = resolveFrameTempo(ir, tempo);
  const frame = (p: Fraction) => toSampleFrameExact(p, bpm, sampleRate, beat);

  const chords = ir.chords.map((c) => {
    const start = parseFraction(c.onset);
    return {
      id: c.id,
      symbol: c.symbol,
      ...(c.roman ? { roman: c.roman } : {}),
      start,
      end: fadd(start, parseFraction(c.duration)),
      startFrame: frame(start),
      endFrame: frame(fadd(start, parseFraction(c.duration))),
    };
  });

  const events: FrameEvent[] = [];
  for (const e of ir.events) {
    if (e.kind !== "note") continue;
    const onset = parseFraction(e.onset);
    const startFrame = frame(onset);
    const endFrame = Math.max(startFrame + 1, frame(fadd(onset, parseFraction(e.duration))));
    const chord = chords.find((c) => !flt(onset, c.start) && flt(onset, c.end));
    events.push({
      id: e.id,
      voice: e.voice,
      midi: e.pitch.midi,
      startFrame,
      endFrame,
      velocity: e.velocity ?? 0.8,
      accent: e.accent ?? 1,
      ...(e.instrument ? { instrument: e.instrument } : {}),
      ...(chord ? { chordId: chord.id } : {}),
    });
  }
  events.sort((a, b) => a.startFrame - b.startFrame || a.midi - b.midi);

  return {
    sampleRate,
    totalFrames: Math.max(1, frame(irEnd(ir))),
    events,
    chords: chords.map(({ id, symbol, roman, startFrame, endFrame }) => ({ id, symbol, ...(roman ? { roman } : {}), startFrame, endFrame })),
  };
}

/** A frame inside [0, totalFrames): positions past the end wrap, as a looping player does. */
export function wrapFrame(s: FrameSchedule, frame: number): number {
  return ((Math.floor(frame) % s.totalFrames) + s.totalFrames) % s.totalFrames;
}

/** Index of the chord segment that contains the frame (looping), or -1 when none does. */
export function chordIndexAtFrame(s: FrameSchedule, frame: number): number {
  const f = wrapFrame(s, frame);
  return s.chords.findIndex((c) => f >= c.startFrame && f < c.endFrame);
}

/** Notes sounding at the frame (looping): start ≤ frame < end. */
export function soundingAtFrame(s: FrameSchedule, frame: number): FrameEvent[] {
  const f = wrapFrame(s, frame);
  return s.events.filter((e) => f >= e.startFrame && f < e.endFrame);
}
