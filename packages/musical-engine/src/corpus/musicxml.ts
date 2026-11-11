/**
 * MusicXML (score-partwise, one monophonic part) → CorpusPiece, with a report.
 *
 * Principles
 *  - Nothing is corrected silently. A measure that does not add up, a tie with no partner, a duration that
 *    disagrees with the written note type: each is reported, and the score's own <duration> stays authoritative.
 *  - What the importer does not interpret is counted in `report.unsupported`, never ignored without a trace.
 *  - Only a file that cannot be read as a single monophonic line fails; everything else yields a piece plus issues.
 */
import { formatNote, midi as pitchMidi, transposeNote, type Letter, type Note } from "../theory/pitch";
import { fadd, fcmp, feq, fmul, frac, fstr, fsub, ZERO, type Fraction } from "../time/rational";
import { child, childText, childrenNamed, parseXml, XmlError, type XNode } from "./xml";
import {
  CORPUS_PIECE_FORMAT,
  CORPUS_PIECE_VERSION,
  type CorpusEvent,
  type CorpusGrace,
  type CorpusHarmony,
  type CorpusKey,
  type CorpusMeasure,
  type CorpusMeter,
  type CorpusNote,
  type CorpusPiece,
  type CorpusPitch,
  type CorpusProvenance,
  type ImportIssue,
  type ImportReport,
} from "./types";

export interface ImportContext {
  readonly pieceId: string;
  readonly provenance: Omit<CorpusProvenance, "contentHash" | "xml">;
  readonly tuning?: { readonly system: string; readonly referenceA4Hz?: number };
}

export type ImportResult = { readonly ok: true; readonly piece: CorpusPiece; readonly report: ImportReport } | { readonly ok: false; readonly report: ImportReport };

/** FNV-1a 32-bit, hex. A change detector, not a security digest. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_TYPES: Record<string, Fraction> = {
  long: frac(4),
  breve: frac(2),
  whole: frac(1),
  half: frac(1, 2),
  quarter: frac(1, 4),
  eighth: frac(1, 8),
  "16th": frac(1, 16),
  "32nd": frac(1, 32),
  "64th": frac(1, 64),
  "128th": frac(1, 128),
};

/** Semitone offsets and letter-step spellings of the chord kinds this importer interprets. */
const CHORD_KINDS: Record<string, { suffix: string; tones: readonly (readonly [number, number])[] }> = {
  major: { suffix: "", tones: [[2, 4], [4, 7]] },
  minor: { suffix: "m", tones: [[2, 3], [4, 7]] },
  augmented: { suffix: "aug", tones: [[2, 4], [4, 8]] },
  diminished: { suffix: "dim", tones: [[2, 3], [4, 6]] },
  dominant: { suffix: "7", tones: [[2, 4], [4, 7], [6, 10]] },
  "augmented-seventh": { suffix: "aug7", tones: [[2, 4], [4, 8], [6, 10]] },
  "major-seventh": { suffix: "maj7", tones: [[2, 4], [4, 7], [6, 11]] },
  "minor-seventh": { suffix: "m7", tones: [[2, 3], [4, 7], [6, 10]] },
  "diminished-seventh": { suffix: "dim7", tones: [[2, 3], [4, 6], [6, 9]] },
  "half-diminished": { suffix: "m7b5", tones: [[2, 3], [4, 6], [6, 10]] },
  "major-minor": { suffix: "mMaj7", tones: [[2, 3], [4, 7], [6, 11]] },
  "major-sixth": { suffix: "6", tones: [[2, 4], [4, 7], [5, 9]] },
  "minor-sixth": { suffix: "m6", tones: [[2, 3], [4, 7], [5, 9]] },
  "suspended-second": { suffix: "sus2", tones: [[1, 2], [4, 7]] },
  "suspended-fourth": { suffix: "sus4", tones: [[3, 5], [4, 7]] },
  power: { suffix: "5", tones: [[4, 7]] },
};

/** Position of the tonic on the line of fifths, relative to the key signature, for each mode. */
const MODE_OFFSET: Record<string, number> = { lydian: -1, major: 0, ionian: 0, mixolydian: 1, dorian: 2, minor: 3, aeolian: 3, phrygian: 4, locrian: 5 };
const LINE = ["F", "C", "G", "D", "A", "E", "B"] as const;
function lineOfFifthsName(pos: number): string {
  const idx = (((pos + 1) % 7) + 7) % 7;
  const acc = Math.floor((pos + 1) / 7);
  return LINE[idx]! + (acc > 0 ? "#".repeat(acc) : acc < 0 ? "b".repeat(-acc) : "");
}

const NOTE_KNOWN = new Set(["pitch", "rest", "duration", "type", "dot", "stem", "beam", "tie", "time-modification", "notations", "voice", "staff", "accidental", "grace", "chord", "notehead", "lyric", "cue", "unpitched", "instrument"]);
const NOTATION_MARKS = new Set(["fermata", "ornaments", "articulations", "slur", "technical", "dynamics", "arpeggiate", "glissando", "slide", "tied", "tuplet", "tremolo", "accidental-mark"]);
const MEASURE_KNOWN = new Set(["attributes", "note", "backup", "forward", "harmony", "barline", "direction", "print", "sound", "figured-bass", "grouping", "link", "bookmark"]);
const ATTRIBUTE_KNOWN = new Set(["divisions", "key", "time", "clef", "staves", "part-symbol", "instruments", "transpose", "staff-details", "measure-style", "for-part", "directive"]);

export function importMusicXml(xmlText: string, ctx: ImportContext): ImportResult {
  const issues: ImportIssue[] = [];
  const unsupported: Record<string, number> = {};
  const irLoss = new Set<string>();
  const count = (what: string) => void (unsupported[what] = (unsupported[what] ?? 0) + 1);
  const issue = (severity: ImportIssue["severity"], code: string, message: string, measure?: string, line?: number) =>
    void issues.push({ severity, code, message, ...(measure !== undefined ? { measure } : {}), ...(line !== undefined ? { line } : {}) });
  const counts = { measures: 0, notes: 0, rests: 0, tiedChains: 0, tupletNotes: 0, graceNotes: 0, harmonies: 0, repeats: 0, meterChanges: 0, keyChanges: 0 };
  const fail = (): ImportResult => ({ ok: false, report: { status: "failed", issues, unsupported, counts, irLoss: [...irLoss] } });

  let root: XNode;
  try {
    root = parseXml(xmlText);
  } catch (e) {
    issue("error", e instanceof XmlError ? "xml-malformed" : "xml-unreadable", e instanceof Error ? e.message : "unreadable XML");
    return fail();
  }
  if (root.name !== "score-partwise") {
    issue("error", root.name === "score-timewise" ? "timewise-unsupported" : "not-musicxml", `root element is <${root.name}>; only score-partwise is supported`);
    return fail();
  }
  const parts = childrenNamed(root, "part");
  if (parts.length === 0) {
    issue("error", "no-part", "the score has no <part>");
    return fail();
  }
  if (parts.length > 1) {
    issue("error", "multiple-parts", `the score has ${parts.length} parts; the corpus importer reads one monophonic line`);
    return fail();
  }
  const partNode = parts[0]!;

  // ── title and provenance details from the file ──────────────────────────
  const title = (childText(child(root, "work") ?? root, "work-title") || childText(root, "movement-title") || ctx.provenance.catalog.title || ctx.pieceId).trim();
  const ident = child(root, "identification");
  const xmlInfo = {
    ...(childText(child(ident ?? root, "encoding") ?? root, "software") ? { software: childText(child(ident!, "encoding")!, "software")! } : {}),
    ...(ident && childrenNamed(ident, "creator").length ? { creatorField: childrenNamed(ident, "creator").map((c) => c.text).join("; ") } : {}),
    ...(ident && child(ident, "encoding") && childText(child(ident, "encoding")!, "encoding-date") ? { encodingDate: childText(child(ident, "encoding")!, "encoding-date")! } : {}),
  };
  if (xmlInfo.creatorField && ctx.provenance.catalog.composer !== undefined && xmlInfo.creatorField !== ctx.provenance.catalog.composer) {
    issue("info", "xml-creator-ignored", `the XML names "${xmlInfo.creatorField}" as creator; it is a converter artefact and is recorded, not used. Attribution comes from the catalog.`);
  }

  // ── walk the measures ───────────────────────────────────────────────────
  let divisions = 0;
  let meter: CorpusMeter | null = null;
  let key: CorpusKey | undefined;
  let cursor: Fraction = ZERO;
  const measures: CorpusMeasure[] = [];
  const events: CorpusEvent[] = [];
  const harmony: (Omit<CorpusHarmony, "duration"> & { at: Fraction })[] = [];
  const pendingGraces: CorpusGrace[] = [];
  // tie bookkeeping: events in order; a tie-start is matched with the NEXT event
  interface Draft { ev: CorpusEvent; tieStart: boolean; tieStop: boolean; line: number; measureNumber: string }
  const drafts: Draft[] = [];

  const secondsOf = (dur: number): Fraction => frac(dur, divisions * 4);
  const pitchOf = (p: XNode, label: string, measureNumber: string): CorpusPitch | null => {
    const step = childText(p, "step") ?? "";
    const octText = childText(p, "octave") ?? "";
    const alterText = childText(p, "alter");
    const octave = Number(octText);
    const alter = alterText === undefined || alterText === "" ? 0 : Number(alterText);
    if (!(step in NATURAL_PC)) {
      issue("error", "bad-pitch", `${label}: step "${step}" is not A–G`, measureNumber, p.line);
      return null;
    }
    if (!Number.isInteger(octave) || octave < -1 || octave > 9) {
      issue("error", "bad-pitch", `${label}: octave "${octText}" is not an integer in −1…9`, measureNumber, p.line);
      return null;
    }
    if (!Number.isFinite(alter) || Math.abs(alter) > 2) {
      issue("error", "bad-pitch", `${label}: alter "${alterText}" is not a number within ±2`, measureNumber, p.line);
      return null;
    }
    const m = 12 * (octave + 1) + NATURAL_PC[step]! + alter;
    if (m < 0 || m > 127) {
      issue("error", "pitch-out-of-range", `${label}: MIDI ${m} is outside 0–127`, measureNumber, p.line);
      return null;
    }
    const integral = Number.isInteger(alter);
    return {
      ...(integral ? { name: `${step}${alter > 0 ? "#".repeat(alter) : alter < 0 ? "b".repeat(-alter) : ""}${octave}` } : {}),
      midi: m,
      step: step as Letter,
      alter,
      octave,
    };
  };

  const measureNodes = childrenNamed(partNode, "measure");
  if (measureNodes.length === 0) {
    issue("error", "no-measures", "the part has no measures");
    return fail();
  }

  for (let mi = 0; mi < measureNodes.length; mi++) {
    const mn = measureNodes[mi]!;
    const number = mn.attrs.number ?? String(mi);
    const implicit = mn.attrs.implicit === "yes";
    const measureStart = cursor;
    let repeat: CorpusMeasure["repeat"];
    let ending: CorpusMeasure["ending"];
    let timeChangedHere = false;
    let keyChangedHere = false;

    for (const el of mn.children) {
      if (!MEASURE_KNOWN.has(el.name)) {
        count(`measure/${el.name}`);
        continue;
      }
      if (el.name === "attributes") {
        for (const a of el.children) {
          if (!ATTRIBUTE_KNOWN.has(a.name)) count(`attributes/${a.name}`);
        }
        const d = childText(el, "divisions");
        if (d !== undefined) {
          const n = Number(d);
          if (!Number.isInteger(n) || n <= 0) {
            issue("error", "bad-divisions", `divisions "${d}" is not a positive integer`, number, el.line);
            return fail();
          }
          divisions = n;
        }
        const t = child(el, "time");
        if (t) {
          const b = childText(t, "beats") ?? "";
          const bt = childText(t, "beat-type") ?? "";
          if (!/^\d+$/.test(b) || !/^\d+$/.test(bt) || Number(b) < 1 || Number(bt) < 1) {
            issue("error", "unsupported-meter", `time signature "${b}/${bt}" (additive, free or unmetered meters are not supported)`, number, t.line);
            return fail();
          }
          const next: CorpusMeter = { beats: Number(b), beatType: Number(bt), text: `${b}/${bt}` };
          if (meter && (meter.beats !== next.beats || meter.beatType !== next.beatType)) {
            counts.meterChanges++;
            timeChangedHere = true;
          }
          meter = next;
        }
        const k = child(el, "key");
        if (k) {
          const f = Number(childText(k, "fifths") ?? "");
          if (!Number.isInteger(f) || Math.abs(f) > 11) {
            issue("error", "bad-key", `key fifths "${childText(k, "fifths")}" is not an integer within ±11`, number, k.line);
            return fail();
          }
          const mode = childText(k, "mode")?.toLowerCase();
          const off = mode === undefined ? undefined : MODE_OFFSET[mode];
          if (mode !== undefined && off === undefined) issue("warning", "unknown-mode", `key mode "${mode}" is not one this importer places on the line of fifths; the tonic is left unspecified`, number, k.line);
          const nextKey: CorpusKey = { fifths: f, ...(mode !== undefined ? { mode } : {}), ...(off !== undefined ? { tonic: lineOfFifthsName(f + off) } : {}) };
          if (key && (key.fifths !== nextKey.fifths || key.mode !== nextKey.mode)) {
            counts.keyChanges++;
            keyChangedHere = true;
          }
          key = nextKey;
          if (mode === undefined) issue("info", "key-mode-unspecified", `key signature of ${f} fifths without a stated mode; the tonic is not assumed`, number, k.line);
        }
        const st = childText(el, "staves");
        if (st !== undefined && st !== "1") {
          issue("error", "multiple-staves", "more than one staff; only a single monophonic line is supported", number, el.line);
          return fail();
        }
        if (child(el, "transpose")) {
          issue("warning", "transposing-part", "the part declares a transposition; written pitches are used as given", number, el.line);
        }
      } else if (el.name === "barline") {
        const rp = child(el, "repeat");
        if (rp) {
          const dir = rp.attrs.direction;
          counts.repeats++;
          repeat = { ...(repeat ?? {}), ...(dir === "forward" ? { forward: true } : dir === "backward" ? { backward: true, ...(rp.attrs.times ? { times: Number(rp.attrs.times) } : {}) } : {}) };
          if (dir !== "forward" && dir !== "backward") issue("warning", "bad-repeat", `repeat direction "${dir}"`, number, rp.line);
        }
        const en = child(el, "ending");
        if (en) ending = { numbers: en.attrs.number ?? "", type: en.attrs.type ?? "" };
      } else if (el.name === "backup" || el.name === "forward") {
        issue("error", "backup-forward", `<${el.name}> (multiple voices or spacing) is not supported in a monophonic line`, number, el.line);
        return fail();
      } else if (el.name === "harmony") {
        if (divisions === 0) {
          issue("error", "no-divisions", "<harmony> before <divisions>", number, el.line);
          return fail();
        }
        const root0 = child(el, "root");
        const rs = root0 ? childText(root0, "root-step") : undefined;
        if (!root0 || !rs || !(rs in NATURAL_PC)) {
          issue("warning", "unsupported-harmony", "a <harmony> without a plain pitched root (e.g. a function or numeral) was skipped", number, el.line);
          count("harmony/non-root");
          continue;
        }
        const alterN = Number(childText(root0, "root-alter") ?? "0");
        const kindNode = child(el, "kind");
        const kind = kindNode?.text ?? "";
        if (!Number.isInteger(alterN)) {
          issue("warning", "unsupported-harmony", `root alteration "${childText(root0, "root-alter")}" is not a whole number of semitones; the chord was skipped`, number, el.line);
          continue;
        }
        const rootNote: Note = { letter: rs as Letter, accidental: alterN };
        const def = CHORD_KINDS[kind];
        let tones: string[] | undefined;
        let intervals: number[] | undefined;
        if (def) {
          tones = [formatNote(rootNote), ...def.tones.map(([steps, semis]) => formatNote(transposeNote(rootNote, { steps, semitones: semis })))];
          intervals = [0, ...def.tones.map(([, semis]) => semis)];
        } else {
          issue("warning", "unknown-chord-kind", `chord kind "${kind}" is not interpreted; the symbol is kept but its tones are not guessed`, number, el.line);
          count(`harmony/kind:${kind}`);
        }
        if (child(el, "degree")) count("harmony/degree");
        const bassNode = child(el, "bass");
        let bass: string | undefined;
        if (bassNode) {
          const bs = childText(bassNode, "bass-step");
          if (bs && bs in NATURAL_PC) bass = formatNote({ letter: bs as Letter, accidental: Number(childText(bassNode, "bass-alter") ?? "0") || 0 });
        }
        const rootText = formatNote(rootNote);
        const symbol = `${rootText}${def ? def.suffix : `(${kind})`}${bass ? `/${bass}` : ""}`;
        counts.harmonies++;
        harmony.push({ id: `h${counts.harmonies}`, measure: mi, onset: fstr(cursor), at: cursor, root: rootText, kind, symbol, ...(bass ? { bass } : {}), ...(intervals ? { intervals } : {}), ...(tones ? { tones } : {}) });
      } else if (el.name === "note") {
        if (divisions === 0) {
          issue("error", "no-divisions", "<note> before <divisions>", number, el.line);
          return fail();
        }
        for (const c of el.children) if (!NOTE_KNOWN.has(c.name)) count(`note/${c.name}`);
        if (child(el, "chord")) {
          issue("error", "chord-note", "simultaneous notes (<chord/>) are not supported in a monophonic line", number, el.line);
          return fail();
        }
        const voice = childText(el, "voice");
        const staff = childText(el, "staff");
        if ((voice !== undefined && voice !== "1") || (staff !== undefined && staff !== "1")) {
          issue("error", "multiple-voices", `voice "${voice ?? "1"}" / staff "${staff ?? "1"}": only a single line is supported`, number, el.line);
          return fail();
        }
        if (child(el, "unpitched")) {
          issue("error", "unpitched", "an unpitched note", number, el.line);
          return fail();
        }
        const label = `measure ${number}`;
        const graceNode = child(el, "grace");
        const pitchNode = child(el, "pitch");
        const isRest = !!child(el, "rest");
        if (graceNode) {
          counts.graceNotes++;
          const gp = pitchNode ? pitchOf(pitchNode, `${label} grace note`, number) : null;
          if (gp) pendingGraces.push({ pitch: gp, slash: graceNode.attrs.slash === "yes" });
          irLoss.add("grace notes (kept in the corpus record; MusicIR events must have a duration)");
          continue;
        }
        const durText = childText(el, "duration");
        const dur = Number(durText ?? "");
        if (durText === undefined || !Number.isInteger(dur) || dur <= 0) {
          issue("error", "bad-duration", `duration "${durText}" is not a positive integer (cue notes and zero-length notes are not supported)`, number, el.line);
          return fail();
        }
        const duration = secondsOf(dur);

        // cross-check against the written type, dots and tuplet ratio
        const typeText = childText(el, "type");
        const dots = childrenNamed(el, "dot").length;
        const tm = child(el, "time-modification");
        let tuplet: { actual: number; normal: number } | undefined;
        if (tm) {
          const actual = Number(childText(tm, "actual-notes"));
          const normal = Number(childText(tm, "normal-notes"));
          if (!Number.isInteger(actual) || !Number.isInteger(normal) || actual < 1 || normal < 1) {
            issue("error", "bad-tuplet", "time-modification without whole-number actual/normal notes", number, tm.line);
            return fail();
          }
          tuplet = { actual, normal };
          counts.tupletNotes++;
          irLoss.add("tuplet grouping (the exact fractional durations are kept in MusicIR; the bracket is not)");
        }
        if (typeText !== undefined) {
          const base = NOTE_TYPES[typeText];
          if (!base) issue("warning", "unknown-note-type", `note type "${typeText}"`, number, el.line);
          else {
            let expected = base;
            let add = base;
            for (let d = 0; d < dots; d++) {
              add = fmul(add, frac(1, 2));
              expected = fadd(expected, add);
            }
            if (tuplet) expected = fmul(expected, frac(tuplet.normal, tuplet.actual));
            if (!feq(expected, duration)) {
              issue("warning", "duration-type-mismatch", `written ${typeText}${".".repeat(dots)}${tuplet ? ` in ${tuplet.actual}:${tuplet.normal}` : ""} is ${fstr(expected)} but <duration> says ${fstr(duration)}; <duration> is used`, number, el.line);
            }
          }
        }

        // marks
        const marks: string[] = [];
        const tieStart = childrenNamed(el, "tie").some((t) => t.attrs.type === "start");
        const tieStop = childrenNamed(el, "tie").some((t) => t.attrs.type === "stop");
        const notations = child(el, "notations");
        if (notations) {
          for (const nc of notations.children) {
            if (!NOTATION_MARKS.has(nc.name)) {
              count(`notations/${nc.name}`);
              continue;
            }
            if (nc.name === "tied" || nc.name === "tuplet") continue;
            if (nc.name === "slur") marks.push(`slur-${nc.attrs.type ?? "?"}`);
            else if (nc.name === "ornaments" || nc.name === "articulations" || nc.name === "technical") for (const x of nc.children) marks.push(x.name);
            else marks.push(nc.name);
          }
        }
        if (marks.length) irLoss.add("notation marks such as fermatas, slurs, ornaments and articulations (kept in the corpus record)");

        const base = { id: `e${events.length + 1}`, measure: mi, onset: fstr(cursor), duration: fstr(duration), ...(tuplet ? { tuplet } : {}), ...(typeText ? { written: { type: typeText, dots } } : {}), ...(marks.length ? { marks } : {}) };
        let ev: CorpusEvent;
        if (isRest) {
          counts.rests++;
          const wholeMeasure = child(el, "rest")?.attrs.measure === "yes";
          ev = { ...base, id: `r${counts.rests}`, kind: "rest", ...(wholeMeasure ? { wholeMeasure: true } : {}) };
          if (pendingGraces.length) {
            issue("warning", "grace-before-rest", "grace notes before a rest are dropped from the record", number, el.line);
            pendingGraces.length = 0;
          }
        } else {
          if (!pitchNode) {
            issue("error", "note-without-pitch", "a <note> that is neither a rest nor pitched", number, el.line);
            return fail();
          }
          const p = pitchOf(pitchNode, label, number);
          if (!p) return fail();
          counts.notes++;
          ev = { ...base, id: `n${counts.notes}`, kind: "note", pitch: p, ...(pendingGraces.length ? { graces: [...pendingGraces] } : {}) };
          pendingGraces.length = 0;
        }
        events.push(ev);
        drafts.push({ ev, tieStart, tieStop, line: el.line, measureNumber: number });
        cursor = fadd(cursor, duration);
      }
    }

    if (meter === null) {
      issue("error", "no-meter", "no time signature before the first note", number, mn.line);
      return fail();
    }
    const nominal = frac(meter.beats, meter.beatType);
    const length = fsub(cursor, measureStart);
    const first = mi === 0;
    const isShort = fcmp(length, nominal) < 0;
    const pickup = first && isShort;
    if (!feq(length, nominal)) {
      if (pickup) issue("info", "pickup", `opening measure holds ${fstr(length)} of ${fstr(nominal)}: treated as a pickup (anacrusis)`, number, mn.line);
      else if (mi === measureNodes.length - 1 && isShort) {
        issue(measures[0]?.pickup ? "info" : "warning", measures[0]?.pickup ? "final-measure-short" : "short-final-measure", `final measure holds ${fstr(length)} of ${fstr(nominal)}${measures[0]?.pickup ? " (a pickup piece may end short)" : ""}`, number, mn.line);
      } else issue("warning", "measure-length-mismatch", `measure holds ${fstr(length)} but ${meter.text} calls for ${fstr(nominal)}; kept as written`, number, mn.line);
    }
    if (timeChangedHere) issue("info", "meter-change", `meter changes to ${meter.text}`, number, mn.line);
    if (keyChangedHere) issue("info", "key-change", `key changes to ${key?.fifths} fifths${key?.mode ? ` ${key.mode}` : ""}`, number, mn.line);
    measures.push({
      index: mi,
      number,
      implicit,
      onset: fstr(measureStart),
      length: fstr(length),
      nominalLength: fstr(nominal),
      startPhase: fstr(pickup ? fsub(nominal, length) : ZERO),
      pickup,
      meter: meter,
      ...(key ? { key } : {}),
      ...(repeat ? { repeat } : {}),
      ...(ending ? { ending } : {}),
    });
    counts.measures++;
  }
  if (pendingGraces.length) issue("warning", "dangling-grace", "grace notes at the very end have no note to attach to", undefined);

  if (events.length === 0 || !events.some((e) => e.kind === "note")) {
    issue("error", "no-notes", "the part contains no notes");
    return fail();
  }
  if (counts.repeats > 0) irLoss.add("repeat signs and endings (kept in the corpus record; the written score is analysed once, not expanded)");
  if (counts.meterChanges > 0) irLoss.add("meter changes after the first measure (MusicIR holds one meter; events keep their exact positions)");
  if (counts.keyChanges > 0) irLoss.add("key changes (MusicIR has no document-level key)");

  // ── ties: join a tie-start to the very next event, if it is the same pitch ──
  const merged: CorpusEvent[] = [];
  let i = 0;
  while (i < drafts.length) {
    const d = drafts[i]!;
    if (d.ev.kind === "note" && d.tieStart) {
      const parts: { onset: string; duration: string; measure: number }[] = [{ onset: d.ev.onset, duration: d.ev.duration, measure: d.ev.measure }];
      let sum = totalOf(d.ev.duration);
      let last = d;
      let j = i + 1;
      while (last.tieStart && j < drafts.length) {
        const nx = drafts[j]!;
        if (nx.ev.kind !== "note" || nx.ev.pitch.midi !== d.ev.pitch.midi) {
          issue("warning", "tie-mismatch", `a tie from ${d.ev.pitch.name ?? d.ev.pitch.midi} is followed by ${nx.ev.kind === "rest" ? "a rest" : `a different pitch (${nx.ev.pitch.name ?? nx.ev.pitch.midi})`}; the notes are kept separate`, d.measureNumber, d.line);
          break;
        }
        if (!nx.tieStop) issue("warning", "tie-missing-stop", "a tied note's partner does not carry the closing tie; joined anyway", nx.measureNumber, nx.line);
        parts.push({ onset: nx.ev.onset, duration: nx.ev.duration, measure: nx.ev.measure });
        sum = fadd(sum, totalOf(nx.ev.duration));
        last = nx;
        j++;
      }
      if (parts.length > 1) {
        counts.tiedChains++;
        merged.push({ ...d.ev, duration: fstr(sum), tiedParts: parts });
        i = j;
        irLoss.add("tie structure (the sounding note is one event with its parts listed in the corpus record)");
        continue;
      }
    } else if (d.tieStop && !(i > 0 && drafts[i - 1]!.tieStart)) {
      issue("warning", "tie-orphan-stop", "a tie ends here but none was started by the note before", d.measureNumber, d.line);
    }
    merged.push(d.ev);
    i++;
  }

  // ── harmony durations ──────────────────────────────────────────────────
  const piece_end = cursor;
  const harmonies: CorpusHarmony[] = harmony.map((h, k) => {
    const next = harmony[k + 1];
    const end = next ? next.at : piece_end;
    const { at: _at, ...rest } = h;
    void _at;
    return { ...rest, duration: fstr(fsub(end, h.at)) };
  });
  const zeroLen = harmonies.find((h) => parseFrac(h.duration).num <= 0);
  if (zeroLen) issue("warning", "harmony-no-duration", `chord ${zeroLen.symbol} has no duration (two chords at the same time, or at the very end)`, undefined);
  const usableHarmony = harmonies.filter((h) => parseFrac(h.duration).num > 0);
  if (usableHarmony.length && harmonies[0] && parseFrac(harmonies[0].onset).num > 0) issue("info", "harmony-starts-late", `no chord is stated before ${harmonies[0].symbol} (the opening is unharmonised, not guessed)`);

  // ── contiguity: a monophonic line must have no gaps or overlaps ─────────
  let expect: Fraction = ZERO;
  for (const e of merged) {
    const on = parseFrac(e.onset);
    if (!feq(on, expect)) {
      issue("error", "event-order", `event ${e.id} starts at ${e.onset} but the previous one ended at ${fstr(expect)}`, undefined);
      return fail();
    }
    expect = fadd(on, parseFrac(e.duration));
  }

  const hasError = issues.some((x) => x.severity === "error");
  if (hasError) return fail();
  const piece: CorpusPiece = {
    format: CORPUS_PIECE_FORMAT,
    version: CORPUS_PIECE_VERSION,
    id: ctx.pieceId,
    title,
    tuning: ctx.tuning ?? { system: "12-tet", referenceA4Hz: 440 },
    provenance: { ...ctx.provenance, contentHash: fnv1a(xmlText), xml: xmlInfo },
    measures,
    events: merged,
    harmony: usableHarmony,
    length: fstr(piece_end),
  };
  const warn = issues.some((x) => x.severity === "warning");
  return { ok: true, piece, report: { status: warn ? "ok-with-warnings" : "ok", issues, unsupported, counts: { ...counts, notes: merged.filter((e) => e.kind === "note").length }, irLoss: [...irLoss] } };
}

function parseFrac(s: string): Fraction {
  const [n, d] = s.split("/");
  return frac(Number(n), d === undefined ? 1 : Number(d));
}
const totalOf = parseFrac;

/** MIDI of a corpus pitch with the engine's own pitch maths, as a cross-check for tests. */
export function midiOfName(name: string): number {
  const m = /^([A-G])([#b]*)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad pitch name ${name}`);
  return pitchMidi({ letter: m[1] as Letter, accidental: m[2]!.includes("#") ? m[2]!.length : -m[2]!.length, octave: Number(m[3]) });
}
