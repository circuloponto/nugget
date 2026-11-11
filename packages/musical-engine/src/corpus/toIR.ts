/**
 * CorpusPiece → MusicIR (v1).
 *
 * MusicIR holds one monophonic melody voice with exact times, so:
 *  - tied notes become one event of the summed duration (the parts stay in the corpus record);
 *  - every event keeps its exact fractional position, so a tuplet is exact even without a bracket;
 *  - chord symbols become chord segments (spelled tones), only where the importer knows the chord kind;
 *  - the FIRST meter becomes the document meter; later meter changes, key, repeats, grace notes and marks
 *    cannot be expressed and are named in `loss`.
 * The document is validated before it is returned; a piece that cannot be projected says why.
 */
import { parseMeter } from "../time/meter";
import { fadd, flt, parseFraction } from "../time/rational";
import { parseNote, pitchClass } from "../theory/pitch";
import { validateMusicIR } from "../ir/validate";
import { MUSIC_IR_VERSION, type IRChordSegment, type IREvent, type IRIssue, type MusicIR } from "../ir/types";
import type { CorpusPiece } from "./types";

export type ProjectionResult = { readonly ok: true; readonly ir: MusicIR; readonly loss: readonly string[] } | { readonly ok: false; readonly issues: readonly IRIssue[]; readonly loss: readonly string[] };

export function corpusPieceToIR(piece: CorpusPiece): ProjectionResult {
  const loss = new Set<string>();
  const source = `corpus:${piece.provenance.corpus.id}/${piece.provenance.sourcePath}`;
  const events: IREvent[] = [];
  // Chords first: a note that is not a tone of the chord under it must say so (the IR verifier requires an
  // explanation). The importer only records that it is a non-chord tone; passing or neighbour is for the analysis.
  const chordSpans = piece.harmony
    .filter((h) => h.tones)
    .map((h) => ({ start: parseFraction(h.onset), end: fadd(parseFraction(h.onset), parseFraction(h.duration)), pcs: h.tones!.map((t) => pitchClass(parseNote(t))) }));
  const underChord = (onset: string) => {
    const o = parseFraction(onset);
    return chordSpans.find((c) => !flt(o, c.start) && flt(o, c.end));
  };
  for (const e of piece.events) {
    if (e.kind === "rest") {
      events.push({ id: e.id, kind: "rest", voice: "melody", onset: e.onset, duration: e.duration });
      continue;
    }
    if (!e.pitch.name) {
      return { ok: false, issues: [{ path: `events.${e.id}`, message: `pitch ${e.pitch.midi} (alter ${e.pitch.alter}) cannot be spelled as a 12-tone name; MusicIR v1 holds 12-tone spelled pitches` }], loss: [...loss, "microtonal pitches"] };
    }
    const under = underChord(e.onset);
    const nonChordTone = !!under && !under.pcs.includes((((e.pitch.midi % 12) + 12) % 12));
    events.push({ id: e.id, kind: "note", voice: "melody", pitch: { name: e.pitch.name, midi: e.pitch.midi }, onset: e.onset, duration: e.duration, ...(nonChordTone ? { roles: { melodic: "non-chord-tone" } } : {}), provenance: { status: "observed", source } });
    if (e.graces?.length) loss.add("grace notes");
    if (e.marks?.length) loss.add("notation marks (fermata, slur, ornament, ...)");
    if (e.tiedParts) loss.add("tie structure (joined into one sounding note)");
  }
  const chords: IRChordSegment[] = [];
  for (const h of piece.harmony) {
    if (!h.tones) {
      loss.add(`chord ${h.symbol} (kind "${h.kind}" has no interpreted tones)`);
      continue;
    }
    chords.push({ id: h.id, onset: h.onset, duration: h.duration, symbol: h.bass ? h.symbol.slice(0, h.symbol.lastIndexOf("/")) : h.symbol, quality: h.kind, root: h.root, tones: h.tones, provenance: { status: "observed", source } });
    if (h.bass) loss.add("slash-chord bass notes (the IR chord is the chord without its bass; the bass is kept in the corpus record)");
  }
  const first = piece.measures[0]!;
  const meter = parseMeter(first.meter.text);
  if (piece.measures.some((m) => m.meter.text !== first.meter.text)) loss.add("meter changes after the first measure");
  if (piece.measures.some((m) => m.key && piece.measures[0]!.key && (m.key.fifths !== piece.measures[0]!.key.fifths || m.key.mode !== piece.measures[0]!.key.mode))) loss.add("key changes");
  if (piece.measures.some((m) => m.repeat || m.ending)) loss.add("repeat signs and endings");
  loss.add("key signature (MusicIR has no document-level key)");

  const ir: MusicIR = {
    version: MUSIC_IR_VERSION,
    id: `corpus.${piece.id}`,
    title: piece.title,
    meter: { groups: meter.groups, unit: `1/${first.meter.beatType}` },
    voices: [{ id: "melody", name: "Melody", role: "melody" }],
    events,
    chords,
    relations: [],
    constraints: [],
    transformations: [
      {
        id: "corpus-import",
        op: "corpus-import",
        params: { corpus: piece.provenance.corpus.id, source: piece.provenance.sourcePath, format: piece.provenance.format, contentHash: piece.provenance.contentHash, license: piece.provenance.corpus.license },
        outputs: [...events.map((e) => e.id), ...chords.map((c) => c.id)],
        provenance: { status: "observed", source },
      },
    ],
  };
  const issues = validateMusicIR(ir);
  if (issues.length) return { ok: false, issues, loss: [...loss] };
  return { ok: true, ir, loss: [...loss] };
}
