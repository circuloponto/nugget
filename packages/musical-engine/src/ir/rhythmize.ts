/**
 * Rhythm for a MusicIR progression. `rhythmizeIR` re-times a document: every chord segment
 * is filled with the notes of its voicing according to a step pattern (see time/steps.ts),
 * scaled exactly to that chord's duration. It works on ANY document that has chord segments,
 * generated here or loaded from a file, and only touches events, voice-leading relations and
 * the rhythm transformation record; harmony, voices, tempo, meter and constraints are kept.
 *
 * The voicing is read from the chord segment (`chord.voicing`); for a document that lacks
 * one, from the first note of each voice under the chord. Because the voicing is not derived
 * from the previous events, applying one rhythm after another never loses a voice.
 */
import { MusicTheoryError } from "../errors";
import { parseNote, pitchClass } from "../theory/pitch";
import { fadd, fmul, frac, fstr, parseFraction } from "../time/rational";
import { cellFromSteps, stepsFromString, stepsToString } from "../time/steps";
import { normalizeMusicIR } from "./validate";
import type { IRChordSegment, IRNoteEvent, IRRelation, IRVoicedNote, MusicIR } from "./types";

/** How a hit is spread over the chord's voices. */
export type RhythmMode = "block" | "arpeggio" | "bass-chord";

export const RHYTHM_MODES: readonly { id: RhythmMode; name: string; hint: string }[] = [
  { id: "block", name: "Block chord", hint: "every hit sounds all the voices" },
  { id: "arpeggio", name: "Arpeggio", hint: "each hit sounds the next voice, bass to top" },
  { id: "bass-chord", name: "Bass + chord", hint: "first hit is the bass alone, the rest are the upper voices" },
];

export interface RhythmSpec {
  /** Step pattern for one chord, e.g. "A..x..x." (see stepsFromString). */
  pattern: string;
  mode: RhythmMode;
  /** Fraction of each step a note sounds for, 0.05-1. Default 1. */
  gate?: number;
}

/** One attack per chord, held for the whole chord: how progressions sound before any rhythm is chosen. */
export const DEFAULT_RHYTHM: RhythmSpec = { pattern: "A---", mode: "block", gate: 1 };

export const RHYTHM_TRANSFORMATION_OP = "rhythm-pattern";

const ROLE_NAMES = ["root", "third", "fifth"] as const;

/** The chord's voices, lowest first. */
export function chordVoicing(ir: MusicIR, chord: IRChordSegment): IRVoicedNote[] {
  if (chord.voicing && chord.voicing.length > 0) {
    return [...chord.voicing].sort((a, b) => a.pitch.midi - b.pitch.midi);
  }
  // no stated voicing: the first note each voice plays under the chord
  const start = parseFraction(chord.onset);
  const end = fadd(start, parseFraction(chord.duration));
  const first = new Map<string, IRNoteEvent>();
  for (const e of ir.events) {
    if (e.kind !== "note") continue;
    const o = parseFraction(e.onset);
    if (o.num * start.den < start.num * o.den || o.num * end.den >= end.num * o.den) continue;
    const prev = first.get(e.voice);
    if (!prev || o.num * parseFraction(prev.onset).den < parseFraction(prev.onset).num * o.den) first.set(e.voice, e);
  }
  return [...first.values()]
    .sort((a, b) => a.pitch.midi - b.pitch.midi)
    .map((e) => ({ voice: e.voice, pitch: e.pitch, ...(e.instrument ? { instrument: e.instrument } : {}) }));
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Which voices (indices into the lowest-first voicing) sound on the j-th hit of a chord. */
function voicesForHit(mode: RhythmMode, hit: number, count: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  switch (mode) {
    case "block":
      return all;
    case "arpeggio":
      return [hit % count];
    case "bass-chord":
      return count === 1 ? all : hit === 0 ? [0] : all.slice(1);
  }
}

/** Re-time every chord of the document with the rhythm. Returns a new, canonical document. */
export function rhythmizeIR(ir: MusicIR, spec: RhythmSpec): MusicIR {
  const steps = stepsFromString(spec.pattern); // throws on a bad pattern
  const gate = clamp(spec.gate ?? 1, 0.05, 1);
  const gateFraction = frac(Math.round(gate * 100), 100);
  if (!RHYTHM_MODES.some((m) => m.id === spec.mode)) throw new MusicTheoryError(`Unknown rhythm mode "${spec.mode}"`);
  if (ir.chords.length === 0) return ir; // nothing to fill

  const events: IRNoteEvent[] = [];
  const firstNote: Map<string, string>[] = []; // per chord: voice id -> id of its first note
  const voicings: IRVoicedNote[][] = [];

  ir.chords.forEach((chord, ci) => {
    const voicing = chordVoicing(ir, chord);
    voicings.push(voicing);
    const firsts = new Map<string, string>();
    firstNote.push(firsts);
    if (voicing.length === 0) return;

    const tonePcs = chord.tones.map((t) => pitchClass(parseNote(t)));
    const onset0 = parseFraction(chord.onset);
    const cell = cellFromSteps(parseFraction(chord.duration), steps);
    let hit = 0;
    for (const e of cell.events) {
      if (e.rest) continue;
      const accent = e.accent ?? 1;
      for (const vi of voicesForHit(spec.mode, hit, voicing.length)) {
        const vn = voicing[vi]!;
        const toneIdx = tonePcs.indexOf(((vn.pitch.midi % 12) + 12) % 12);
        const id = `n-${ci}-${hit}-${vn.voice}`;
        events.push({
          id,
          kind: "note",
          voice: vn.voice,
          pitch: vn.pitch,
          onset: fstr(fadd(onset0, e.onset)),
          duration: fstr(fmul(e.duration, gateFraction)),
          velocity: Math.min(1, 0.55 + 0.15 * accent),
          accent,
          ...(toneIdx >= 0 && toneIdx < ROLE_NAMES.length && chord.tones.length >= 3 ? { roles: { harmonic: ROLE_NAMES[toneIdx]! } } : {}),
          ...(vn.instrument ? { instrument: vn.instrument } : {}),
          provenance: { status: "generated", source: "t-rhythm" },
        });
        if (!firsts.has(vn.voice)) firsts.set(vn.voice, id);
      }
      hit++;
    }
  });

  // voice leading: each voice's first note in a chord to its first note in the next chord
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const relations: IRRelation[] = [];
  const link = (a: number, b: number, closing: boolean) => {
    for (const [voice, fromId] of firstNote[a]!) {
      const toId = firstNote[b]!.get(voice);
      if (!toId) continue;
      relations.push({
        id: `r-vl-${b}-${voice}${closing ? "-closing" : ""}`,
        kind: "voice-leading",
        from: fromId,
        to: toId,
        data: { semitones: byId.get(toId)!.pitch.midi - byId.get(fromId)!.pitch.midi, ...(closing ? { closing: true } : {}) },
      });
    }
  };
  for (let i = 1; i < ir.chords.length; i++) link(i - 1, i, false);
  const wasLoop =
    ir.relations.some((r) => r.data?.closing === true) || ir.transformations.some((t) => t.params.loop === true);
  if (wasLoop && ir.chords.length > 1) link(ir.chords.length - 1, 0, true);

  // keep what is still valid of everything else
  const live = new Set<string>([
    ...ir.voices.map((v) => v.id),
    ...ir.chords.map((c) => c.id),
    ...ir.constraints.map((c) => c.id),
    ...events.map((e) => e.id),
  ]);
  const keptTransformations = ir.transformations.filter(
    (t) => t.op !== RHYTHM_TRANSFORMATION_OP && [...(t.inputs ?? []), ...t.outputs].every((id) => live.has(id)),
  );
  const rhythmTransformation = {
    id: "t-rhythm",
    op: RHYTHM_TRANSFORMATION_OP,
    params: { pattern: stepsToString(steps), grid: steps.length, mode: spec.mode, gate },
    inputs: ir.chords.map((c) => c.id),
    outputs: events.map((e) => e.id),
    provenance: { status: "user" as const },
  };
  const keptRelations = ir.relations.filter(
    (r) => r.kind !== "voice-leading" && live.has(r.from) && live.has(r.to),
  );

  return normalizeMusicIR({
    ...ir,
    events,
    relations: [...keptRelations, ...relations],
    transformations: [...keptTransformations, rhythmTransformation],
  });
}

/** The rhythm a document was built with (from its rhythm transformation), or null. */
export function rhythmSpecFromIR(ir: MusicIR): RhythmSpec | null {
  const t = ir.transformations.find((x) => x.op === RHYTHM_TRANSFORMATION_OP);
  if (!t) return null;
  const { pattern, mode, gate } = t.params;
  if (typeof pattern !== "string" || typeof mode !== "string") return null;
  if (!RHYTHM_MODES.some((m) => m.id === mode)) return null;
  try {
    stepsFromString(pattern);
  } catch {
    return null;
  }
  return { pattern, mode: mode as RhythmMode, gate: typeof gate === "number" ? gate : 1 };
}
