/**
 * Semantic verification of MusicIR: things that are only wrong when two parts of the
 * document are read TOGETHER. The structural validator (validate.ts) checks that each
 * field is well formed; this checks that they agree.
 *
 *  1. Fretted positions. A note on string S at fret F sounds (open pitch of S) + F.
 *     That must equal the note's stated pitch, under the tuning the document states
 *     for that voice's instrument. A position with no stated tuning cannot be verified,
 *     so it is an error rather than being trusted. Strings must exist, frets must respect
 *     the document's own playability constraint, and a string cannot sound two notes at
 *     once.
 *  2. Chord annotations against events. For every chord segment: the root is the first
 *     tone; a triad's quality and symbol follow from its tones; every note that starts
 *     under the chord is a chord tone (spelled the way the chord spells it) unless a
 *     melodic role explains it; harmonic roles name the right tone; the lowest sounding
 *     note matches the stated inversion; and the notes come from the chord's stated voicing.
 *
 * All checks are about the document contradicting itself; none judges musical taste.
 */
import { MusicTheoryError } from "../errors";
import { formatNote, midi, parseNote, parsePitch, pitchClass, type Note } from "../theory/pitch";
import { fadd, fcmp, flt, parseFraction, type Fraction } from "../time/rational";
import type { IRChordSegment, IRIssue, IRNoteEvent, IRVoicedNote, MusicIR } from "./types";

const TRIAD_QUALITY: Record<string, { semis: [number, number]; suffix: string }> = {
  major: { semis: [4, 7], suffix: "" },
  minor: { semis: [3, 7], suffix: "m" },
  diminished: { semis: [3, 6], suffix: "dim" },
  augmented: { semis: [4, 8], suffix: "aug" },
};
const ROLE_INDEX: Record<string, number> = { root: 0, third: 1, fifth: 2, seventh: 3 };

const tryNote = (name: string): Note | null => {
  try {
    return parseNote(name);
  } catch (e) {
    if (e instanceof MusicTheoryError) return null;
    throw e;
  }
};

/** Open-string MIDI numbers per voice id, from the tunings the document states. */
function voiceTunings(ir: MusicIR, bad: (path: string, message: string) => void): Map<string, number[]> {
  const out = new Map<string, number[]>();
  ir.voices.forEach((v, i) => {
    const names = v.instrument?.tuning;
    if (!names) return;
    const opens: number[] = [];
    let ok = true;
    names.forEach((n, k) => {
      try {
        opens.push(midi(parsePitch(n)));
      } catch {
        ok = false;
        bad(`voices[${i}].instrument.tuning[${k}]`, `"${n}" is not a pitch name`);
      }
    });
    if (ok && opens.length > 0) out.set(v.id, opens);
  });
  return out;
}

/** Issues where the document contradicts itself. Assumes it already passed structural validation. */
export function verifyMusicIRSemantics(ir: MusicIR): IRIssue[] {
  const issues: IRIssue[] = [];
  const bad = (path: string, message: string) => void issues.push({ path, message });
  const tunings = voiceTunings(ir, bad);
  const voiceInstrument = new Map(ir.voices.map((v) => [v.id, v.instrument] as const));

  // ── 1. fretted positions ────────────────────────────────────────────────
  const guitarConstraint = ir.constraints.find((c) => c.kind === "guitar-playability");
  const maxFret = typeof guitarConstraint?.params.maxFret === "number" ? guitarConstraint.params.maxFret : undefined;
  const minFret = typeof guitarConstraint?.params.minFret === "number" ? guitarConstraint.params.minFret : undefined;

  // The constraint and the voices must agree about the tuning, if both state one.
  const constraintTuning = guitarConstraint?.params.tuning;
  if (Array.isArray(constraintTuning)) {
    ir.voices.forEach((v, i) => {
      const t = v.instrument?.tuning;
      if (t && (t.length !== constraintTuning.length || t.some((n, k) => n !== constraintTuning[k]))) {
        bad(`voices[${i}].instrument.tuning`, `voice tuning [${t.join(" ")}] disagrees with the playability constraint's tuning [${constraintTuning.join(" ")}]`);
      }
    });
  }

  const checkPosition = (path: string, voiceId: string, pos: { string: number; fret: number }, pitch: { name: string; midi: number }) => {
    const opens = tunings.get(voiceId);
    if (!opens) {
      bad(`${path}.instrument`, `string ${pos.string} fret ${pos.fret} cannot be verified: voice "${voiceId}" states no tuning`);
      return;
    }
    if (pos.string < 0 || pos.string >= opens.length) {
      bad(`${path}.instrument.string`, `string ${pos.string} does not exist: the tuning has ${opens.length} strings (0-${opens.length - 1})`);
      return;
    }
    const sounds = opens[pos.string]! + pos.fret;
    if (sounds !== pitch.midi) {
      bad(
        `${path}.instrument`,
        `string ${pos.string} fret ${pos.fret} sounds MIDI ${sounds} under tuning [${voiceInstrument.get(voiceId)?.tuning?.join(" ")}], but the note is ${pitch.name} (MIDI ${pitch.midi})`,
      );
    }
    if (maxFret !== undefined && pos.fret > maxFret) bad(`${path}.instrument.fret`, `fret ${pos.fret} is above the document's own maxFret ${maxFret}`);
    if (minFret !== undefined && pos.fret < minFret) bad(`${path}.instrument.fret`, `fret ${pos.fret} is below the document's own minFret ${minFret}`);
  };

  const notes: { ev: IRNoteEvent; i: number }[] = [];
  ir.events.forEach((ev, i) => {
    if (ev.kind !== "note") return;
    notes.push({ ev, i });
    if (ev.instrument) checkPosition(`events[${i}]`, ev.voice, ev.instrument, ev.pitch);
  });
  ir.chords.forEach((c, ci) =>
    c.voicing?.forEach((vn, k) => {
      if (vn.instrument) checkPosition(`chords[${ci}].voicing[${k}]`, vn.voice, vn.instrument, vn.pitch);
    }),
  );

  // a string can sound one note at a time (per instrument)
  type Span = { start: Fraction; end: Fraction; i: number };
  const byString = new Map<string, Span[]>();
  for (const { ev, i } of notes) {
    if (!ev.instrument) continue;
    const key = `${voiceInstrument.get(ev.voice)?.name ?? "?"}#${ev.instrument.string}`;
    const start = parseFraction(ev.onset);
    const list = byString.get(key) ?? [];
    list.push({ start, end: fadd(start, parseFraction(ev.duration)), i });
    byString.set(key, list);
  }
  for (const [key, spans] of byString) {
    spans.sort((a, b) => fcmp(a.start, b.start));
    for (let k = 1; k < spans.length; k++) {
      if (flt(spans[k]!.start, spans[k - 1]!.end)) {
        bad(`events[${spans[k]!.i}]`, `string ${key.split("#")[1]} is already sounding events[${spans[k - 1]!.i}]; a string cannot play two notes at once`);
      }
    }
  }

  // ── 2. chord annotations against events ─────────────────────────────────
  ir.chords.forEach((c, ci) => verifyChord(ir, c, ci, notes, bad));
  return issues;
}

function verifyChord(
  ir: MusicIR,
  c: IRChordSegment,
  ci: number,
  allNotes: { ev: IRNoteEvent; i: number }[],
  bad: (path: string, message: string) => void,
): void {
  const path = `chords[${ci}]`;
  const tones: Note[] = [];
  for (const [k, name] of c.tones.entries()) {
    const n = tryNote(name);
    if (!n) return void bad(`${path}.tones[${k}]`, `"${name}" is not a note name`);
    tones.push(n);
  }
  const tonePcs = tones.map(pitchClass);

  // root, quality, symbol
  const root = tryNote(c.root);
  if (!root) bad(`${path}.root`, `"${c.root}" is not a note name`);
  else if (formatNote(root) !== formatNote(tones[0]!)) {
    bad(`${path}.root`, `root ${c.root} is not the first chord tone (${formatNote(tones[0]!)})`);
  }
  if (tones.length === 3) {
    const third = (tonePcs[1]! - tonePcs[0]! + 12) % 12;
    const fifth = (tonePcs[2]! - tonePcs[0]! + 12) % 12;
    const derived = Object.entries(TRIAD_QUALITY).find(([, q]) => q.semis[0] === third && q.semis[1] === fifth)?.[0];
    if (derived && TRIAD_QUALITY[c.quality] && derived !== c.quality) {
      bad(`${path}.quality`, `quality says ${c.quality}, but the tones ${c.tones.join(" ")} form a ${derived} triad`);
    }
    const stated = TRIAD_QUALITY[c.quality];
    if (stated && c.symbol !== `${c.root}${stated.suffix}`) {
      bad(`${path}.symbol`, `symbol "${c.symbol}" does not match root ${c.root} + quality ${c.quality} (expected "${c.root}${stated.suffix}")`);
    }
  }

  // notes that start under this chord
  const start = parseFraction(c.onset);
  const end = fadd(start, parseFraction(c.duration));
  const under = allNotes.filter(({ ev }) => {
    const o = parseFraction(ev.onset);
    return !flt(o, start) && flt(o, end);
  });

  const voicing: readonly IRVoicedNote[] | undefined = c.voicing;
  const voicingKeys = new Set(voicing?.map((v) => `${v.voice}|${v.pitch.midi}`));
  voicing?.forEach((vn, k) => {
    if (!tonePcs.includes(((vn.pitch.midi % 12) + 12) % 12)) {
      bad(`${path}.voicing[${k}]`, `${vn.pitch.name} is not a tone of ${c.symbol} (${c.tones.join(" ")})`);
    }
  });

  for (const { ev, i } of under) {
    const p = `events[${i}]`;
    const pc = ((ev.pitch.midi % 12) + 12) % 12;
    const toneIdx = tonePcs.indexOf(pc);
    if (toneIdx < 0) {
      if (!ev.roles?.melodic) {
        bad(p, `${ev.pitch.name} is not a tone of ${c.symbol} (${c.tones.join(" ")}) and has no melodic role to explain it`);
      }
    } else {
      // spelled the way the chord spells that tone (Gb is not F#)
      const spelled = tryNote(ev.pitch.name.replace(/-?\d+$/, ""));
      if (spelled && formatNote(spelled) !== formatNote(tones[toneIdx]!)) {
        bad(p, `${ev.pitch.name} is spelled differently from the chord's ${formatNote(tones[toneIdx]!)}: they are the same sound but a different note name`);
      }
    }
    const role = ev.roles?.harmonic;
    if (role !== undefined && role in ROLE_INDEX && ROLE_INDEX[role]! < tones.length) {
      if (pc !== tonePcs[ROLE_INDEX[role]!]) {
        bad(`${p}.roles.harmonic`, `labelled ${role} of ${c.symbol}, but the ${role} is ${c.tones[ROLE_INDEX[role]!]} and the note is ${ev.pitch.name}`);
      }
    }
    if (voicing && !voicingKeys.has(`${ev.voice}|${ev.pitch.midi}`)) {
      bad(p, `${ev.pitch.name} in voice "${ev.voice}" is not part of ${c.symbol}'s stated voicing`);
    }
  }

  // inversion: the lowest sounding note is the stated chord tone
  if (c.inversion !== undefined) {
    if (!Number.isInteger(c.inversion) || c.inversion < 0 || c.inversion >= tones.length) {
      bad(`${path}.inversion`, `inversion ${c.inversion} is impossible for a chord of ${tones.length} tones`);
    } else {
      const pitches = voicing ? voicing.map((v) => v.pitch.midi) : under.map(({ ev }) => ev.pitch.midi);
      if (pitches.length > 0) {
        const bass = Math.min(...pitches);
        if (((bass % 12) + 12) % 12 !== tonePcs[c.inversion]) {
          bad(`${path}.inversion`, `inversion ${c.inversion} puts ${c.tones[c.inversion]} in the bass, but the lowest note is MIDI ${bass}`);
        }
      }
    }
  }
}
