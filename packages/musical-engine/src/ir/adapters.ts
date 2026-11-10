/**
 * Adapters from the harmonic/guitar engine into MusicIR, and back to pitches.
 * The engine's own objects stay as they are; the IR is a view that can also be
 * stored, exchanged and validated.
 */
import { MusicTheoryError } from "../errors";
import { formatNote, formatPitch, isSameNote, midi, parsePitch, type Pitch } from "../theory/pitch";
import { type Scale } from "../theory/scale";
import { type CyclePlan } from "../instrument/voiceLeading";
import { type GuitarVoicing } from "../instrument/realize";
import { type PlayabilityConstraints } from "../instrument/playability";
import { type Tuning } from "../instrument/fretboard";
import { type TriadVoicing } from "../theory/voicing";
import { fadd, fmul, frac, fstr, parseFraction, ZERO, type Fraction } from "../time/rational";
import {
  MUSIC_IR_VERSION,
  type IRChordSegment,
  type IRNoteEvent,
  type IRRelation,
  type IRVoice,
  type MusicIR,
} from "./types";

const QUARTER = frac(1, 4);

export interface IRTempoInput {
  /** Beats per minute: an integer, or an exact fraction. */
  bpm: number | Fraction;
  /** Beat unit as a fraction of a whole note. Default 1/4. */
  beat?: Fraction;
}

function tempoToIR(t: IRTempoInput) {
  const bpm = typeof t.bpm === "number" ? frac(t.bpm) : t.bpm;
  return { bpm: fstr(bpm), beat: fstr(t.beat ?? QUARTER) };
}

const VOICE_ROLES = ["bass", "inner", "upper"] as const;

function voicesFor(count: number, tuning?: readonly string[]): IRVoice[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `v${i + 1}`,
    name: i === 0 ? "voice 1 (bass)" : i === count - 1 ? `voice ${i + 1} (top)` : `voice ${i + 1}`,
    role: count === 3 ? VOICE_ROLES[i] : i === 0 ? "bass" : i === count - 1 ? "upper" : "inner",
    ...(tuning ? { instrument: { name: "guitar", tuning } } : {}),
  }));
}

export interface IRStep {
  readonly voicing: TriadVoicing;
  readonly guitar?: GuitarVoicing;
}

function chordAndNotes(
  index: number,
  step: IRStep,
  onset: Fraction,
  duration: Fraction,
  scale: Scale | undefined,
): { chord: IRChordSegment; notes: IRNoteEvent[] } {
  const { voicing } = step;
  const t = voicing.triad;
  const chord: IRChordSegment = {
    id: `chord-${index}`,
    onset: fstr(onset),
    duration: fstr(duration),
    symbol: t.symbol,
    roman: t.roman,
    quality: t.quality,
    root: formatNote(t.root),
    tones: t.notes.map(formatNote),
    inversion: voicing.inversion,
    ...(scale ? { key: { tonic: formatNote(scale.tonic), scale: scale.type } } : {}),
    provenance: { status: "generated" },
  };
  const notes: IRNoteEvent[] = voicing.pitches.map((p, v) => {
    const role = isSameNote(p, t.root) ? "root" : isSameNote(p, t.third) ? "third" : "fifth";
    const spot = step.guitar?.notes[v];
    return {
      id: `n-${index}-${v}`,
      kind: "note",
      voice: `v${v + 1}`,
      pitch: { name: formatPitch(p), midi: midi(p) },
      onset: fstr(onset),
      duration: fstr(duration),
      roles: { harmonic: role },
      ...(spot ? { instrument: { string: spot.string, fret: spot.fret } } : {}),
      provenance: { status: "generated" },
    };
  });
  return { chord, notes };
}

export interface TriadIROptions {
  id?: string;
  /** Default 0. */
  onset?: Fraction;
  /** Default 1/4. */
  duration?: Fraction;
  key?: Scale;
  guitar?: GuitarVoicing;
  tempo?: IRTempoInput;
  tuning?: Tuning;
}

/** One triad voicing (optionally with its guitar realization) as a MusicIR document. */
export function triadVoicingToIR(voicing: TriadVoicing, options: TriadIROptions = {}): MusicIR {
  const { id = "triad", onset = ZERO, duration = QUARTER, key, guitar, tempo, tuning } = options;
  const { chord, notes } = chordAndNotes(0, { voicing, guitar }, onset, duration, key);
  return {
    version: MUSIC_IR_VERSION,
    id,
    ...(tempo ? { tempo: tempoToIR(tempo) } : {}),
    voices: voicesFor(voicing.pitches.length, tuning && guitar ? tuning.strings.map(formatPitch) : undefined),
    events: notes,
    chords: [chord],
    relations: [],
    constraints: [],
    transformations: [],
  };
}

export interface CycleIROptions {
  id?: string;
  /** Length of each chord. Default 1/4 (one beat). */
  chordDuration?: Fraction;
  tempo?: IRTempoInput;
  /** Guitar limits to record as a constraint (only when steps carry guitar positions). */
  constraints?: PlayabilityConstraints;
  tuning?: Tuning;
  /** The last chord leads back into the first (a closed loop). */
  loop?: boolean;
}

/**
 * A diatonic cycle (a sequence of voicings, optionally with guitar positions) as
 * MusicIR: chord segments on a timeline, one note per voice per chord, voice-leading
 * relations between consecutive chords, the producing transformation, and the
 * playability limits as a constraint.
 */
export function cycleToIR(scale: Scale, cycleId: number, steps: readonly IRStep[], options: CycleIROptions = {}): MusicIR {
  const { id = `cycle-${cycleId}`, chordDuration = QUARTER, tempo, constraints, tuning, loop = false } = options;
  if (steps.length === 0) throw new MusicTheoryError("cycleToIR needs at least one step");
  const voiceCount = steps[0]!.voicing.pitches.length;
  if (steps.some((s) => s.voicing.pitches.length !== voiceCount)) {
    throw new MusicTheoryError("every step must have the same number of voices");
  }
  const hasGuitar = steps.every((s) => s.guitar !== undefined);

  const chords: IRChordSegment[] = [];
  const events: IRNoteEvent[] = [];
  steps.forEach((step, i) => {
    const onset = fmul(chordDuration, frac(i));
    const { chord, notes } = chordAndNotes(i, step, onset, chordDuration, scale);
    chords.push(chord);
    events.push(...notes);
  });

  const relations: IRRelation[] = [];
  const link = (a: number, b: number, v: number, closing: boolean) => {
    const from = events[a * voiceCount + v]!;
    const to = events[b * voiceCount + v]!;
    relations.push({
      id: `r-vl-${b}-${v}${closing ? "-closing" : ""}`,
      kind: "voice-leading",
      from: from.id,
      to: to.id,
      data: { semitones: to.pitch.midi - from.pitch.midi, ...(closing ? { closing: true } : {}) },
    });
  };
  for (let i = 1; i < steps.length; i++) for (let v = 0; v < voiceCount; v++) link(i - 1, i, v, false);
  if (loop && steps.length > 1) for (let v = 0; v < voiceCount; v++) link(steps.length - 1, 0, v, true);

  const transformationId = "t-cycle";
  return {
    version: MUSIC_IR_VERSION,
    id,
    title: `${formatNote(scale.tonic)} ${scale.type}: cycle ${cycleId}`,
    ...(tempo ? { tempo: tempoToIR(tempo) } : {}),
    voices: voicesFor(voiceCount, hasGuitar && tuning ? tuning.strings.map(formatPitch) : undefined),
    events,
    chords,
    relations,
    constraints:
      hasGuitar && constraints
        ? [
            {
              id: "c-guitar",
              kind: "guitar-playability",
              params: {
                minFret: constraints.minFret,
                maxFret: constraints.maxFret,
                maxFretSpan: constraints.maxFretSpan,
                maxFingers: constraints.maxFingers,
                allowOpenStrings: constraints.allowOpenStrings,
                requireContiguousStrings: constraints.requireContiguousStrings,
                requireAscendingStrings: constraints.requireAscendingStrings,
                ...(tuning ? { tuning: tuning.strings.map(formatPitch) } : {}),
              },
              note: "Approximation: checks string order, fret stretch, pitch accuracy and an estimated finger count. Valid under these limits is not a guarantee of ergonomic playability.",
            },
          ]
        : [],
    transformations: [
      {
        id: transformationId,
        op: "diatonic-cycle",
        params: {
          cycle: cycleId,
          key: `${formatNote(scale.tonic)} ${scale.type}`,
          chords: steps.length,
          loop,
        },
        outputs: chords.map((c) => c.id),
        provenance: { status: "generated" },
      },
    ],
  };
}

/**
 * A planned cycle (from planCycleOnGuitar / planPerfectCycleLoop) as MusicIR. Uses the
 * pitches actually played (after octave shifts) and the guitar positions when the
 * plan succeeded; otherwise the theoretical voicings.
 */
export function cyclePlanToIR(scale: Scale, cycleId: number, plan: CyclePlan, options: CycleIROptions = {}): MusicIR {
  const steps: IRStep[] = plan.path.ok
    ? plan.path.steps.map((s) => ({ voicing: s.voicing, guitar: s.guitar }))
    : plan.cycle.map((s) => ({ voicing: s.voicing }));
  const loop = options.loop ?? (plan.path.ok && plan.path.closingCost !== undefined);
  return cycleToIR(scale, cycleId, steps, { ...options, loop });
}

/** The pitches of one chord segment as sounded (bass first), read back from the notes in the document. */
export function irChordPitches(ir: MusicIR, chordId: string): Pitch[] {
  const chord = ir.chords.find((c) => c.id === chordId);
  if (!chord) throw new MusicTheoryError(`No chord segment "${chordId}"`);
  const start = parseFraction(chord.onset);
  const end = fadd(start, parseFraction(chord.duration));
  return ir.events
    .filter((e): e is IRNoteEvent => e.kind === "note")
    .filter((e) => {
      const o = parseFraction(e.onset);
      return o.num * start.den >= start.num * o.den && o.num * end.den < end.num * o.den;
    })
    .sort((a, b) => a.pitch.midi - b.pitch.midi)
    .map((e) => parsePitch(e.pitch.name));
}
