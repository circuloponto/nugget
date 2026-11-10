/**
 * The Phrase Constructor's request: a small, JSON-friendly description of what the user asked for
 * (a ii–V–I in a key, whether to EXPLORE every target or FOCUS on one, which values of each dimension
 * of the generation space to allow, a seed, optional locks) and the engine functions that turn it into a
 * `GenerationSpace`. The UI only fills in this object; every decision about music stays here.
 *
 * Because the request is stored inside a saved document, `parsePhraseRequest` treats it as untrusted: a
 * damaged request is reported and the caller falls back to defaults. Requests saved by the earlier
 * Phase 3 builds (one fixed target, no exploration block) are migrated to a Focus request.
 */
import { buildScale } from "../theory/scale";
import { formatNote, parseNote } from "../theory/pitch";
import { frac } from "../time/rational";
import { chordDegrees, iiVI } from "./chords";
import type { ContourClass } from "./line";
import {
  BAND_NAMES,
  CONTOUR_CHOICES,
  DENSITIES,
  LENGTHS,
  RHYTHM_CHARACTERS,
  STRATEGIES,
  defaultGenerationSpace,
  lockAspects,
  type Band,
  type Density,
  type ExploredPhrase,
  type GenerationSpace,
  type Length,
  type LockAspect,
} from "./explore";
import type { ProgressionChord } from "./phrase";
import type { RhythmPlan } from "./rhythmic";

export type Choice<T> = readonly T[] | "all";

export interface ExplorationRequest {
  /** "explore": every compatible target; "focus": the one degree in `focusDegree`. */
  readonly mode: "explore" | "focus";
  readonly focusDegree: string;
  /** Degrees to explore (explore mode). */
  readonly degrees: Choice<string>;
  readonly bands: Choice<Band>;
  readonly strategies: Choice<string>;
  readonly rhythms: Choice<string>;
  readonly contours: Choice<ContourClass | "any">;
  readonly densities: Choice<Density>;
  readonly lengths: Choice<Length>;
  /** How many contrasting phrases to return at most. */
  readonly count: number;
  /** Chooses which intentions are visited; the same seed reproduces the same set. */
  readonly seed: number;
  readonly locks?: { readonly targetPitch?: number; readonly rhythmPlan?: RhythmPlan; readonly contourShape?: string };
}

export interface PhraseRequest {
  readonly tonic: string;
  readonly mode: "major" | "minor";
  readonly bpm: number;
  /** MIDI numbers [low, high] for every note. */
  readonly register: readonly [number, number];
  readonly maxLeap: number;
  readonly maxFret: number;
  readonly exploration: ExplorationRequest;
}

export const DEFAULT_EXPLORATION: ExplorationRequest = {
  mode: "explore",
  focusDegree: "3",
  degrees: "all",
  bands: "all",
  strategies: "all",
  rhythms: "all",
  contours: "all",
  densities: "all",
  lengths: "all",
  count: 7,
  seed: 1,
};

export const DEFAULT_PHRASE_REQUEST: PhraseRequest = {
  tonic: "C",
  mode: "major",
  bpm: 100,
  register: [52, 84],
  maxLeap: 9,
  maxFret: 15,
  exploration: DEFAULT_EXPLORATION,
};

/** The ii–V–I (or ii–V–i) of a key, one bar per chord. */
export function progressionFor(tonic: string, mode: "major" | "minor"): ProgressionChord[] {
  const { chords, romans } = iiVI(tonic, mode);
  return chords.map((chord, i) => ({ chord, onset: frac(i), duration: frac(1), roman: romans[i]! }));
}

const pick = <T>(c: Choice<T>, all: readonly T[]): readonly T[] => (c === "all" ? all : c);

/** The generation space a request describes. */
export function generationSpaceFromRequest(req: PhraseRequest): GenerationSpace {
  const e = req.exploration;
  const base = defaultGenerationSpace(progressionFor(req.tonic, req.mode), { scale: buildScale(req.tonic, req.mode === "major" ? "major" : "harmonicMinor").notes });
  const degrees = e.degrees === "all" ? undefined : e.degrees;
  return {
    ...base,
    targets: e.mode === "focus" ? { mode: "focus", degree: e.focusDegree } : { mode: "explore", ...(degrees ? { degrees } : {}) },
    register: req.register,
    bands: pick(e.bands, BAND_NAMES),
    strategies: pick(e.strategies, STRATEGIES.map((s) => s.id)),
    rhythms: pick(e.rhythms, RHYTHM_CHARACTERS.map((r) => r.id)),
    contours: pick(e.contours, CONTOUR_CHOICES),
    densities: pick(e.densities, DENSITIES),
    lengths: pick(e.lengths, LENGTHS),
    hard: { maxLeap: req.maxLeap, fretRange: [0, req.maxFret], maxFretShift: 5 },
    count: e.count,
    seed: e.seed,
    ...(e.locks ? { locks: e.locks } : {}),
  };
}

/**
 * The request for developing a chosen phrase: the given aspects of it are locked (its target, register,
 * strategy, exact rhythm, exact contour ...) and the seed advances, so exploring produces variations of it.
 */
export function developRequest(req: PhraseRequest, chosen: ExploredPhrase, aspects: readonly LockAspect[]): PhraseRequest {
  const gs = lockAspects(generationSpaceFromRequest(req), chosen, aspects);
  const e = req.exploration;
  const has = (a: LockAspect) => aspects.includes(a);
  const t = chosen.traits;
  return {
    ...req,
    exploration: {
      ...e,
      mode: has("target") ? "focus" : e.mode,
      focusDegree: has("target") ? t.targetDegree : e.focusDegree,
      bands: has("register") || has("target") ? [t.band] : e.bands,
      strategies: has("strategy") ? [t.strategy] : e.strategies,
      contours: has("contour") ? [t.contour === "level" ? "any" : t.contour] : e.contours,
      densities: has("density") ? [t.density] : e.densities,
      lengths: has("length") || has("rhythm") ? [t.length] : e.lengths,
      seed: gs.seed,
      ...(gs.locks && Object.keys(gs.locks).length ? { locks: gs.locks } : {}),
    },
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

// ── parsing a request from outside ────────────────────────────────────────
export type RequestParse = { readonly ok: true; readonly request: PhraseRequest } | { readonly ok: false; readonly issues: string[] };

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isInt = (v: unknown, lo: number, hi: number): v is number => isNum(v, lo, hi) && Number.isInteger(v);
const isFrac = (v: unknown): boolean => typeof v === "object" && v !== null && Number.isInteger((v as { num: unknown }).num) && Number.isInteger((v as { den: unknown }).den) && (v as { den: number }).den > 0;

function choice<T extends string>(raw: unknown, allowed: readonly T[], name: string, issues: string[]): Choice<T> {
  if (raw === undefined || raw === "all") return "all";
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((x) => typeof x === "string" && (allowed as readonly string[]).includes(x))) {
    issues.push(`${name} must be "all" or a non-empty list of: ${allowed.join(", ")}`);
    return "all";
  }
  return raw as T[];
}

function parseRhythmPlan(raw: unknown, issues: string[]): RhythmPlan | undefined {
  const p = raw as Partial<RhythmPlan> | undefined;
  const ok =
    p !== undefined &&
    typeof p === "object" &&
    p !== null &&
    typeof p.id === "string" &&
    Array.isArray(p.gestures) &&
    p.gestures.every((g) => typeof g === "string") &&
    Array.isArray(p.slots) &&
    p.slots.length > 0 &&
    p.slots.every((s) => isFrac(s.offset) && isFrac(s.duration) && typeof s.rest === "boolean") &&
    isInt(p.hits, 0, 64);
  if (!ok) {
    issues.push("locks.rhythmPlan is not a rhythm plan");
    return undefined;
  }
  return p as RhythmPlan;
}

/** Validate a request that came from outside (a saved file). Unknown fields are ignored. Old single-target requests are migrated. */
export function parsePhraseRequest(input: unknown): RequestParse {
  const issues: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: ["the request is not an object"] };
  const r = input as Record<string, unknown>;
  try {
    parseNote(String(r.tonic));
  } catch {
    issues.push(`tonic "${String(r.tonic)}" is not a note name`);
  }
  if (r.mode !== "major" && r.mode !== "minor") issues.push("mode must be major or minor");
  if (!isNum(r.bpm, 20, 300)) issues.push("bpm must be a number from 20 to 300");
  const reg = r.register;
  if (!Array.isArray(reg) || reg.length !== 2 || !isNum(reg[0], 20, 110) || !isNum(reg[1], 20, 110) || (reg[0] as number) > (reg[1] as number)) issues.push("register must be [low, high] MIDI numbers");
  if (!isNum(r.maxLeap, 1, 24)) issues.push("maxLeap must be from 1 to 24 semitones");
  if (!isNum(r.maxFret, 3, 24)) issues.push("maxFret must be from 3 to 24");

  let exploration: ExplorationRequest = DEFAULT_EXPLORATION;
  const raw = r.exploration;
  if (raw === undefined) {
    // a request saved before exploration existed: one fixed target, so it becomes a Focus request
    if (typeof r.targetDegree !== "string" || r.targetDegree.length === 0) issues.push("targetDegree must be a degree label");
    else exploration = { ...DEFAULT_EXPLORATION, mode: "focus", focusDegree: r.targetDegree };
  } else if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push("exploration must be an object");
  } else {
    const e = raw as Record<string, unknown>;
    if (e.mode !== "explore" && e.mode !== "focus") issues.push("exploration.mode must be explore or focus");
    if (typeof e.focusDegree !== "string" || e.focusDegree.length === 0) issues.push("exploration.focusDegree must be a degree label");
    if (!isInt(e.count, 1, 12)) issues.push("exploration.count must be a whole number from 1 to 12");
    if (!isInt(e.seed, 0, 4294967295)) issues.push("exploration.seed must be a whole number");
    let degrees: Choice<string> = "all";
    if (e.degrees !== undefined && e.degrees !== "all") {
      if (Array.isArray(e.degrees) && e.degrees.length > 0 && e.degrees.every((d) => typeof d === "string")) degrees = e.degrees as string[];
      else issues.push('exploration.degrees must be "all" or a list of degree labels');
    }
    const bands = choice(e.bands, BAND_NAMES, "exploration.bands", issues);
    const strategies = choice(e.strategies, STRATEGIES.map((s) => s.id), "exploration.strategies", issues);
    const rhythms = choice(e.rhythms, RHYTHM_CHARACTERS.map((x) => x.id), "exploration.rhythms", issues);
    const contours = choice(e.contours, CONTOUR_CHOICES, "exploration.contours", issues);
    const densities = choice(e.densities, DENSITIES, "exploration.densities", issues);
    const lengths = choice(e.lengths, LENGTHS, "exploration.lengths", issues);
    let locks: ExplorationRequest["locks"];
    if (e.locks !== undefined) {
      const l = e.locks as Record<string, unknown>;
      if (typeof l !== "object" || l === null) issues.push("exploration.locks must be an object");
      else {
        if (l.targetPitch !== undefined && !isInt(l.targetPitch, 20, 110)) issues.push("locks.targetPitch must be a MIDI number");
        if (l.contourShape !== undefined && !(typeof l.contourShape === "string" && /^[udl]*$/.test(l.contourShape))) issues.push("locks.contourShape must be a string of u, d and l");
        const plan = l.rhythmPlan !== undefined ? parseRhythmPlan(l.rhythmPlan, issues) : undefined;
        locks = {
          ...(typeof l.targetPitch === "number" ? { targetPitch: l.targetPitch } : {}),
          ...(plan ? { rhythmPlan: plan } : {}),
          ...(typeof l.contourShape === "string" ? { contourShape: l.contourShape } : {}),
        };
      }
    }
    if (!issues.length) {
      exploration = { mode: e.mode as "explore" | "focus", focusDegree: e.focusDegree as string, degrees, bands, strategies, rhythms, contours, densities, lengths, count: e.count as number, seed: e.seed as number, ...(locks ? { locks } : {}) };
    }
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    request: {
      tonic: String(r.tonic),
      mode: r.mode as "major" | "minor",
      bpm: r.bpm as number,
      register: [(reg as number[])[0]!, (reg as number[])[1]!],
      maxLeap: r.maxLeap as number,
      maxFret: r.maxFret as number,
      exploration,
    },
  };
}
