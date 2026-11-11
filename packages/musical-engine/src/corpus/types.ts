/**
 * Corpus records: imported compositions, kept apart from user experiments.
 *
 * A CorpusPiece is the notation-faithful record (what the score says: measures, meter and key changes,
 * repeats, ties, tuplets, chord symbols, provenance). MusicIR is a projection of it (see toIR.ts); anything
 * MusicIR cannot hold is listed in the import report rather than dropped silently.
 *
 * Nothing here assumes Western tonality or twelve-tone equal temperament: the tuning system is a field of
 * the record, pitches carry fractional MIDI when a score is microtonal, chord symbols are optional, and
 * the key is optional. Times are exact fraction strings of a whole note, as in MusicIR.
 */
import type { Letter } from "../theory/pitch";

export const CORPUS_PIECE_FORMAT = "nugget-corpus-piece" as const;
export const CORPUS_PIECE_VERSION = 1 as const;

export interface CorpusDescriptor {
  readonly id: string;
  readonly name: string;
  readonly repository?: string;
  readonly license: string;
  readonly licenseUrl?: string;
  /** Free text: what the dataset may and may not be used for, until reviewed. */
  readonly usage: string;
}

export interface CorpusProvenance {
  readonly corpus: CorpusDescriptor;
  /** Path of the MusicXML inside the archive. */
  readonly sourcePath: string;
  readonly format: "musicxml";
  /** FNV-1a 32-bit of the MusicXML text: detects a changed file; NOT a cryptographic digest. */
  readonly contentHash: string;
  /** How the MusicXML was made, when it was converted from another notation. */
  readonly conversion?: { readonly from?: string; readonly tool?: string };
  /** The original notation, kept verbatim next to the converted score. */
  readonly originalNotation?: { readonly format: string; readonly path: string; readonly text: string };
  /** Catalog metadata exactly as supplied (title, meter, key, source annotation, ...). */
  readonly catalog: Readonly<Record<string, string>>;
  /** What the XML itself claimed (converter artefacts such as a fake composer are recorded, not trusted). */
  readonly xml: { readonly software?: string; readonly creatorField?: string; readonly encodingDate?: string };
}

export interface CorpusTuning {
  /** "12-tet" today; later "24-tet", "makam-53", "just", "none" ... */
  readonly system: string;
  readonly referenceA4Hz?: number;
}

export interface CorpusPitch {
  /** Spelled name in scientific notation ("F#4"); absent for a pitch that cannot be spelled. */
  readonly name?: string;
  /** MIDI number; fractional for microtonal alterations. */
  readonly midi: number;
  readonly step: Letter;
  /** Semitone alteration as written; may be fractional. */
  readonly alter: number;
  readonly octave: number;
}

export interface CorpusMeter {
  readonly beats: number;
  readonly beatType: number;
  readonly text: string;
}

export interface CorpusKey {
  readonly fifths: number;
  /** "major" | "minor" | "dorian" | ...; absent when the file does not say. */
  readonly mode?: string;
  /** Derived from fifths and mode; absent when the mode is not stated (it is not assumed). */
  readonly tonic?: string;
}

export interface CorpusMeasure {
  /** Position in the piece, from 0. */
  readonly index: number;
  /** The measure number as written ("0" for a pickup, "1", "2", ...). */
  readonly number: string;
  readonly implicit: boolean;
  readonly onset: string;
  /** Actual length in the score. */
  readonly length: string;
  /** Length the meter calls for. */
  readonly nominalLength: string;
  /** Where in the bar this measure starts (nonzero for a pickup): metric positions are measured from it. */
  readonly startPhase: string;
  readonly pickup: boolean;
  readonly meter: CorpusMeter;
  readonly key?: CorpusKey;
  readonly repeat?: { readonly forward?: boolean; readonly backward?: boolean; readonly times?: number };
  readonly ending?: { readonly numbers: string; readonly type: string };
}

export interface CorpusGrace {
  readonly pitch: CorpusPitch;
  readonly slash: boolean;
}

interface CorpusEventBase {
  readonly id: string;
  /** Index of the measure it starts in. */
  readonly measure: number;
  readonly onset: string;
  /** Sounding duration (the sum of its tied parts). */
  readonly duration: string;
  readonly tuplet?: { readonly actual: number; readonly normal: number };
  readonly written?: { readonly type: string; readonly dots: number };
  /** Notation marks kept as data (fermata, slur-start, trill, staccato, ...). */
  readonly marks?: readonly string[];
}

export interface CorpusNote extends CorpusEventBase {
  readonly kind: "note";
  readonly pitch: CorpusPitch;
  /** Present when the sounding note is several written notes joined by ties. */
  readonly tiedParts?: readonly { readonly onset: string; readonly duration: string; readonly measure: number }[];
  /** Grace notes written before it (they take no time of their own). */
  readonly graces?: readonly CorpusGrace[];
}

export interface CorpusRest extends CorpusEventBase {
  readonly kind: "rest";
  readonly wholeMeasure?: boolean;
  /** Set by the fidelity cross-check: the original notation does not write this rest, so it is probably converter padding. */
  readonly suspect?: "converter-padding";
}

export type CorpusEvent = CorpusNote | CorpusRest;

export interface CorpusHarmony {
  readonly id: string;
  readonly measure: number;
  readonly onset: string;
  /** Until the next harmony (or the end of the piece). */
  readonly duration: string;
  readonly root: string;
  /** The MusicXML kind-value as written ("major", "dominant", "augmented-seventh", ...). */
  readonly kind: string;
  readonly symbol: string;
  readonly bass?: string;
  /** Pitch classes above the root's own (as semitone offsets), or absent for a kind this importer does not know. */
  readonly intervals?: readonly number[];
  /** Spelled chord tones, root first; absent for an unknown kind. */
  readonly tones?: readonly string[];
}

export interface CorpusPiece {
  readonly format: typeof CORPUS_PIECE_FORMAT;
  readonly version: typeof CORPUS_PIECE_VERSION;
  readonly id: string;
  readonly title: string;
  readonly tuning: CorpusTuning;
  readonly provenance: CorpusProvenance;
  readonly measures: readonly CorpusMeasure[];
  readonly events: readonly CorpusEvent[];
  readonly harmony: readonly CorpusHarmony[];
  /** Total written length, exact. */
  readonly length: string;
}

// ── import report ─────────────────────────────────────────────────────────
export type IssueSeverity = "error" | "warning" | "info";

export interface ImportIssue {
  readonly severity: IssueSeverity;
  /** Stable machine-readable code, e.g. "measure-length-mismatch". */
  readonly code: string;
  readonly message: string;
  /** Measure number as written, when the issue belongs to one. */
  readonly measure?: string;
  readonly line?: number;
}

export interface ImportCounts {
  readonly measures: number;
  readonly notes: number;
  readonly rests: number;
  readonly tiedChains: number;
  readonly tupletNotes: number;
  readonly graceNotes: number;
  readonly harmonies: number;
  readonly repeats: number;
  readonly meterChanges: number;
  readonly keyChanges: number;
}

export interface ImportReport {
  /** failed: no usable piece; ok-with-warnings: usable, but something deserves a look; ok: nothing to report. */
  readonly status: "ok" | "ok-with-warnings" | "failed";
  readonly issues: readonly ImportIssue[];
  /** Elements the file contained that this importer does not interpret, with how often. */
  readonly unsupported: Readonly<Record<string, number>>;
  readonly counts: ImportCounts;
  /** What the MusicIR projection cannot hold from this piece (kept in the CorpusPiece). */
  readonly irLoss: readonly string[];
  /** Comparison with the original notation, when it was kept. */
  readonly fidelity?: import("./fidelity").FidelityReport;
}
