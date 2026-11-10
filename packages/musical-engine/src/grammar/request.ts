/**
 * The Phrase Constructor's request: a small, JSON-friendly description of what the user asked for
 * (a ii–V–I in a key, a target, how to outline and embellish, the rhythmic feel, hard constraints,
 * soft preferences) and the engine function that turns it into a PhraseSpec. The UI only fills in
 * this object; every decision about music stays here.
 *
 * Because the request is stored inside a saved document, `parsePhraseRequest` treats it as untrusted:
 * a damaged request is reported and the caller falls back to defaults.
 */
import { buildScale } from "../theory/scale";
import { formatNote, parseNote } from "../theory/pitch";
import { frac } from "../time/rational";
import { chordDegrees, iiVI } from "./chords";
import type { ArpDirection } from "./operations";
import type { EmbellishmentSpec, PhraseSpec, SoftPreferences } from "./phrase";
import type { RhythmIntent } from "./rhythmic";

export interface PhraseRequest {
  readonly tonic: string;
  readonly mode: "major" | "minor";
  readonly bpm: number;
  /** Degree of the final chord to arrive on: "3", "7", "9" ... */
  readonly targetDegree: string;
  readonly outline: { readonly direction: ArpDirection | "any" | "none"; readonly counts: readonly number[] };
  readonly embellishment: EmbellishmentSpec;
  readonly rhythm: RhythmIntent;
  /** MIDI numbers [low, high]. */
  readonly register: readonly [number, number];
  readonly maxLeap: number;
  readonly maxFret: number;
  readonly soft: SoftPreferences;
  readonly candidates: number;
}

export const DEFAULT_PHRASE_REQUEST: PhraseRequest = {
  tonic: "C",
  mode: "major",
  bpm: 100,
  targetDegree: "3",
  outline: { direction: "any", counts: [3, 4] },
  embellishment: { kind: "enclosure", step: "chromatic", side: "any" },
  rhythm: { feel: "any", rests: true, shape: "any" },
  register: [55, 84],
  maxLeap: 9,
  maxFret: 15,
  soft: {},
  candidates: 5,
};


/** The ii–V–I progression and everything else the generator needs, from a request. */
export function phraseSpecFromRequest(req: PhraseRequest): PhraseSpec {
  const { chords, romans } = iiVI(req.tonic, req.mode);
  const progression = chords.map((chord, i) => ({ chord, onset: frac(i), duration: frac(1), roman: romans[i]! }));
  return {
    space: { scale: buildScale(req.tonic, req.mode === "major" ? "major" : "harmonicMinor").notes },
    progression,
    start: frac(1),
    target: { chordIndex: 2, degree: req.targetDegree },
    outline: req.outline.direction === "none" ? null : { direction: req.outline.direction, counts: req.outline.counts, chordIndex: 1 },
    embellishment: req.embellishment,
    rhythm: req.rhythm,
    hard: { register: req.register, maxLeap: req.maxLeap, fretRange: [0, req.maxFret] },
    soft: req.soft,
    candidates: req.candidates,
  };
}

export interface TargetOption {
  readonly degree: string;
  readonly note: string;
  readonly role: string;
  readonly kind: "chord-tone" | "extension" | "alteration";
}

/** Degrees the final chord can be targeted on, spelled, for a key. */
export function targetOptions(tonic: string, mode: "major" | "minor"): { chord: string; options: TargetOption[] } {
  const final = iiVI(tonic, mode).chords[2]!;
  return { chord: final.symbol, options: chordDegrees(final).map((d) => ({ degree: d.label, note: formatNote(d.note), role: d.role, kind: d.kind })) };
}

export type RequestParse = { readonly ok: true; readonly request: PhraseRequest } | { readonly ok: false; readonly issues: string[] };

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** Validate a request that came from outside (a saved file). Unknown fields are ignored, missing ones are errors. */
export function parsePhraseRequest(input: unknown): RequestParse {
  const issues: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: ["the request is not an object"] };
  const r = input as Record<string, unknown>;
  const o = (k: string): Record<string, unknown> => (typeof r[k] === "object" && r[k] !== null ? (r[k] as Record<string, unknown>) : {});
  try {
    parseNote(String(r.tonic));
  } catch {
    issues.push(`tonic "${String(r.tonic)}" is not a note name`);
  }
  if (!oneOf(r.mode, ["major", "minor"] as const)) issues.push("mode must be major or minor");
  if (!isNum(r.bpm, 20, 300)) issues.push("bpm must be a number from 20 to 300");
  if (typeof r.targetDegree !== "string" || r.targetDegree.length === 0) issues.push("targetDegree must be a degree label");
  const out = o("outline");
  if (!oneOf(out.direction, ["up", "down", "updown", "mixed", "any", "none"] as const)) issues.push("outline.direction is not recognised");
  if (!Array.isArray(out.counts) || out.counts.length === 0 || !out.counts.every((c) => Number.isInteger(c) && c >= 1 && c <= 8)) issues.push("outline.counts must be whole numbers from 1 to 8");
  const emb = o("embellishment");
  if (!oneOf(emb.kind, ["enclosure", "approach", "none"] as const)) issues.push("embellishment.kind is not recognised");
  if (!oneOf(emb.step, ["chromatic", "diatonic", "mixed", "any"] as const)) issues.push("embellishment.step is not recognised");
  if (emb.side !== undefined && !oneOf(emb.side, ["above", "below", "any"] as const)) issues.push("embellishment.side is not recognised");
  if (emb.count !== undefined && !isNum(emb.count, 1, 2)) issues.push("embellishment.count must be 1 or 2");
  const rh = o("rhythm");
  if (rh.feel !== undefined && !oneOf(rh.feel, ["straight", "triplet", "any"] as const)) issues.push("rhythm.feel is not recognised");
  if (rh.shape !== undefined && !oneOf(rh.shape, ["even", "accelerating", "decelerating", "any"] as const)) issues.push("rhythm.shape is not recognised");
  if (rh.density !== undefined && !isNum(rh.density, 0.25, 8)) issues.push("rhythm.density must be from 0.25 to 8");
  if (rh.syncopation !== undefined && !isNum(rh.syncopation, 0, 1)) issues.push("rhythm.syncopation must be from 0 to 1");
  const reg = r.register;
  if (!Array.isArray(reg) || reg.length !== 2 || !isNum(reg[0], 20, 110) || !isNum(reg[1], 20, 110) || (reg[0] as number) > (reg[1] as number)) issues.push("register must be [low, high] MIDI numbers");
  if (!isNum(r.maxLeap, 1, 24)) issues.push("maxLeap must be from 1 to 24 semitones");
  if (!isNum(r.maxFret, 3, 24)) issues.push("maxFret must be from 3 to 24");
  const soft = o("soft");
  if (soft.direction !== undefined && !oneOf(soft.direction, ["ascending", "descending", "arch"] as const)) issues.push("soft.direction is not recognised");
  if (soft.stepwise !== undefined && !isNum(soft.stepwise, 0, 1)) issues.push("soft.stepwise must be from 0 to 1");
  if (!isNum(r.candidates, 1, 40) || !Number.isInteger(r.candidates)) issues.push("candidates must be a whole number from 1 to 40");
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    request: {
      tonic: String(r.tonic),
      mode: r.mode as "major" | "minor",
      bpm: r.bpm as number,
      targetDegree: r.targetDegree as string,
      outline: { direction: out.direction as PhraseRequest["outline"]["direction"], counts: out.counts as number[] },
      embellishment: {
        kind: emb.kind as EmbellishmentSpec["kind"],
        step: emb.step as EmbellishmentSpec["step"],
        ...(emb.side !== undefined ? { side: emb.side as EmbellishmentSpec["side"] } : {}),
        ...(emb.count !== undefined ? { count: emb.count as number } : {}),
      },
      rhythm: {
        ...(rh.feel !== undefined ? { feel: rh.feel as RhythmIntent["feel"] } : {}),
        ...(typeof rh.rests === "boolean" ? { rests: rh.rests } : {}),
        ...(rh.syncopation !== undefined ? { syncopation: rh.syncopation as number } : {}),
        ...(rh.density !== undefined ? { density: rh.density as number } : {}),
        ...(rh.shape !== undefined ? { shape: rh.shape as RhythmIntent["shape"] } : {}),
      },
      register: [(reg as number[])[0]!, (reg as number[])[1]!],
      maxLeap: r.maxLeap as number,
      maxFret: r.maxFret as number,
      soft: {
        ...(soft.direction !== undefined ? { direction: soft.direction as SoftPreferences["direction"] } : {}),
        ...(soft.stepwise !== undefined ? { stepwise: soft.stepwise as number } : {}),
      },
      candidates: r.candidates as number,
    },
  };
}

