/**
 * Verification of the semantic layer (`ir.semantics`) against the events and chords it refers to.
 * Run by validateMusicIR on documents that carry the layer.
 *
 * Structural: every reference exists and points at the right kind of thing; ids do not collide.
 * Semantic: a target's pitch and arrival match the note that realizes it and the degree it names;
 * a note's stated harmonic roles are true of the chord under it; motif statements really have the
 * motif's intervals and durations; a GENERATED gesture really has the shape its kind promises
 * (an enclosure surrounds its target, an arpeggiation outlines its chord). A gesture a user has
 * edited is no longer held to that: it is honest history, not a guarantee.
 *
 * An interpretation is a claim and is only checked for well-formedness and references.
 */
import { formatNote, parseNote, pitchClass, type Note } from "../theory/pitch";
import { fadd, fcmp, parseFraction } from "../time/rational";
import type { IRChordSegment, IRIssue, IRNoteEvent, MusicIR } from "../ir/types";
import { chordFromSegment, degreeOf, EXTENSIONS, hasDegree } from "./chords";

const ROLE_BY_TONE = ["root", "third", "fifth", "seventh"];

const tryNote = (name: string): Note | null => {
  try {
    return parseNote(name);
  } catch {
    return null;
  }
};

const segAt = (ir: MusicIR, onset: ReturnType<typeof parseFraction>): IRChordSegment | undefined =>
  ir.chords.find((c) => fcmp(onset, parseFraction(c.onset)) >= 0 && fcmp(onset, fadd(parseFraction(c.onset), parseFraction(c.duration))) < 0);

/** Never throws: a malformed semantic layer is reported, not crashed on. */
export function verifyGrammarSemantics(ir: MusicIR): IRIssue[] {
  const sem = ir.semantics as unknown as Record<string, unknown> | undefined;
  if (!sem) return [];
  for (const key of ["targets", "noteFunctions", "gestures", "motifs", "phrases", "phraseRelations", "interpretations"]) {
    if (sem[key] !== undefined && !Array.isArray(sem[key])) return [{ path: `semantics.${key}`, message: "must be an array" }];
    for (const [i, item] of ((sem[key] as unknown[] | undefined) ?? []).entries()) {
      if (typeof item !== "object" || item === null) return [{ path: `semantics.${key}[${i}]`, message: "must be an object" }];
    }
  }
  try {
    return verifyChecked(ir);
  } catch (e) {
    return [{ path: "semantics", message: `malformed semantic layer: ${(e as Error).message}` }];
  }
}

function verifyChecked(ir: MusicIR): IRIssue[] {
  const sem = ir.semantics!;
  const issues: IRIssue[] = [];
  const bad = (path: string, message: string) => void issues.push({ path, message });

  if (sem.version !== 1) bad("semantics.version", `unsupported semantics version ${String(sem.version)}`);

  const notes = new Map<string, IRNoteEvent>();
  for (const e of ir.events) if (e.kind === "note") notes.set(e.id, e);
  const chords = new Map(ir.chords.map((c) => [c.id, c] as const));

  // semantic ids must be unique among themselves and must not collide with the document's
  const docIds = new Set<string>([...ir.voices, ...ir.events, ...ir.chords, ...ir.relations, ...ir.constraints, ...ir.transformations].map((x) => x.id));
  const own = new Set<string>();
  const claim = (path: string, id: unknown) => {
    if (typeof id !== "string" || id.length === 0) return bad(path, "needs a non-empty string id");
    if (docIds.has(id)) bad(path, `id "${id}" collides with an id in the document body`);
    if (own.has(id)) bad(path, `duplicate semantic id "${id}"`);
    own.add(id);
  };
  const need = (path: string, id: string, what: "note" | "any") => {
    if (what === "note" ? !notes.has(id) : !docIds.has(id) && !own.has(id)) bad(path, `unknown ${what === "note" ? "note" : "id"} "${id}"`);
  };

  sem.targets?.forEach((t, i) => claim(`semantics.targets[${i}]`, t.id));
  sem.gestures?.forEach((g, i) => claim(`semantics.gestures[${i}]`, g.id));
  sem.motifs?.forEach((m, i) => {
    claim(`semantics.motifs[${i}]`, m.id);
    m.statements?.forEach((s, k) => claim(`semantics.motifs[${i}].statements[${k}]`, s.id));
  });
  sem.phrases?.forEach((p, i) => claim(`semantics.phrases[${i}]`, p.id));
  sem.phraseRelations?.forEach((r, i) => claim(`semantics.phraseRelations[${i}]`, r.id));
  sem.interpretations?.forEach((r, i) => claim(`semantics.interpretations[${i}]`, r.id));

  // ── targets ─────────────────────────────────────────────────────────────
  sem.targets?.forEach((t, i) => {
    const p = `semantics.targets[${i}]`;
    const seg = chords.get(t.chord);
    if (!seg) return bad(`${p}.chord`, `unknown chord segment "${t.chord}"`);
    let arrival;
    try {
      arrival = parseFraction(t.arrival);
    } catch {
      return bad(`${p}.arrival`, `not an exact fraction string: ${JSON.stringify(t.arrival)}`);
    }
    if (t.register && (t.register.length !== 2 || t.register[0] > t.register[1])) bad(`${p}.register`, "needs [low, high] with low ≤ high");
    const chord = chordFromSegment(seg);
    if (t.degree !== "non-chord" && chord && !hasDegree(chord, t.degree)) bad(`${p}.degree`, `${seg.symbol} has no degree "${t.degree}"`);
    if (t.note) {
      const n = notes.get(t.note);
      if (!n) return bad(`${p}.note`, `unknown note "${t.note}"`);
      if (fcmp(parseFraction(n.onset), arrival) !== 0) bad(`${p}.arrival`, `target arrives at ${t.arrival}, but its note ${n.id} starts at ${n.onset}`);
      if (t.pitch && t.pitch.midi !== n.pitch.midi) bad(`${p}.pitch`, `target pitch ${t.pitch.name} differs from its note ${n.id} (${n.pitch.name})`);
      if (chord && t.degree !== "non-chord" && hasDegree(chord, t.degree)) {
        const want = degreeOf(chord, t.degree).note;
        if (pitchClass(want) !== ((n.pitch.midi % 12) + 12) % 12) bad(`${p}.degree`, `target says degree ${t.degree} of ${seg.symbol} (${formatNote(want)}), but its note ${n.id} is ${n.pitch.name}`);
      }
      const place = segAt(ir, arrival);
      if (place && place.id !== t.chord) bad(`${p}.chord`, `the target arrives during ${place.symbol}, not ${seg.symbol}`);
    }
  });

  // ── note functions ──────────────────────────────────────────────────────
  sem.noteFunctions?.forEach((f, i) => {
    const p = `semantics.noteFunctions[${i}]`;
    const n = notes.get(f.note);
    if (!n) return bad(`${p}.note`, `unknown note "${f.note}"`);
    const seg = segAt(ir, parseFraction(n.onset));
    if (!seg) return;
    const tones = seg.tones.map(tryNote);
    f.harmonic?.forEach((role) => {
      const idx = ROLE_BY_TONE.indexOf(role);
      if (idx >= 0 && idx < tones.length && tones[idx] && pitchClass(tones[idx]!) !== ((n.pitch.midi % 12) + 12) % 12) {
        bad(`${p}.harmonic`, `${n.id} is labelled ${role} of ${seg.symbol}, but the ${role} is ${seg.tones[idx]} and the note is ${n.pitch.name}`);
      }
      if (idx < 0 && !Object.values(EXTENSIONS).some((e) => e.role === role)) bad(`${p}.harmonic`, `unknown harmonic role "${role}"`);
    });
  });

  // ── gestures ────────────────────────────────────────────────────────────
  sem.gestures?.forEach((g, i) => {
    const p = `semantics.gestures[${i}]`;
    const members = g.notes.map((id, k) => {
      const n = notes.get(id);
      if (!n) bad(`${p}.notes[${k}]`, `unknown note "${id}"`);
      return n;
    });
    if (members.some((m) => !m)) return;
    const ns = members as IRNoteEvent[];
    for (let k = 1; k < ns.length; k++) {
      if (fcmp(parseFraction(ns[k]!.onset), parseFraction(ns[k - 1]!.onset)) < 0) bad(`${p}.notes`, "notes must be listed in time order");
    }
    g.steps.forEach((s, k) => s.outputs.forEach((o, j) => need(`${p}.steps[${k}].outputs[${j}]`, o, "note")));
    const tgt = g.target ? sem.targets?.find((t) => t.id === g.target) : undefined;
    if (g.target && !tgt) bad(`${p}.target`, `unknown target "${g.target}"`);
    const tNote = tgt?.note ? notes.get(tgt.note) : undefined;

    if (g.provenance.status !== "generated") return; // user-edited or analysed: history, not a promise

    if (g.kind === "arpeggiation") {
      ns.forEach((n, k) => {
        const seg = segAt(ir, parseFraction(n.onset));
        if (seg && !seg.tones.some((t) => tryNote(t) && pitchClass(tryNote(t)!) === ((n.pitch.midi % 12) + 12) % 12)) {
          bad(`${p}.notes[${k}]`, `${n.pitch.name} is not a tone of ${seg.symbol}, so this is not an outline of it`);
        }
      });
    }
    if (g.kind === "enclosure" && tNote) {
      const d = ns.map((n) => n.pitch.midi - tNote.pitch.midi);
      const near = d.filter((x) => Math.abs(x) >= 1 && Math.abs(x) <= 2);
      if (!(near.some((x) => x > 0) && near.some((x) => x < 0))) bad(p, `an enclosure needs a note one or two semitones above AND below its target ${tNote.pitch.name}; got ${ns.map((n) => n.pitch.name).join(", ")}`);
      if (ns.some((n) => fcmp(parseFraction(n.onset), parseFraction(tNote.onset)) >= 0)) bad(p, "an enclosure's notes must come before the target");
    }
    if (g.kind === "approach" && tNote && ns.length > 0) {
      const last = ns[ns.length - 1]!;
      if (Math.abs(last.pitch.midi - tNote.pitch.midi) > 2 || last.pitch.midi === tNote.pitch.midi) bad(p, `an approach must end a step from its target; ${last.pitch.name} is not a step from ${tNote.pitch.name}`);
    }
  });

  // ── motifs ──────────────────────────────────────────────────────────────
  sem.motifs?.forEach((m, i) => {
    const p = `semantics.motifs[${i}]`;
    if (m.durations.length !== m.intervals.length + 1 || m.accents.length !== m.durations.length) bad(p, "needs one more duration (and accent) than intervals");
    m.statements?.forEach((s, k) => {
      const q = `${p}.statements[${k}]`;
      const ns = s.notes.map((id) => notes.get(id));
      if (ns.some((n) => !n)) return bad(`${q}.notes`, "refers to a note that does not exist");
      const real = ns as IRNoteEvent[];
      if (real.length !== m.durations.length) return bad(`${q}.notes`, `statement has ${real.length} notes but the motif has ${m.durations.length}`);
      const got = real.slice(1).map((n, j) => n.pitch.midi - real[j]!.pitch.midi);
      if (got.join(",") !== m.intervals.join(",")) bad(`${q}.notes`, `intervals ${got.join(",")} do not match the motif's ${m.intervals.join(",")}`);
      real.forEach((n, j) => {
        if (fcmp(parseFraction(n.duration), parseFraction(m.durations[j]!)) !== 0) bad(`${q}.notes[${j}]`, `duration ${n.duration} differs from the motif's ${m.durations[j]}`);
      });
    });
  });

  // ── phrases, relations, interpretations ─────────────────────────────────
  sem.phrases?.forEach((ph, i) => ph.notes.forEach((id, k) => need(`semantics.phrases[${i}].notes[${k}]`, id, "note")));
  const phraseIds = new Set(sem.phrases?.map((x) => x.id));
  sem.phraseRelations?.forEach((r, i) => {
    if (!phraseIds.has(r.from)) bad(`semantics.phraseRelations[${i}].from`, `unknown phrase "${r.from}"`);
    if (r.to !== undefined && !phraseIds.has(r.to)) bad(`semantics.phraseRelations[${i}].to`, `unknown phrase "${r.to}"`);
  });
  const interpIds = new Set(sem.interpretations?.map((x) => x.id));
  sem.interpretations?.forEach((r, i) => {
    const p = `semantics.interpretations[${i}]`;
    if (!(typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1)) bad(`${p}.confidence`, "must be between 0 and 1");
    if (!r.evidence || r.evidence.length === 0) bad(`${p}.evidence`, "an interpretation must state its evidence");
    r.notes.forEach((id, k) => need(`${p}.notes[${k}]`, id, "note"));
    r.alternatives?.forEach((a, k) => {
      if (!interpIds.has(a)) bad(`${p}.alternatives[${k}]`, `unknown interpretation "${a}"`);
    });
  });
  return issues;
}
