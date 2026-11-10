/**
 * MusicIR v1: a common, versioned, JSON-native representation of musical
 * material. It generalizes beyond triads: events, voices, chord annotations,
 * relations, constraints and the transformations that produced them. Existing
 * engine objects (TriadVoicing, cycle plans, guitar realizations) map INTO it;
 * they are not replaced by it.
 *
 * Conventions
 *  - Times are exact fraction strings of a whole note ("1/4", "3/8", "2"); parse
 *    them with parseFraction. Nothing in the IR is a float.
 *  - Pitches carry both the spelled name ("Bb3") and the MIDI number, and the
 *    validator checks that they agree.
 *  - Every entity has a stable string id, unique across the whole document.
 *  - Provenance separates what was observed, inferred, generated or user-edited.
 */

export const MUSIC_IR_VERSION = 1 as const;

export type Provenance = "observed" | "inferred" | "generated" | "user";

export interface IRProvenance {
  readonly status: Provenance;
  /** 0..1, for observed/inferred material. */
  readonly confidence?: number;
  /** Where it came from: a producing transformation id, a video timestamp, … */
  readonly source?: string;
}

export interface IRPitch {
  /** Spelled pitch in scientific notation, e.g. "F#3", "Bb2", "B#3". */
  readonly name: string;
  readonly midi: number;
}

/** A note's roles are independent of each other (the same D can be a ninth AND a passing tone). */
export interface IRRoles {
  readonly harmonic?: string;
  readonly melodic?: string;
  readonly metric?: string;
  readonly structural?: string;
}

export interface IRNoteEvent {
  readonly id: string;
  readonly kind: "note";
  readonly voice: string;
  readonly pitch: IRPitch;
  readonly onset: string;
  readonly duration: string;
  /** 0..1 */
  readonly velocity?: number;
  /** Accent weight, see accentProfile. */
  readonly accent?: number;
  readonly roles?: IRRoles;
  /** Where this note is played, if realized on an instrument (string 0 = lowest). */
  readonly instrument?: { readonly string: number; readonly fret: number };
  readonly provenance?: IRProvenance;
}

export interface IRRestEvent {
  readonly id: string;
  readonly kind: "rest";
  readonly voice: string;
  readonly onset: string;
  readonly duration: string;
}

export type IREvent = IRNoteEvent | IRRestEvent;

export interface IRVoice {
  readonly id: string;
  readonly name: string;
  readonly role?: "bass" | "inner" | "upper" | "melody" | "other";
  /** A polyphonic voice may have overlapping notes; by default a voice is a single line. */
  readonly polyphonic?: boolean;
  readonly instrument?: { readonly name: string; readonly tuning?: readonly string[] };
}

/**
 * One voice of a chord as voiced: which voice, which exact pitch, and (on a fretted
 * instrument) where it is played. The canonical record of the chord's voicing, so the
 * notes under it can be re-timed (a new rhythm) without losing a voice.
 */
export interface IRVoicedNote {
  readonly voice: string;
  readonly pitch: IRPitch;
  readonly instrument?: { readonly string: number; readonly fret: number };
}

/** A harmony annotation over a time span. */
export interface IRChordSegment {
  readonly id: string;
  readonly onset: string;
  readonly duration: string;
  readonly symbol: string;
  readonly roman?: string;
  readonly quality: string;
  /** Spelled root, e.g. "F#". */
  readonly root: string;
  /** Spelled chord tones, root first. */
  readonly tones: readonly string[];
  readonly inversion?: number;
  /** The chord as voiced, bass first. Every note under this segment must be one of these. */
  readonly voicing?: readonly IRVoicedNote[];
  readonly key?: { readonly tonic: string; readonly scale: string };
  readonly provenance?: IRProvenance;
}

export interface IRRelation {
  readonly id: string;
  readonly kind: "voice-leading" | "derived-from" | "resolves-to" | "part-of";
  readonly from: string;
  readonly to: string;
  readonly data?: Readonly<Record<string, number | string | boolean>>;
}

export type IRParam = number | string | boolean | readonly string[] | readonly number[];

export interface IRConstraint {
  readonly id: string;
  readonly kind: "guitar-playability" | "tuning" | "range" | "custom";
  readonly params: Readonly<Record<string, IRParam>>;
  /** Free text, e.g. that a playability check is an approximation. */
  readonly note?: string;
}

export interface IRTransformation {
  readonly id: string;
  readonly op: string;
  readonly params: Readonly<Record<string, IRParam>>;
  /** Ids this transformation read. */
  readonly inputs?: readonly string[];
  /** Ids it produced. */
  readonly outputs: readonly string[];
  readonly provenance: IRProvenance;
}

export interface IRTempo {
  /** Exact beats per minute, as a fraction string ("90", "135", "100/3"). */
  readonly bpm: string;
  /** Beat unit as a fraction of a whole note ("1/4"). */
  readonly beat: string;
}

export interface IRMeter {
  readonly groups: readonly number[];
  readonly unit: string;
}

// ── semantic layer (optional; absent in every Phase 1 and 2 document) ─────────
//
// A gesture, target or interpretation REFERENCES events by id and never duplicates them: the
// events stay the single source of truth for pitch and time. A document without `semantics`
// is exactly as valid as before.

export const MUSIC_IR_SEMANTICS_VERSION = 1 as const;

/** A desired musical event, not just a pitch: a degree of a chord, arriving at a time. */
export interface IRTarget {
  readonly id: string;
  /** The chord segment it belongs to. */
  readonly chord: string;
  /** Degree label in that chord: "1" "3" "5" "7" "9" "b9" "#11" "13" ... */
  readonly degree: string;
  /** Exact pitch, when known (otherwise only the degree is fixed). */
  readonly pitch?: IRPitch;
  /** Allowed register as MIDI numbers. */
  readonly register?: readonly [number, number];
  /** Expected arrival time (exact fraction string). */
  readonly arrival: string;
  readonly metric?: string;
  readonly melodicRole?: string;
  readonly harmonicRole?: string;
  readonly tension?: "resolve" | "build" | "neutral";
  /** The event that realizes it, once there is one. */
  readonly note?: string;
  readonly constraints?: Readonly<Record<string, IRParam>>;
}

/** A note's several roles at once. The single-string `roles` on the event stays as the primary label. */
export interface IRNoteFunctions {
  readonly note: string;
  readonly harmonic?: readonly string[];
  readonly melodic?: readonly string[];
  readonly metric?: string;
  readonly structural?: readonly string[];
}

/** One recorded step of how a gesture was built. */
export interface IRConstructionStep {
  readonly op: string;
  readonly params: Readonly<Record<string, IRParam>>;
  /** Ids (notes or targets) it started from. */
  readonly inputs?: readonly string[];
  /** Note ids it produced. */
  readonly outputs: readonly string[];
}

export interface IRGesture {
  readonly id: string;
  /** "arpeggiation", "enclosure", "approach", "neighbor", "passing", "anticipation", "guide-tone-line", ... */
  readonly kind: string;
  /** Notes it consists of, in time order. */
  readonly notes: readonly string[];
  readonly target?: string;
  readonly steps: readonly IRConstructionStep[];
  readonly params?: Readonly<Record<string, IRParam>>;
  readonly provenance: IRProvenance;
}

export interface IRMotifStep {
  readonly op: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly preserved: readonly string[];
  readonly transformed: readonly string[];
}

export interface IRMotif {
  readonly id: string;
  readonly name?: string;
  /** Semitone intervals between successive notes. */
  readonly intervals: readonly number[];
  /** Exact durations, as fraction strings. */
  readonly durations: readonly string[];
  readonly accents: readonly number[];
  /** Occurrences in the document, each a list of note ids. */
  readonly statements: readonly { readonly id: string; readonly notes: readonly string[]; readonly of?: string }[];
  readonly lineage: readonly IRMotifStep[];
}

export interface IRPhrase {
  readonly id: string;
  readonly notes: readonly string[];
  readonly label?: string;
}

export interface IRPhraseRelation {
  readonly id: string;
  readonly kind: "question-answer" | "antecedent-consequent" | "repetition" | "repetition-with-variation" | "continuation" | "tension-release" | "interruption" | "cadential-arrival" | "climax";
  readonly from: string;
  readonly to?: string;
  readonly evidence?: readonly string[];
}

/** A reading of the music. It is a claim with evidence, never a fact. */
export interface IRInterpretation {
  readonly id: string;
  readonly kind: string;
  readonly notes: readonly string[];
  readonly target?: string;
  /** 0..1 */
  readonly confidence: number;
  readonly evidence: readonly string[];
  /** Other interpretations of (some of) the same notes that cannot all be true together. */
  readonly alternatives?: readonly string[];
}

export interface IRSemantics {
  readonly version: typeof MUSIC_IR_SEMANTICS_VERSION;
  readonly targets?: readonly IRTarget[];
  readonly noteFunctions?: readonly IRNoteFunctions[];
  readonly gestures?: readonly IRGesture[];
  readonly motifs?: readonly IRMotif[];
  readonly phrases?: readonly IRPhrase[];
  readonly phraseRelations?: readonly IRPhraseRelation[];
  readonly interpretations?: readonly IRInterpretation[];
}

export interface MusicIR {
  readonly version: typeof MUSIC_IR_VERSION;
  readonly id: string;
  readonly title?: string;
  readonly tempo?: IRTempo;
  readonly meter?: IRMeter;
  readonly voices: readonly IRVoice[];
  /** Canonical order: by onset, then voice order, then pitch. */
  readonly events: readonly IREvent[];
  readonly chords: readonly IRChordSegment[];
  readonly relations: readonly IRRelation[];
  readonly constraints: readonly IRConstraint[];
  readonly transformations: readonly IRTransformation[];
  /** Optional musical-grammar layer: targets, gestures, motifs, phrase relations, interpretations. */
  readonly semantics?: IRSemantics;
}

export interface IRIssue {
  readonly path: string;
  readonly message: string;
}
