/**
 * Validation, canonical ordering and (de)serialization for MusicIR.
 * `validateMusicIR` accepts `unknown`, so it is safe on data from files, the
 * network or an AI before anything else touches it.
 */
import { MusicTheoryError } from "../errors";
import { midi, parsePitch } from "../theory/pitch";
import { fadd, fcmp, flt, parseFraction, type Fraction } from "../time/rational";
import { MUSIC_IR_VERSION, type IREvent, type IRIssue, type MusicIR } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function tryFraction(v: unknown): Fraction | null {
  if (typeof v !== "string") return null;
  try {
    return parseFraction(v);
  } catch {
    return null;
  }
}

/**
 * Check a document against the MusicIR v1 rules. Returns every problem found
 * (empty = valid). Never throws.
 */
export function validateMusicIR(input: unknown): IRIssue[] {
  const issues: IRIssue[] = [];
  const bad = (path: string, message: string) => void issues.push({ path, message });

  if (!isObj(input)) return [{ path: "", message: "MusicIR must be an object" }];
  if (input.version !== MUSIC_IR_VERSION) bad("version", `unsupported version ${String(input.version)} (expected ${MUSIC_IR_VERSION})`);
  if (!isStr(input.id)) bad("id", "document id must be a non-empty string");

  const list = (key: string): unknown[] => {
    const v = input[key];
    if (!Array.isArray(v)) {
      bad(key, "must be an array");
      return [];
    }
    return v;
  };
  const voices = list("voices");
  const events = list("events");
  const chords = list("chords");
  const relations = list("relations");
  const constraints = list("constraints");
  const transformations = list("transformations");

  // ── ids: present and unique across every collection ────────────────────
  const ids = new Set<string>();
  const claim = (path: string, v: unknown) => {
    if (!isObj(v) || !isStr(v.id)) return bad(path, "needs a non-empty string id");
    if (ids.has(v.id)) bad(path, `duplicate id "${v.id}"`);
    ids.add(v.id);
  };
  voices.forEach((v, i) => claim(`voices[${i}]`, v));
  events.forEach((v, i) => claim(`events[${i}]`, v));
  chords.forEach((v, i) => claim(`chords[${i}]`, v));
  relations.forEach((v, i) => claim(`relations[${i}]`, v));
  constraints.forEach((v, i) => claim(`constraints[${i}]`, v));
  transformations.forEach((v, i) => claim(`transformations[${i}]`, v));

  const voiceIds = new Map<string, { index: number; polyphonic: boolean }>();
  voices.forEach((v, i) => {
    if (isObj(v) && isStr(v.id)) voiceIds.set(v.id, { index: i, polyphonic: v.polyphonic === true });
    if (isObj(v) && !isStr(v.name)) bad(`voices[${i}].name`, "needs a name");
  });

  // ── events ──────────────────────────────────────────────────────────────
  const timed: { i: number; voice: string; onset: Fraction; end: Fraction; midi: number }[] = [];
  events.forEach((e, i) => {
    const p = `events[${i}]`;
    if (!isObj(e)) return bad(p, "must be an object");
    if (e.kind !== "note" && e.kind !== "rest") bad(`${p}.kind`, `must be "note" or "rest"`);
    if (!isStr(e.voice) || !voiceIds.has(e.voice)) bad(`${p}.voice`, `unknown voice "${String(e.voice)}"`);
    const onset = tryFraction(e.onset);
    const dur = tryFraction(e.duration);
    if (!onset) bad(`${p}.onset`, `not an exact fraction string: ${JSON.stringify(e.onset)}`);
    else if (onset.num < 0) bad(`${p}.onset`, "must not be negative");
    if (!dur) bad(`${p}.duration`, `not an exact fraction string: ${JSON.stringify(e.duration)}`);
    else if (dur.num <= 0) bad(`${p}.duration`, "must be positive");

    let m = 0;
    if (e.kind === "note") {
      const pitch = e.pitch;
      if (!isObj(pitch) || !isStr(pitch.name) || typeof pitch.midi !== "number") {
        bad(`${p}.pitch`, "needs { name, midi }");
      } else {
        try {
          const parsed = midi(parsePitch(pitch.name));
          if (parsed !== pitch.midi) bad(`${p}.pitch`, `"${pitch.name}" is MIDI ${parsed}, but midi says ${pitch.midi}`);
          m = pitch.midi;
        } catch (err) {
          bad(`${p}.pitch.name`, err instanceof MusicTheoryError ? err.message : "unparseable pitch name");
        }
      }
      if (e.velocity !== undefined && !(typeof e.velocity === "number" && e.velocity >= 0 && e.velocity <= 1)) {
        bad(`${p}.velocity`, "must be a number between 0 and 1");
      }
      if (e.instrument !== undefined) {
        const ins = e.instrument;
        if (!isObj(ins) || !Number.isInteger(ins.string) || !Number.isInteger(ins.fret) || (ins.fret as number) < 0) {
          bad(`${p}.instrument`, "needs integer { string, fret ≥ 0 }");
        }
      }
    }
    if (onset && dur && isStr(e.voice)) timed.push({ i, voice: e.voice, onset, end: fadd(onset, dur), midi: m });
  });

  // canonical order: onset, then voice order, then pitch
  for (let k = 1; k < timed.length; k++) {
    const a = timed[k - 1]!;
    const b = timed[k]!;
    const va = voiceIds.get(a.voice)?.index ?? 0;
    const vb = voiceIds.get(b.voice)?.index ?? 0;
    const cmp = fcmp(a.onset, b.onset) || va - vb || a.midi - b.midi;
    if (cmp > 0) bad(`events[${b.i}]`, "events are not in canonical order (onset, voice, pitch); use normalizeMusicIR");
  }

  // a monophonic voice cannot overlap itself
  const byVoice = new Map<string, typeof timed>();
  for (const t of timed) byVoice.set(t.voice, [...(byVoice.get(t.voice) ?? []), t]);
  for (const [voice, ts] of byVoice) {
    if (voiceIds.get(voice)?.polyphonic) continue;
    const sorted = [...ts].sort((a, b) => fcmp(a.onset, b.onset));
    for (let k = 1; k < sorted.length; k++) {
      if (flt(sorted[k]!.onset, sorted[k - 1]!.end)) {
        bad(`events[${sorted[k]!.i}]`, `overlaps events[${sorted[k - 1]!.i}] in single-line voice "${voice}"`);
      }
    }
  }

  // ── chord segments: valid, sorted, non-overlapping, tones spelled ───────
  let prevEnd: Fraction | null = null;
  chords.forEach((c, i) => {
    const p = `chords[${i}]`;
    if (!isObj(c)) return bad(p, "must be an object");
    const onset = tryFraction(c.onset);
    const dur = tryFraction(c.duration);
    if (!onset || onset.num < 0) bad(`${p}.onset`, "must be a non-negative exact fraction string");
    if (!dur || dur.num <= 0) bad(`${p}.duration`, "must be a positive exact fraction string");
    if (!isStr(c.symbol)) bad(`${p}.symbol`, "needs a chord symbol");
    if (!Array.isArray(c.tones) || c.tones.length === 0 || !c.tones.every(isStr)) bad(`${p}.tones`, "needs spelled chord tones");
    if (onset && dur) {
      if (prevEnd && flt(onset, prevEnd)) bad(p, "chord segments must be sorted and must not overlap");
      prevEnd = fadd(onset, dur);
    }
  });

  // ── relations reference things that exist ───────────────────────────────
  relations.forEach((r, i) => {
    const p = `relations[${i}]`;
    if (!isObj(r)) return;
    if (!isStr(r.from) || !ids.has(r.from)) bad(`${p}.from`, `unknown id "${String(r.from)}"`);
    if (!isStr(r.to) || !ids.has(r.to)) bad(`${p}.to`, `unknown id "${String(r.to)}"`);
  });
  transformations.forEach((t, i) => {
    const p = `transformations[${i}]`;
    if (!isObj(t)) return;
    if (!isStr(t.op)) bad(`${p}.op`, "needs an op name");
    for (const key of ["inputs", "outputs"] as const) {
      const v = t[key];
      if (v === undefined && key === "inputs") continue;
      if (!Array.isArray(v)) {
        bad(`${p}.${key}`, "must be an array of ids");
        continue;
      }
      v.forEach((id, k) => {
        if (!isStr(id) || !ids.has(id)) bad(`${p}.${key}[${k}]`, `unknown id "${String(id)}"`);
      });
    }
    if (!isObj(t.provenance) || !["observed", "inferred", "generated", "user"].includes(String(t.provenance.status))) {
      bad(`${p}.provenance`, "needs a provenance status");
    }
  });

  // ── optional tempo / meter ──────────────────────────────────────────────
  if (input.tempo !== undefined) {
    const t = input.tempo;
    const bpm = isObj(t) ? tryFraction(t.bpm) : null;
    const beat = isObj(t) ? tryFraction(t.beat) : null;
    if (!bpm || bpm.num <= 0) bad("tempo.bpm", "must be a positive exact fraction string");
    if (!beat || beat.num <= 0) bad("tempo.beat", "must be a positive exact fraction string");
  }
  if (input.meter !== undefined) {
    const m = input.meter;
    if (!isObj(m) || !Array.isArray(m.groups) || m.groups.length === 0 || !m.groups.every((g) => Number.isInteger(g) && g >= 1)) {
      bad("meter.groups", "needs positive integer pulse groups");
    }
    const unit = isObj(m) ? tryFraction(m.unit) : null;
    if (!unit || unit.num <= 0) bad("meter.unit", "must be a positive exact fraction string");
  }
  return issues;
}

/** Same document with events and chords in canonical order. Pure; does not validate. */
export function normalizeMusicIR(ir: MusicIR): MusicIR {
  const voiceIndex = new Map(ir.voices.map((v, i) => [v.id, i] as const));
  const key = (e: IREvent) => ({
    onset: parseFraction(e.onset),
    voice: voiceIndex.get(e.voice) ?? 0,
    midi: e.kind === "note" ? e.pitch.midi : -1,
  });
  const events = [...ir.events].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return fcmp(ka.onset, kb.onset) || ka.voice - kb.voice || ka.midi - kb.midi;
  });
  const chords = [...ir.chords].sort((a, b) => fcmp(parseFraction(a.onset), parseFraction(b.onset)));
  return { ...ir, events, chords };
}

/** Canonical, stable JSON text for a document. */
export function serializeMusicIR(ir: MusicIR): string {
  return JSON.stringify(normalizeMusicIR(ir), null, 2);
}

export type ParseResult = { readonly ok: true; readonly ir: MusicIR } | { readonly ok: false; readonly issues: IRIssue[] };

/** Parse and validate JSON text. */
export function parseMusicIR(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: `not valid JSON: ${(e as Error).message}` }] };
  }
  const issues = validateMusicIR(data);
  return issues.length ? { ok: false, issues } : { ok: true, ir: data as MusicIR };
}
