/**
 * MelodyLine: the one view of a monophonic melody that every analysis reads.
 *
 * It is built the same way from a corpus piece and from a Nugget-generated MusicIR phrase, so real and
 * generated music are measured by identical code. It makes no tonal assumption: the key, the chords and the
 * tuning system are optional; pitch is a (possibly fractional) MIDI number plus the tuning system's name.
 */
import { fadd, fcmp, fnum, fsub, frac, parseFraction, type Fraction, ZERO } from "../../time/rational";
import { parseNote, pitchClass } from "../../theory/pitch";
import type { MusicIR } from "../../ir/types";
import type { CorpusPiece } from "../types";

export interface MelodyNote {
  readonly kind: "note";
  readonly id: string;
  /** Index into `events`. */
  readonly index: number;
  readonly midi: number;
  readonly name?: string;
  readonly onset: Fraction;
  readonly duration: Fraction;
  readonly end: Fraction;
  readonly bar: number;
  /** Position in the bar, exact (measured from the bar's start, pickups included). */
  readonly phase: Fraction;
  /** 4 downbeat, 3 group start, 2 beat, 1 half-beat, 0 finer. */
  readonly weight: number;
  readonly tiedParts: number;
  readonly marks: readonly string[];
}
export interface MelodyRest {
  readonly kind: "rest";
  readonly id: string;
  readonly index: number;
  readonly onset: Fraction;
  readonly duration: Fraction;
  readonly end: Fraction;
  readonly bar: number;
  readonly phase: Fraction;
  readonly weight: number;
  /** Suspected converter padding: occupies time but is not written silence, so it is left out of rest statistics and phrase evidence. */
  readonly suspect: boolean;
}
export type MelodyEvent = MelodyNote | MelodyRest;

export interface MelodyBar {
  readonly index: number;
  readonly number: string;
  readonly onset: Fraction;
  readonly length: Fraction;
  readonly startPhase: Fraction;
  readonly pickup: boolean;
  readonly meter: { readonly beats: number; readonly beatType: number };
  /** Length of one beat (a dotted quarter in 6/8). */
  readonly beat: Fraction;
  readonly repeat?: { readonly forward?: boolean; readonly backward?: boolean };
  readonly ending?: { readonly numbers: string; readonly type: string };
}

export interface MelodyChord {
  readonly symbol: string;
  readonly onset: Fraction;
  readonly end: Fraction;
  readonly rootPc: number;
  /** Pitch classes of the chord tones above the root, when known. */
  readonly intervals?: readonly number[];
}

export interface TonalContext {
  readonly tonicPc: number;
  readonly mode?: string;
  /** Where the claim comes from: the written key, a hint from the caller, or an inference (a hypothesis). */
  readonly source: "written-key" | "hint" | "inferred-final-note";
  readonly confidence: number;
}

export interface MelodyLine {
  readonly id: string;
  readonly title: string;
  readonly origin: "corpus" | "generated";
  readonly tuning: string;
  readonly bars: readonly MelodyBar[];
  readonly events: readonly MelodyEvent[];
  readonly notes: readonly MelodyNote[];
  readonly chords: readonly MelodyChord[];
  readonly tonal: TonalContext | null;
  readonly length: Fraction;
}

/** Scale pitch classes above the tonic for the modes the importer can place; others have no scale claim. */
export const MODE_SCALES: Readonly<Record<string, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

/** Metric weight of a position within a bar (see MelodyNote.weight). */
export function metricWeight(phase: Fraction, meter: { beats: number; beatType: number }): number {
  const unit = frac(1, meter.beatType);
  const compound = meter.beats > 3 && meter.beats % 3 === 0 && meter.beatType >= 8;
  const groupPulses = compound ? 3 : meter.beats === 4 ? 2 : 1;
  const group = fnum(unit) * groupPulses;
  const x = fnum(phase);
  const eps = 1e-9;
  const onGrid = (step: number) => Math.abs(x / step - Math.round(x / step)) < eps;
  if (Math.abs(x) < eps) return 4;
  if (onGrid(group)) return 3;
  if (onGrid(fnum(unit))) return compound ? 1 : 2;
  if (onGrid(fnum(unit) / 2)) return compound ? 0 : 1;
  return 0;
}

const beatOf = (meter: { beats: number; beatType: number }): Fraction => (meter.beats > 3 && meter.beats % 3 === 0 && meter.beatType >= 8 ? frac(3, meter.beatType) : frac(1, meter.beatType));

function chordsFrom(list: readonly { symbol: string; onset: string; duration: string; root: string; tones?: readonly string[] }[]): MelodyChord[] {
  const out: MelodyChord[] = [];
  for (const c of list) {
    try {
      const rootPc = pitchClass(parseNote(c.root));
      const intervals = c.tones ? c.tones.map((t) => (((pitchClass(parseNote(t)) - rootPc) % 12) + 12) % 12) : undefined;
      const onset = parseFraction(c.onset);
      out.push({ symbol: c.symbol, onset, end: fadd(onset, parseFraction(c.duration)), rootPc, ...(intervals ? { intervals } : {}) });
    } catch {
      /* an unparseable chord is simply not an annotation */
    }
  }
  return out;
}

function inferTonal(notes: readonly MelodyNote[]): TonalContext | null {
  const last = notes[notes.length - 1];
  if (!last) return null;
  return { tonicPc: ((Math.round(last.midi) % 12) + 12) % 12, source: "inferred-final-note", confidence: 0.3 };
}

function finish(parts: Omit<MelodyLine, "notes" | "tonal" | "length"> & { tonal: TonalContext | null; length: Fraction }): MelodyLine {
  const notes = parts.events.filter((e): e is MelodyNote => e.kind === "note");
  return { ...parts, notes, tonal: parts.tonal ?? inferTonal(notes) };
}

export function melodyFromCorpusPiece(piece: CorpusPiece): MelodyLine {
  const bars: MelodyBar[] = piece.measures.map((m) => ({
    index: m.index,
    number: m.number,
    onset: parseFraction(m.onset),
    length: parseFraction(m.length),
    startPhase: parseFraction(m.startPhase),
    pickup: m.pickup,
    meter: { beats: m.meter.beats, beatType: m.meter.beatType },
    beat: beatOf(m.meter),
    ...(m.repeat ? { repeat: { ...(m.repeat.forward ? { forward: true } : {}), ...(m.repeat.backward ? { backward: true } : {}) } } : {}),
    ...(m.ending ? { ending: m.ending } : {}),
  }));
  const events: MelodyEvent[] = piece.events.map((e, index) => {
    const bar = bars[e.measure]!;
    const onset = parseFraction(e.onset);
    const duration = parseFraction(e.duration);
    const phase = fadd(bar.startPhase, fsub(onset, bar.onset));
    const weight = metricWeight(phase, bar.meter);
    if (e.kind === "rest") return { kind: "rest", id: e.id, index, onset, duration, end: fadd(onset, duration), bar: e.measure, phase, weight, suspect: e.suspect !== undefined };
    return { kind: "note", id: e.id, index, midi: e.pitch.midi, ...(e.pitch.name ? { name: e.pitch.name } : {}), onset, duration, end: fadd(onset, duration), bar: e.measure, phase, weight, tiedParts: e.tiedParts?.length ?? 1, marks: e.marks ?? [] };
  });
  const key = piece.measures[0]?.key;
  const tonal: TonalContext | null =
    key?.tonic !== undefined
      ? { tonicPc: pitchClass(parseNote(key.tonic)), ...(key.mode ? { mode: key.mode } : {}), source: "written-key", confidence: 0.9 }
      : null;
  return finish({ id: piece.id, title: piece.title, origin: "corpus", tuning: piece.tuning.system, bars, events, chords: chordsFrom(piece.harmony), tonal, length: parseFraction(piece.length) });
}

export interface IRMelodyOptions {
  readonly voice?: string;
  /** Tonal context of the generation, if known (the generator knows its key). */
  readonly key?: { readonly tonic: string; readonly mode?: string };
  readonly origin?: "corpus" | "generated";
}

/** A generated (or any) MusicIR melody as a MelodyLine. Bars come from the document meter, starting at 0. */
export function melodyFromIR(ir: MusicIR, options: IRMelodyOptions = {}): MelodyLine {
  const voice = options.voice ?? ir.voices.find((v) => v.role === "melody")?.id ?? ir.voices[0]?.id;
  const raw = ir.events.filter((e) => e.voice === voice);
  const unit = ir.meter ? parseFraction(ir.meter.unit) : frac(1, 4);
  const meterParsed = { beats: ir.meter ? ir.meter.groups.reduce((x, y) => x + y, 0) : 4, beatType: unit.num === 1 ? unit.den : Math.round(unit.den / unit.num) };
  const barLen = frac(meterParsed.beats, meterParsed.beatType);
  const last = raw.reduce<Fraction>((m, e) => {
    const end = fadd(parseFraction(e.onset), parseFraction(e.duration));
    return fcmp(end, m) > 0 ? end : m;
  }, ZERO);
  const barCount = Math.max(1, Math.ceil(fnum(last) / fnum(barLen) - 1e-9));
  const bars: MelodyBar[] = Array.from({ length: barCount }, (_, i) => ({
    index: i,
    number: String(i + 1),
    onset: frac(i * barLen.num, barLen.den),
    length: barLen,
    startPhase: ZERO,
    pickup: false,
    meter: meterParsed,
    beat: beatOf(meterParsed),
  }));
  const events: MelodyEvent[] = raw.map((e, index) => {
    const onset = parseFraction(e.onset);
    const duration = parseFraction(e.duration);
    const barIndex = Math.min(barCount - 1, Math.floor(fnum(onset) / fnum(barLen) + 1e-9));
    const phase = fsub(onset, bars[barIndex]!.onset);
    const weight = metricWeight(phase, meterParsed);
    if (e.kind === "rest") return { kind: "rest", id: e.id, index, onset, duration, end: fadd(onset, duration), bar: barIndex, phase, weight, suspect: false };
    return { kind: "note", id: e.id, index, midi: e.pitch.midi, name: e.pitch.name, onset, duration, end: fadd(onset, duration), bar: barIndex, phase, weight, tiedParts: 1, marks: [] };
  });
  const tonal: TonalContext | null = options.key
    ? (() => {
        try {
          return { tonicPc: pitchClass(parseNote(options.key!.tonic)), ...(options.key!.mode ? { mode: options.key!.mode } : {}), source: "hint" as const, confidence: 0.9 };
        } catch {
          return null;
        }
      })()
    : null;
  return finish({ id: ir.id, title: ir.title ?? ir.id, origin: options.origin ?? "generated", tuning: "12-tet", bars, events, chords: chordsFrom(ir.chords), tonal, length: last });
}
