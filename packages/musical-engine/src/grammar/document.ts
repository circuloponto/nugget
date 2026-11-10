/**
 * Phrase → MusicIR, and editing a phrase document.
 *
 * The events stay the single source of truth for pitch and time. The `semantics` section only
 * REFERENCES them by id: targets, per-note functions across the four dimensions, gestures with
 * the construction steps that built them, and the phrase itself. A saved document therefore
 * shows how it was constructed and can be edited note by note.
 *
 * Editing never pretends a gesture still holds: a gesture touched by an edit is demoted to
 * provenance "user", and only generated gestures are held to their structural invariants
 * (see verify.ts).
 */
import { makeFretboard, makeTuning, positionsForMidi, STANDARD_TUNING, type Tuning } from "../instrument/fretboard";
import { formatNote, formatPitch, midi, parsePitch, pitchFromMidi, type Note } from "../theory/pitch";
import { fadd, fstr, parseFraction, type Fraction } from "../time/rational";
import { normalizeMusicIR, validateMusicIR } from "../ir/validate";
import {
  MUSIC_IR_SEMANTICS_VERSION,
  MUSIC_IR_VERSION,
  type IRChordSegment,
  type IREvent,
  type IRGesture,
  type IRIssue,
  type IRNoteEvent,
  type IRNoteFunctions,
  type IRTarget,
  type MusicIR,
} from "../ir/types";
import { chordFromSegment, classifyPitch, classifyPitchClass, degreeOf, nearestPitch } from "./chords";
import { isNote, type LineNote } from "./line";
import { spellInSpace, type PitchSpace } from "./operations";
import type { PhraseCandidate, PhraseSpec, ProgressionChord } from "./phrase";

export interface PhraseDocOptions {
  readonly id?: string;
  readonly title?: string;
  /** Beats per minute (quarter notes). Default 100. */
  readonly bpm?: number;
  /** Add a simple bass voice playing each chord's root. Default true. */
  readonly bass?: boolean;
  /** Free-form request summary stored with the generating transformation, so the editor can restore its controls. */
  readonly request?: Readonly<Record<string, unknown>>;
}

const MELODY = "melody";
const BASS = "bass";

const velocityOf = (accent: number): number => Math.min(1, 0.6 + 0.1 * accent);

export function chordSegmentOf(p: ProgressionChord, index: number): IRChordSegment {
  return {
    id: `c-${index}`,
    onset: fstr(p.onset),
    duration: fstr(p.duration),
    symbol: p.chord.symbol,
    ...(p.roman ? { roman: p.roman } : {}),
    quality: p.chord.quality,
    root: formatNote(p.chord.root),
    tones: p.chord.tones.map(formatNote),
  };
}

/** The IR notes of a candidate, with their positions on the guitar. */
function melodyEvents(events: readonly (LineNote | { kind: "rest"; id: string; onset: Fraction; duration: Fraction })[]): IREvent[] {
  return events.map((e) =>
    e.kind === "rest"
      ? { id: e.id, kind: "rest" as const, voice: MELODY, onset: fstr(e.onset), duration: fstr(e.duration) }
      : {
          id: e.id,
          kind: "note" as const,
          voice: MELODY,
          pitch: { name: formatPitch(e.pitch), midi: midi(e.pitch) },
          onset: fstr(e.onset),
          duration: fstr(e.duration),
          velocity: velocityOf(e.accent),
          accent: e.accent,
          roles: {
            ...(e.functions.harmonic[0] ? { harmonic: e.functions.harmonic[0] } : {}),
            ...(e.functions.melodic[0] ? { melodic: e.functions.melodic[0] } : {}),
            metric: e.functions.metric,
            ...(e.functions.structural[0] ? { structural: e.functions.structural[0] } : {}),
          },
          ...(e.position ? { instrument: { string: e.position.string, fret: e.position.fret } } : {}),
          provenance: { status: "generated" as const, source: "t-phrase" },
        },
  );
}

/** Turn a generated candidate into a complete MusicIR document, semantic layer included. */
export function phraseToIR(candidate: PhraseCandidate, spec: PhraseSpec, opts: PhraseDocOptions = {}): MusicIR {
  const tuning: Tuning = spec.tuning ?? STANDARD_TUNING;
  const tuningNames = tuning.strings.map(formatPitch);
  const chords = spec.progression.map(chordSegmentOf);
  const events: IREvent[] = melodyEvents(candidate.events as never);

  if (opts.bass !== false) {
    spec.progression.forEach((p, i) => {
      const root = nearestPitch(p.chord.root, 40);
      events.push({
        id: `n-bass-${i + 1}`,
        kind: "note",
        voice: BASS,
        pitch: { name: formatPitch(root), midi: midi(root) },
        onset: fstr(p.onset),
        duration: fstr(p.duration),
        velocity: 0.5,
        accent: 2,
        roles: { harmonic: "root", metric: "downbeat" },
        provenance: { status: "generated", source: "t-phrase" },
      });
    });
  }

  const notes = candidate.events.filter(isNote);
  const target = notes.find((n) => n.id === candidate.targetNote)!;
  const tIndex = spec.target.chordIndex;
  const targetEntry = spec.progression[tIndex]!;
  const targetDegree = degreeOf(targetEntry.chord, spec.target.degree);
  const tg: IRTarget = {
    id: "tg-1",
    chord: `c-${tIndex}`,
    degree: spec.target.degree,
    pitch: { name: formatPitch(target.pitch), midi: midi(target.pitch) },
    register: [spec.hard.register[0], spec.hard.register[1]],
    arrival: fstr(target.onset),
    metric: target.functions.metric,
    melodicRole: "arrival",
    harmonicRole: targetDegree.role,
    tension: "resolve",
    note: target.id,
  };

  const noteFunctions: IRNoteFunctions[] = notes.map((n) => ({
    note: n.id,
    harmonic: [...n.functions.harmonic],
    melodic: [...n.functions.melodic],
    metric: n.functions.metric,
    structural: [...n.functions.structural],
  }));

  const gestures: IRGesture[] = candidate.gestures.map((g) => ({
    id: g.id,
    kind: g.kind,
    notes: g.notes,
    ...(g.target ? { target: g.target } : {}),
    steps: g.steps,
    params: g.params,
    provenance: { status: "generated", source: "t-phrase" },
  }));

  const ir: MusicIR = {
    version: MUSIC_IR_VERSION,
    id: opts.id ?? `phrase-${candidate.id}`,
    title: opts.title ?? `${candidate.summary}`,
    tempo: { bpm: String(opts.bpm ?? 100), beat: "1/4" },
    meter: { groups: [1, 1, 1, 1], unit: "1/4" },
    voices: [
      { id: MELODY, name: "Melody", role: "melody", instrument: { name: "guitar", tuning: tuningNames } },
      ...(opts.bass !== false ? [{ id: BASS, name: "Bass", role: "bass" as const }] : []),
    ],
    events,
    chords,
    relations: [],
    constraints: [
      {
        id: "k-guitar",
        kind: "guitar-playability",
        params: { tuning: tuningNames, maxFret: spec.hard.fretRange?.[1] ?? 15, minFret: spec.hard.fretRange?.[0] ?? 0, maxFretShift: spec.hard.maxFretShift ?? 5 },
        note: "Playability is an approximation: strings, frets and hand shifts are checked, comfort for every hand is not.",
      },
    ],
    transformations: [
      {
        id: "t-phrase",
        op: "phrase-generate",
        params: { summary: candidate.summary, score: candidate.score.total, ...(opts.request ? { request: JSON.stringify(opts.request) } : {}) },
        outputs: notes.map((n) => n.id),
        provenance: { status: "generated", source: "phrase generator" },
      },
    ],
    semantics: {
      version: MUSIC_IR_SEMANTICS_VERSION,
      targets: [tg],
      noteFunctions,
      gestures,
      phrases: [{ id: "ph-1", notes: notes.map((n) => n.id), label: "generated phrase" }],
    },
  };
  return normalizeMusicIR(ir);
}

// ── editing ───────────────────────────────────────────────────────────────
export interface NoteEdit {
  /** New pitch as a MIDI number; the spelling is chosen from the chord and the scale. */
  readonly midi?: number;
  readonly onset?: Fraction;
  readonly duration?: Fraction;
}

export type EditResult = { readonly ok: true; readonly ir: MusicIR } | { readonly ok: false; readonly issues: IRIssue[] };

const chordAtOnset = (ir: MusicIR, onset: Fraction): IRChordSegment | undefined =>
  ir.chords.find((c) => {
    const s = parseFraction(c.onset);
    const e = fadd(s, parseFraction(c.duration));
    return s.num * onset.den <= onset.num * s.den && onset.num * e.den < e.num * onset.den;
  });

/**
 * Change a note's pitch, onset or duration. The pitch is respelled in context, the fret position
 * is re-chosen (same string if the note is reachable there), its harmonic role is recomputed from
 * the chord, every gesture that contains it becomes a user gesture, and the whole document is
 * validated again; an edit that would make the document invalid is refused with the reasons.
 */
export function editPhraseNote(ir: MusicIR, noteId: string, edit: NoteEdit, space: PitchSpace = { scale: [] }): EditResult {
  const old = ir.events.find((e): e is IRNoteEvent => e.kind === "note" && e.id === noteId);
  if (!old) return { ok: false, issues: [{ path: noteId, message: `no note with id "${noteId}"` }] };

  const onset = edit.onset ?? parseFraction(old.onset);
  const duration = edit.duration ?? parseFraction(old.duration);
  const seg = chordAtOnset(ir, onset);
  const chord = seg ? chordFromSegment(seg) : null;

  let pitch = old.pitch;
  let roles = old.roles ?? {};
  let instrument = old.instrument;
  if (edit.midi !== undefined && edit.midi !== old.pitch.midi) {
    const byEar = chord ? classifyPitchClass(chord, edit.midi) : null;
    const spelled = byEar && byEar.kind === "chord-tone" ? pitchFromMidi(edit.midi, byEar.note as Note) : spellInSpace(edit.midi, space, parsePitch(old.pitch.name));
    pitch = { name: formatPitch(spelled), midi: edit.midi };
    const deg = chord ? classifyPitch(chord, spelled) : null;
    const harmonic = deg ? deg.role : undefined;
    const { harmonic: _h, ...rest } = roles;
    void _h;
    roles = { ...rest, ...(harmonic ? { harmonic } : {}), ...(!harmonic && !rest.melodic ? { melodic: "user-note" } : {}) };
    const voice = ir.voices.find((v) => v.id === old.voice);
    if (old.instrument && voice?.instrument?.tuning) {
      const names = voice.instrument.tuning;
      const fb = makeFretboard(makeTuning("document", names), 24);
      const options = positionsForMidi(fb, edit.midi, 0, 24);
      const best = [...options].sort((a, b) => Math.abs(a.fret - old.instrument!.fret) + 2 * Math.abs(a.string - old.instrument!.string) - (Math.abs(b.fret - old.instrument!.fret) + 2 * Math.abs(b.string - old.instrument!.string)))[0];
      instrument = best;
    }
  } else if (chord && edit.onset) {
    const deg = classifyPitch(chord, parsePitch(old.pitch.name));
    const { harmonic: _h, ...rest } = roles;
    void _h;
    roles = { ...rest, ...(deg ? { harmonic: deg.role } : {}) };
  }

  const updated: IRNoteEvent = {
    ...old,
    pitch,
    onset: fstr(onset),
    duration: fstr(duration),
    roles,
    ...(instrument ? { instrument } : {}),
    provenance: { status: "user", source: "edit" },
  };
  const sem = ir.semantics;
  const editedTargets = new Set((sem?.targets ?? []).filter((t) => t.note === noteId).map((t) => t.id));
  const nextSem = sem
    ? {
        ...sem,
        gestures: sem.gestures?.map((g) => (g.notes.includes(noteId) || (g.target !== undefined && editedTargets.has(g.target)) ? { ...g, provenance: { status: "user" as const, source: "edit" } } : g)),
        noteFunctions: sem.noteFunctions?.map((f) =>
          f.note === noteId
            ? {
                ...f,
                harmonic: (() => {
                  const d = chord ? classifyPitch(chord, parsePitch(pitch.name)) : null;
                  return d ? [d.role] : [];
                })(),
                metric: roles.metric ?? f.metric,
              }
            : f,
        ),
        targets: sem.targets?.map((t) => {
          if (t.note !== noteId) return t;
          const tc = ir.chords.find((c) => c.id === t.chord);
          const tchord = tc ? chordFromSegment(tc) : null;
          const d = tchord ? classifyPitch(tchord, parsePitch(pitch.name)) : null;
          return { ...t, pitch, arrival: fstr(onset), degree: d ? d.label : "non-chord", ...(d ? { harmonicRole: d.role } : {}) };
        }),
      }
    : sem;

  const next: MusicIR = normalizeMusicIR({
    ...ir,
    events: ir.events.map((e) => (e.id === noteId ? updated : e)),
    ...(nextSem ? { semantics: nextSem } : {}),
  });
  const issues = validateMusicIR(next);
  return issues.length ? { ok: false, issues } : { ok: true, ir: next };
}

export const noteIdsOf = (ir: MusicIR, voice = MELODY): string[] => ir.events.filter((e): e is IRNoteEvent => e.kind === "note" && e.voice === voice).map((e) => e.id);
