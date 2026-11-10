/**
 * From symbolic MusicIR time to seconds for playback. The only place where the
 * exact fractions become floats.
 */
import { MusicTheoryError } from "../errors";
import { fadd, fnum, frac, parseFraction, type Fraction } from "../time/rational";
import { toSeconds } from "../time/tempo";
import { type MusicIR } from "./types";

export interface ScheduleTempo {
  bpm: number;
  /** Default 1/4. */
  beat?: Fraction;
}

export interface ScheduledNote {
  readonly id: string;
  readonly voice: string;
  readonly midi: number;
  /** Seconds from the start. */
  readonly start: number;
  readonly duration: number;
}

export interface ScheduledChord {
  readonly id: string;
  readonly symbol: string;
  readonly start: number;
  readonly duration: number;
}

function resolveTempo(ir: MusicIR, tempo?: ScheduleTempo): Required<ScheduleTempo> {
  if (tempo) return { bpm: tempo.bpm, beat: tempo.beat ?? frac(1, 4) };
  if (!ir.tempo) throw new MusicTheoryError("The document has no tempo; pass one to scheduleFromIR");
  return { bpm: fnum(parseFraction(ir.tempo.bpm)), beat: parseFraction(ir.tempo.beat) };
}

/** Every note with its start time and length in seconds, ordered by start time. */
export function scheduleFromIR(ir: MusicIR, tempo?: ScheduleTempo): ScheduledNote[] {
  const t = resolveTempo(ir, tempo);
  const out: ScheduledNote[] = [];
  for (const e of ir.events) {
    if (e.kind !== "note") continue;
    const onset = parseFraction(e.onset);
    out.push({
      id: e.id,
      voice: e.voice,
      midi: e.pitch.midi,
      start: toSeconds(onset, t.bpm, t.beat),
      duration: toSeconds(parseFraction(e.duration), t.bpm, t.beat),
    });
  }
  return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

/** Chord segments with their start time and length in seconds. */
export function chordTimeline(ir: MusicIR, tempo?: ScheduleTempo): ScheduledChord[] {
  const t = resolveTempo(ir, tempo);
  return ir.chords.map((c) => ({
    id: c.id,
    symbol: c.symbol,
    start: toSeconds(parseFraction(c.onset), t.bpm, t.beat),
    duration: toSeconds(parseFraction(c.duration), t.bpm, t.beat),
  }));
}

/** End of the last event, as an exact position. */
export function irEnd(ir: MusicIR): Fraction {
  let end = parseFraction("0");
  for (const e of ir.events) {
    const x = fadd(parseFraction(e.onset), parseFraction(e.duration));
    if (x.num * end.den > end.num * x.den) end = x;
  }
  return end;
}
