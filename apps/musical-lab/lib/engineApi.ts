/**
 * Thin adapter between HTTP query strings and @musical-lab/engine.
 * No music theory lives here: parsing/validation of inputs and flattening of
 * engine results into plain JSON for the Musical Lab to consume.
 */
import {
  buildScale,
  findTriadVoicings,
  formatNote,
  formatPitch,
  isScaleType,
  makeFretboard,
  MusicTheoryError,
  planCycleOnGuitar,
  planPerfectCycleLoop,
  parseNote,
  SCALE_TYPES,
  STANDARD_TUNING,
  type GuitarVoicing,
  type Inversion,
  type Scale,
  type TriadVoicing,
} from "@musical-lab/engine";

export class BadRequest extends Error {}

export function intParam(p: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = p.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(`"${name}" must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function scaleParam(p: URLSearchParams): Scale {
  const tonic = p.get("tonic") ?? "C";
  const type = p.get("scale") ?? "major";
  if (!isScaleType(type)) throw new BadRequest(`"scale" must be one of ${SCALE_TYPES.join(", ")}`);
  return buildScale(parseNote(tonic), type);
}

/** ?octaveShift=sweep | whole-voicing | none  (default: engine default, whole-voicing) */
export function shiftParam(p: URLSearchParams): "sweep" | "whole-voicing" | "none" | undefined {
  const v = p.get("octaveShift");
  if (v === null || v === "") return undefined;
  if (v === "sweep" || v === "whole-voicing" || v === "none") return v;
  throw new BadRequest(`"octaveShift" must be sweep, whole-voicing or none`);
}

export const inversionParam = (p: URLSearchParams): Inversion =>
  intParam(p, "inversion", 0, 0, 2) as Inversion;

export function fretboardParam(p: URLSearchParams) {
  return makeFretboard(STANDARD_TUNING, intParam(p, "fretCount", 22, 5, 36));
}

export const flattenVoicing = (v: TriadVoicing) => ({
  triad: v.triad.symbol,
  roman: v.triad.roman,
  inversion: v.inversion,
  pitches: v.pitches.map(formatPitch),
});

export const flattenGuitar = (g: GuitarVoicing) => ({
  // string 0 is the lowest-pitched string; fret 0 is open
  notes: g.notes.map((n) => ({ string: n.string, fret: n.fret, pitch: formatPitch(n.pitch), midi: n.midi })),
  span: g.span,
  fingers: g.fingers,
});

export function cycleResponse(p: URLSearchParams) {
  const scale = scaleParam(p);
  const cycle = intParam(p, "cycle", 5, 2, 7);
  const board = fretboardParam(p);
  const shared = {
    startDegree: intParam(p, "startDegree", 1, 1, 7),
    inversion: inversionParam(p),
    anchorFret: p.has("anchorFret") ? intParam(p, "anchorFret", 0, 0, 36) : undefined,
    constraints: {
      maxFretSpan: intParam(p, "maxFretSpan", 4, 0, 6),
      maxFret: intParam(p, "maxFret", 17, 1, 36),
    },
  };
  // octaveShift=sweep is the perfect loop: its length is computed (a multiple of 21), not requested.
  const perfect = shiftParam(p) === "sweep" ? planPerfectCycleLoop(scale, cycle, board, shared) : null;
  const plan =
    perfect ??
    planCycleOnGuitar(scale, cycle, board, {
      ...shared,
      length: intParam(p, "length", 7, 1, 120),
      octaveShift: shiftParam(p),
      loop: p.get("loop") === "1" || p.get("loop") === "true",
    });
  return {
    key: `${formatNote(scale.tonic)} ${scale.type}`,
    scale: scale.notes.map(formatNote),
    cycle,
    loop: perfect
      ? {
          length: perfect.length,
          laps: perfect.laps,
          wraps: perfect.wraps,
          startOctavesFromEdge: perfect.startOctavesFromEdge,
          restartJumpOctaves: perfect.restartJumpOctaves,
        }
      : null,
    steps: plan.cycle.map((s, i) => {
      const planned = plan.path.ok ? plan.path.steps[i] : undefined;
      return {
        index: s.index,
        ...flattenVoicing(s.voicing),
        guitar: planned
          ? { ...flattenGuitar(planned.guitar), octaveShift: planned.octaveShift, wrapped: planned.wrapped, played: planned.voicing.pitches.map(formatPitch) }
          : null,
      };
    }),
    guitar: plan.path.ok
      ? { ok: true as const, totalCost: plan.path.totalCost, closingCost: plan.path.closingCost ?? null }
      : { ok: false as const, failedStep: plan.path.failedStep, reason: plan.path.reason },
  };
}

export function voicingsResponse(p: URLSearchParams) {
  const scale = scaleParam(p);
  const degree = intParam(p, "degree", 1, 1, 7);
  const inversion = inversionParam(p);
  const found = findTriadVoicings(scale, degree, inversion, fretboardParam(p), {
    maxFretSpan: intParam(p, "maxFretSpan", 4, 0, 6),
    maxFret: intParam(p, "maxFret", 17, 1, 36),
  });
  return {
    key: `${formatNote(scale.tonic)} ${scale.type}`,
    degree,
    inversion,
    count: found.length,
    voicings: found.map((f) => ({ ...flattenVoicing(f.voicing), guitar: flattenGuitar(f.guitar) })),
  };
}

/** Run a handler and convert known errors into a 400 response. */
export function respond(build: () => unknown): Response {
  try {
    return Response.json(build());
  } catch (e) {
    if (e instanceof BadRequest || e instanceof MusicTheoryError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
