/**
 * Analysis: musical events → relationships → possible gestures → interpretations.
 *
 * The opposite direction from generation, and deliberately more careful. Analysis is
 * context-dependent and often ambiguous, so this module keeps three things apart:
 *
 *   FACTS             what is definitely true of each note: its pitch class against the sounding
 *                     chord, its metric position, the size and direction of the moves in and out.
 *   INTERPRETATIONS   contextual readings (enclosure, passing tone, suspension ...), each with a
 *                     confidence and the evidence that supports it. Several may hold for the
 *                     same notes at once; readings that cannot all be true are linked as
 *                     alternatives.
 *   UNRESOLVED        non-chord tones for which no reading has enough evidence. They are listed,
 *                     never forced into a label. ("Not every non-chord tone is a passing tone.")
 *
 * Confidence is a transparent sum of named evidence, not a probability.
 */
import { formatNote, formatPitch, midi, parseNote, parsePitch, pitchClass, transposeNote, type Note, type Pitch } from "../theory/pitch";
import { fadd, fcmp, fnum, frac, fsub, parseFraction, type Fraction } from "../time/rational";
import type { IRChordSegment, IRInterpretation, IRNoteEvent, MusicIR } from "../ir/types";
import { CHORD_QUALITIES, EXTENSIONS, type ChordQuality, type DegreeRole } from "./chords";
import { FOUR_FOUR_FRAME, metricPosition, motionKind, type Direction, type MetricFrame, type MotionKind } from "./line";

// ── facts ─────────────────────────────────────────────────────────────────
export interface HarmonicFact {
  readonly role: DegreeRole;
  readonly label: string;
  readonly kind: "chord-tone" | "extension" | "alteration";
}

export interface MoveFact {
  readonly semitones: number;
  readonly motion: MotionKind;
  readonly direction: Direction;
}

export interface NoteFacts {
  readonly id: string;
  readonly pitch: Pitch;
  readonly onset: Fraction;
  readonly duration: Fraction;
  readonly chord: string | null;
  /** Null: not a chord tone and not a conventional extension (a non-chord tone). */
  readonly harmonic: HarmonicFact | null;
  /** The chord's own degree this pitch class is, if any extension/alteration. */
  readonly tension: string | null;
  readonly metric: { readonly label: string; readonly accent: number };
  readonly fromPrevious: MoveFact | null;
  readonly toNext: MoveFact | null;
}

export interface Interpretation {
  readonly id: string;
  readonly kind: string;
  readonly notes: readonly string[];
  readonly target?: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  /** Interpretations of overlapping notes that cannot all be right. */
  readonly alternatives: readonly string[];
}

export interface MelodyAnalysis {
  readonly voice: string;
  readonly facts: readonly NoteFacts[];
  readonly interpretations: readonly Interpretation[];
  readonly unresolved: readonly { readonly note: string; readonly reason: string }[];
}

export interface AnalysisOptions {
  readonly voice?: string;
  readonly frame?: MetricFrame;
}

const ROLE_ORDER: DegreeRole[] = ["root", "third", "fifth", "seventh"];

interface Seg {
  readonly id: string;
  readonly start: Fraction;
  readonly end: Fraction;
  readonly symbol: string;
  readonly tones: Note[];
  readonly root: Note;
  readonly quality: string;
}

function segmentsOf(ir: MusicIR): Seg[] {
  return ir.chords.map((c: IRChordSegment) => ({
    id: c.id,
    start: parseFraction(c.onset),
    end: fadd(parseFraction(c.onset), parseFraction(c.duration)),
    symbol: c.symbol,
    tones: c.tones.map(parseNote),
    root: parseNote(c.root),
    quality: c.quality,
  }));
}

function classifyIn(seg: Seg, pc: number, spelled?: Note): { fact: HarmonicFact | null; tension: string | null } {
  const idx = seg.tones.findIndex((t) => pitchClass(t) === pc);
  if (idx >= 0) return { fact: { role: ROLE_ORDER[idx]!, label: ["1", "3", "5", "7"][idx]!, kind: "chord-tone" }, tension: null };
  for (const [label, e] of Object.entries(EXTENSIONS)) {
    if (pitchClass(transposeNote(seg.root, e.interval)) === pc) {
      // a tension counts as an extension only if the chord's quality conventionally carries it (a natural 11th on a dominant 7th does not)
      const spelledRight = spelled === undefined || formatNote(transposeNote(seg.root, e.interval)) === formatNote(spelled);
      const conventional = (CHORD_QUALITIES[seg.quality as ChordQuality]?.extensions.includes(label) ?? false) && spelledRight;
      return { fact: conventional ? { role: e.role, label, kind: e.kind } : null, tension: label };
    }
  }
  return { fact: null, tension: null };
}

const moveOf = (a: Pitch, b: Pitch): MoveFact => {
  const d = midi(b) - midi(a);
  return { semitones: d, motion: motionKind(a, b), direction: d > 0 ? "up" : d < 0 ? "down" : "level" };
};

/** Two onsets close enough to belong to one gesture (within a half note). "Chromatic" in a reading's name means a semitone step by size, whether or not the note is in a key. */
const near = (a: Fraction, b: Fraction): boolean => fcmp(fsub(b, a), frac(1, 2)) <= 0;

interface Draft {
  kind: string;
  notes: string[];
  target?: string;
  confidence: number;
  evidence: string[];
}

const FAMILY = new Set([
  "passing-tone",
  "chromatic-passing-tone",
  "neighbor-tone",
  "chromatic-neighbor-tone",
  "chromatic-approach",
  "step-approach",
  "appoggiatura",
  "escape-tone",
  "anticipation",
  "suspension",
  "retardation",
  "cambiata",
]);

export function analyzeMelody(ir: MusicIR, opts: AnalysisOptions = {}): MelodyAnalysis {
  const voice = opts.voice ?? ir.voices.find((v) => v.role === "melody")?.id ?? ir.voices.find((v) => v.role !== "bass")?.id ?? ir.voices[0]?.id ?? "";
  const frame = opts.frame ?? FOUR_FOUR_FRAME;
  const segs = segmentsOf(ir);
  const raw = ir.events
    .filter((e): e is IRNoteEvent => e.kind === "note" && e.voice === voice)
    .sort((a, b) => fcmp(parseFraction(a.onset), parseFraction(b.onset)));
  const segAt = (t: Fraction): Seg | undefined => segs.find((s) => fcmp(t, s.start) >= 0 && fcmp(t, s.end) < 0);

  const notes = raw.map((e) => ({ id: e.id, pitch: parsePitch(e.pitch.name), onset: parseFraction(e.onset), duration: parseFraction(e.duration) }));

  // ── facts ──
  const facts: NoteFacts[] = notes.map((n, i) => {
    const seg = segAt(n.onset);
    const cls = seg ? classifyIn(seg, pitchClass(n.pitch), n.pitch) : { fact: null, tension: null };
    const mp = metricPosition(n.onset, frame);
    return {
      id: n.id,
      pitch: n.pitch,
      onset: n.onset,
      duration: n.duration,
      chord: seg?.id ?? null,
      harmonic: cls.fact,
      tension: cls.tension,
      metric: { label: mp.label, accent: mp.accent },
      fromPrevious: i > 0 ? moveOf(notes[i - 1]!.pitch, n.pitch) : null,
      toNext: i < notes.length - 1 ? moveOf(n.pitch, notes[i + 1]!.pitch) : null,
    };
  });
  const isChordTone = (i: number): boolean => facts[i]?.harmonic?.kind === "chord-tone";
  const isStable = (i: number): boolean => facts[i]?.harmonic !== null && facts[i]?.harmonic !== undefined;
  const isNct = (i: number): boolean => !isStable(i);
  const st = (i: number, j: number): number => midi(notes[j]!.pitch) - midi(notes[i]!.pitch);
  const adj = (i: number, j: number): boolean => near(notes[i]!.onset, notes[j]!.onset);

  const drafts: Draft[] = [];
  const add = (d: Draft) => drafts.push({ ...d, confidence: Math.min(0.95, Math.round(d.confidence * 100) / 100) });

  // ── enclosure: two notes, one above and one below, then a target a step away from both ──
  for (let i = 0; i + 2 < notes.length; i++) {
    const t = i + 2;
    if (!(adj(i, i + 1) && adj(i + 1, t))) continue;
    const a = midi(notes[i]!.pitch) - midi(notes[t]!.pitch);
    const b = midi(notes[i + 1]!.pitch) - midi(notes[t]!.pitch);
    if (!(a * b < 0 && Math.abs(a) <= 2 && Math.abs(b) <= 2 && a !== 0 && b !== 0)) continue;
    const chromatic = Math.abs(a) === 1 && Math.abs(b) === 1;
    const ev = [
      `${formatPitch(notes[i]!.pitch)} is ${Math.abs(a)} semitone${Math.abs(a) === 1 ? "" : "s"} ${a > 0 ? "above" : "below"} ${formatPitch(notes[t]!.pitch)}`,
      `${formatPitch(notes[i + 1]!.pitch)} is ${Math.abs(b)} semitone${Math.abs(b) === 1 ? "" : "s"} ${b > 0 ? "above" : "below"} it, on the other side`,
    ];
    let c = 0.5;
    if (isChordTone(t)) {
      c += 0.15;
      ev.push(`the target ${formatPitch(notes[t]!.pitch)} is the ${facts[t]!.harmonic!.role} of the sounding chord`);
    } else if (isStable(t)) {
      c += 0.08;
      ev.push(`the target is a ${facts[t]!.harmonic!.role} of the sounding chord`);
    } else ev.push("the target is not a chord tone: weaker evidence");
    if (facts[t]!.metric.accent >= 2) {
      c += 0.1;
      ev.push(`the target arrives on a ${facts[t]!.metric.label}`);
    }
    if (isNct(i) && isNct(i + 1)) {
      c += 0.1;
      ev.push("both surrounding notes are non-chord tones");
    }
    if (facts[i]!.metric.accent < facts[t]!.metric.accent && facts[i + 1]!.metric.accent < facts[t]!.metric.accent) {
      c += 0.05;
      ev.push("both are metrically lighter than the target");
    }
    if (chromatic) c += 0.05;
    add({ kind: chromatic ? "chromatic-enclosure" : "enclosure", notes: [notes[i]!.id, notes[i + 1]!.id, notes[t]!.id], target: notes[t]!.id, confidence: c, evidence: ev });
  }

  // ── approach: a non-chord note a step from the chord tone that follows ──
  for (let i = 0; i + 1 < notes.length; i++) {
    if (!isNct(i) || !isStable(i + 1) || !adj(i, i + 1)) continue;
    const d = Math.abs(st(i, i + 1));
    if (d < 1 || d > 2) continue;
    const ev = [`${formatPitch(notes[i]!.pitch)} is a non-chord tone ${d} semitone${d === 1 ? "" : "s"} from ${formatPitch(notes[i + 1]!.pitch)}, a ${facts[i + 1]!.harmonic!.role} of the chord`];
    let c = 0.45 + (isChordTone(i + 1) ? 0.15 : 0.05);
    if (facts[i]!.metric.accent < facts[i + 1]!.metric.accent) {
      c += 0.1;
      ev.push("it is metrically lighter than the note it leads to");
    }
    if (d === 1) c += 0.05;
    add({ kind: d === 1 ? "chromatic-approach" : "step-approach", notes: [notes[i]!.id, notes[i + 1]!.id], target: notes[i + 1]!.id, confidence: c, evidence: ev });
  }

  // ── passing tone / neighbour tone ──
  for (let i = 1; i + 1 < notes.length; i++) {
    if (!isNct(i) || !adj(i - 1, i) || !adj(i, i + 1)) continue;
    const before = st(i - 1, i);
    const after = st(i, i + 1);
    if (before !== 0 && after !== 0 && Math.sign(before) === Math.sign(after) && Math.abs(before) <= 2 && Math.abs(after) <= 2) {
      const chromatic = Math.abs(before) === 1 && Math.abs(after) === 1;
      const ev = [`it continues the same direction by steps (${before > 0 ? "+" : ""}${before}, ${after > 0 ? "+" : ""}${after} semitones) between ${formatPitch(notes[i - 1]!.pitch)} and ${formatPitch(notes[i + 1]!.pitch)}`];
      let c = 0.5;
      if (isStable(i - 1) && isStable(i + 1)) {
        c += 0.15;
        ev.push("it connects two chord tones");
      }
      if (facts[i]!.metric.accent <= facts[i - 1]!.metric.accent && facts[i]!.metric.accent < facts[i + 1]!.metric.accent) {
        c += 0.1;
        ev.push("it falls on a lighter position than the notes around it");
      }
      add({ kind: chromatic ? "chromatic-passing-tone" : "passing-tone", notes: [notes[i - 1]!.id, notes[i]!.id, notes[i + 1]!.id], target: notes[i + 1]!.id, confidence: c, evidence: ev });
    }
    if (st(i - 1, i + 1) === 0 && before !== 0 && Math.abs(before) <= 2) {
      const upper = before > 0;
      const chromatic = Math.abs(before) === 1;
      const ev = [`it leaves ${formatPitch(notes[i - 1]!.pitch)} by ${Math.abs(before)} semitone${Math.abs(before) === 1 ? "" : "s"} ${upper ? "up" : "down"} and returns to the same pitch`];
      let c = 0.6;
      if (isStable(i - 1)) {
        c += 0.1;
        ev.push("the pitch it returns to is a chord tone");
      }
      if (facts[i]!.metric.accent < facts[i - 1]!.metric.accent) {
        c += 0.1;
        ev.push("it is metrically lighter than the pitch it decorates");
      }
      add({ kind: chromatic ? "chromatic-neighbor-tone" : "neighbor-tone", notes: [notes[i - 1]!.id, notes[i]!.id, notes[i + 1]!.id], target: notes[i - 1]!.id, confidence: c, evidence: [...ev, `${upper ? "upper" : "lower"} neighbour`] });
    }
  }

  // ── appoggiatura: accented non-chord tone, reached by leap, resolved by step ──
  for (let i = 0; i + 1 < notes.length; i++) {
    if (!isNct(i) || !isStable(i + 1) || !adj(i, i + 1)) continue;
    if (facts[i]!.metric.accent < 2) continue;
    const res = st(i, i + 1);
    if (Math.abs(res) < 1 || Math.abs(res) > 2) continue;
    const ev = [`${formatPitch(notes[i]!.pitch)} is a non-chord tone on a ${facts[i]!.metric.label}`, `it resolves by a step to ${formatPitch(notes[i + 1]!.pitch)}`];
    let c = 0.5;
    if (i > 0 && Math.abs(st(i - 1, i)) >= 3 && adj(i - 1, i)) {
      c += 0.2;
      ev.push(`it is reached by a leap of ${Math.abs(st(i - 1, i))} semitones`);
      if (Math.sign(st(i - 1, i)) !== Math.sign(res)) {
        c += 0.1;
        ev.push("it resolves in the direction opposite to the leap");
      }
    } else ev.push("it is not reached by a leap: the reading is weaker");
    add({ kind: "appoggiatura", notes: [notes[i]!.id, notes[i + 1]!.id], target: notes[i + 1]!.id, confidence: c, evidence: ev });
  }

  // ── escape tone: reached by step, left by a leap the other way ──
  for (let i = 1; i + 1 < notes.length; i++) {
    if (!isNct(i) || !adj(i - 1, i) || !adj(i, i + 1)) continue;
    const before = st(i - 1, i);
    const after = st(i, i + 1);
    if (Math.abs(before) >= 1 && Math.abs(before) <= 2 && Math.abs(after) >= 3 && Math.sign(before) !== Math.sign(after)) {
      add({
        kind: "escape-tone",
        notes: [notes[i - 1]!.id, notes[i]!.id, notes[i + 1]!.id],
        target: notes[i + 1]!.id,
        confidence: 0.5 + (isStable(i - 1) ? 0.1 : 0) + (isStable(i + 1) ? 0.1 : 0) + (facts[i]!.metric.accent < 2 ? 0.1 : 0),
        evidence: [`${formatPitch(notes[i]!.pitch)} is reached by a step (${before}) and left by a leap of ${Math.abs(after)} semitones in the opposite direction`],
      });
    }
  }

  // ── anticipation: sounds early a tone of the NEXT chord, then the chord arrives on that pitch ──
  for (let i = 0; i + 1 < notes.length; i++) {
    const seg = segAt(notes[i]!.onset);
    if (!seg) continue;
    const nextSeg = segs.find((s) => fcmp(s.start, seg.end) === 0);
    if (!nextSeg || !isNct(i)) continue;
    const early = fsub(nextSeg.start, notes[i]!.onset);
    if (!(early.num > 0 && fcmp(early, frac(1, 4)) <= 0)) continue;
    const nextClass = classifyIn(nextSeg, pitchClass(notes[i]!.pitch), notes[i]!.pitch);
    if (!nextClass.fact) continue;
    const ev = [`${formatPitch(notes[i]!.pitch)} is not in ${seg.symbol} but is the ${nextClass.fact.role} of the next chord, ${nextSeg.symbol}`, `it sounds ${fnum(early) * 4} beat${fnum(early) * 4 === 1 ? "" : "s"} before that chord`];
    let c = 0.55;
    if (midi(notes[i + 1]!.pitch) === midi(notes[i]!.pitch) && fcmp(notes[i + 1]!.onset, nextSeg.start) >= 0) {
      c += 0.25;
      ev.push("the same pitch is sounded again as the chord arrives");
    }
    if (facts[i]!.metric.accent < 2) c += 0.05;
    add({ kind: "anticipation", notes: [notes[i]!.id, notes[i + 1]!.id], target: notes[i + 1]!.id, confidence: c, evidence: ev });
  }

  // ── suspension / retardation: prepared in the old chord, dissonant on the new one, resolved by step ──
  for (let i = 1; i + 1 < notes.length; i++) {
    const seg = segAt(notes[i]!.onset);
    if (!seg || !isNct(i)) continue;
    const late = fsub(notes[i]!.onset, seg.start);
    if (!(fcmp(late, frac(1, 8)) <= 0)) continue; // it must begin with the chord
    const prevSeg = segAt(notes[i - 1]!.onset);
    if (!prevSeg || prevSeg.id === seg.id) continue;
    if (midi(notes[i - 1]!.pitch) !== midi(notes[i]!.pitch)) continue;
    if (!classifyIn(prevSeg, pitchClass(notes[i - 1]!.pitch), notes[i - 1]!.pitch).fact) continue;
    const res = st(i, i + 1);
    if (Math.abs(res) < 1 || Math.abs(res) > 2 || !isStable(i + 1)) continue;
    add({
      kind: res < 0 ? "suspension" : "retardation",
      notes: [notes[i - 1]!.id, notes[i]!.id, notes[i + 1]!.id],
      target: notes[i + 1]!.id,
      confidence: 0.6 + (facts[i]!.metric.accent >= 2 ? 0.15 : 0) + (isChordTone(i + 1) ? 0.1 : 0),
      evidence: [
        `preparation: ${formatPitch(notes[i - 1]!.pitch)} is consonant in ${prevSeg.symbol}`,
        `dissonance: the same pitch is held (re-sounded) as ${seg.symbol} begins, and is not one of its tones`,
        `resolution: it moves ${res < 0 ? "down" : "up"} by a step to ${formatPitch(notes[i + 1]!.pitch)}`,
      ],
    });
  }

  // ── cambiata: consonance, step down to a dissonance, leap down a third, step up ──
  for (let i = 0; i + 3 < notes.length; i++) {
    if (!(adj(i, i + 1) && adj(i + 1, i + 2) && adj(i + 2, i + 3))) continue;
    if (isChordTone(i) && isNct(i + 1) && isStable(i + 2) && st(i, i + 1) < 0 && st(i, i + 1) >= -2 && st(i + 1, i + 2) <= -3 && st(i + 1, i + 2) >= -4 && st(i + 2, i + 3) > 0 && st(i + 2, i + 3) <= 2) {
      add({
        kind: "cambiata",
        notes: [notes[i]!.id, notes[i + 1]!.id, notes[i + 2]!.id, notes[i + 3]!.id],
        target: notes[i + 2]!.id,
        confidence: 0.6,
        evidence: ["step down from a chord tone to a non-chord tone, a leap down a third to a chord tone, then a step up"],
      });
    }
  }

  // ── pedal tone: one pitch returning through changing harmony, clashing in some of it ──
  for (let i = 0; i < notes.length; ) {
    let j = i;
    const run = [i];
    for (let k = i + 1; k < notes.length; k++) {
      // a pedal may sit through whole bars of other harmony: allow up to two whole notes between statements
      if (midi(notes[k]!.pitch) === midi(notes[i]!.pitch) && fcmp(fsub(notes[k]!.onset, notes[run[run.length - 1]!]!.onset), frac(2)) <= 0) {
        run.push(k);
        j = k;
      } else break;
    }
    const chordIds = new Set(run.map((k) => facts[k]!.chord).filter((x) => x !== null));
    if (run.length >= 3 && chordIds.size >= 2 && run.some((k) => isNct(k))) {
      add({
        kind: "pedal-tone",
        notes: run.map((k) => notes[k]!.id),
        confidence: 0.55 + Math.min(0.2, 0.05 * (run.length - 3)) + (isChordTone(run[0]!) ? 0.1 : 0),
        evidence: [`${formatPitch(notes[i]!.pitch)} is sounded ${run.length} times while the harmony changes across ${chordIds.size} chords`, `it is a non-chord tone in ${run.filter((k) => isNct(k)).length} of the ${run.length} statements`],
      });
    }
    i = Math.max(j, i) + 1;
  }

  // ── arpeggiation: three or more consecutive tones of one chord, moving by thirds-or-larger ──
  for (let i = 0; i < notes.length; ) {
    let j = i;
    while (j + 1 < notes.length && isChordTone(j + 1) && facts[j + 1]!.chord === facts[i]!.chord && adj(j, j + 1) && Math.abs(st(j, j + 1)) >= 3 && isChordTone(i)) j++;
    if (j - i + 1 >= 3) {
      const dirs = new Set<number>();
      for (let k = i; k < j; k++) dirs.add(Math.sign(st(k, k + 1)));
      const seg = segs.find((s) => s.id === facts[i]!.chord);
      add({
        kind: "arpeggiation",
        notes: notes.slice(i, j + 1).map((n) => n.id),
        confidence: 0.6 + Math.min(0.3, 0.07 * (j - i + 1 - 3)),
        evidence: [
          `${j - i + 1} consecutive tones of ${seg?.symbol ?? "the chord"}: ${notes.slice(i, j + 1).map((n, k) => `${formatPitch(n.pitch)} (${facts[i + k]!.harmonic?.role})`).join(", ")}`,
          `moving ${dirs.size === 1 ? (dirs.has(1) ? "upward" : "downward") : "in both directions"} by skips and leaps`,
        ],
      });
      i = j + 1;
    } else i++;
  }

  // ── guide-tone line: thirds/sevenths of successive chords joined by step ──
  const guide: { i: number; seg: string }[] = [];
  for (const seg of segs) {
    const idx = notes.findIndex((_, k) => facts[k]!.chord === seg.id && (facts[k]!.harmonic?.role === "third" || facts[k]!.harmonic?.role === "seventh"));
    if (idx >= 0) guide.push({ i: idx, seg: seg.id });
  }
  for (let g = 0; g + 1 < guide.length; ) {
    let h = g;
    while (h + 1 < guide.length && Math.abs(st(guide[h]!.i, guide[h + 1]!.i)) <= 2) h++;
    if (h > g) {
      add({
        kind: "guide-tone-line",
        notes: guide.slice(g, h + 1).map((x) => notes[x.i]!.id),
        confidence: 0.55 + 0.1 * (h - g),
        evidence: [`thirds and sevenths of ${h - g + 1} successive chords are connected by steps: ${guide.slice(g, h + 1).map((x) => `${formatPitch(notes[x.i]!.pitch)} (${facts[x.i]!.harmonic?.role})`).join(" → ")}`],
      });
    }
    g = h + 1;
  }

  // ── sequence / repetition: the same interval and rhythm pattern again, on a new pitch (or the same) ──
  for (let k = 3; k <= 5; k++) {
    for (let i = 0; i + 2 * k <= notes.length; i++) {
      const a = notes.slice(i, i + k);
      const b = notes.slice(i + k, i + 2 * k);
      const ia = a.slice(1).map((n, x) => midi(n.pitch) - midi(a[x]!.pitch)).join(",");
      const ib = b.slice(1).map((n, x) => midi(n.pitch) - midi(b[x]!.pitch)).join(",");
      const ra = a.map((n) => `${n.duration.num}/${n.duration.den}`).join(",");
      const rb = b.map((n) => `${n.duration.num}/${n.duration.den}`).join(",");
      if (ia === ib && ra === rb && new Set(ia.split(",")).size > 0) {
        const shift = midi(b[0]!.pitch) - midi(a[0]!.pitch);
        add({
          kind: shift === 0 ? "motif-repetition" : "melodic-sequence",
          notes: [...a, ...b].map((n) => n.id),
          confidence: 0.5 + 0.1 * (k - 3) + 0.15,
          evidence: [`the ${k}-note pattern with intervals [${ia}] and the same rhythm is stated again ${shift === 0 ? "on the same pitch" : `${Math.abs(shift)} semitones ${shift > 0 ? "higher" : "lower"}`}`],
        });
      }
    }
  }

  // ── number the readings, link rival readings of the same notes ──
  const out: Interpretation[] = drafts.map((d, i) => ({ id: `i-${i + 1}`, kind: d.kind, notes: d.notes, ...(d.target ? { target: d.target } : {}), confidence: d.confidence, evidence: d.evidence, alternatives: [] }));
  // the note a family reading is ABOUT is the decorating note: for approach-like readings its first note, otherwise the middle one
  const subject = (r: Interpretation): string => (r.notes.length === 3 && r.kind !== "chromatic-enclosure" && r.kind !== "enclosure" ? r.notes[1]! : r.notes[0]!);
  const withAlts = out.map((r) => {
    if (!FAMILY.has(r.kind)) return r;
    const rivals = out.filter((o) => o.id !== r.id && FAMILY.has(o.kind) && subject(o) === subject(r));
    return { ...r, alternatives: rivals.map((o) => o.id) };
  });

  // ── non-chord tones nobody could explain ──
  const explained = new Set<string>();
  for (const r of withAlts) {
    if (FAMILY.has(r.kind)) explained.add(subject(r));
    if (r.kind === "enclosure" || r.kind === "chromatic-enclosure") {
      explained.add(r.notes[0]!);
      explained.add(r.notes[1]!);
    }
    if (r.kind === "pedal-tone") r.notes.forEach((n) => explained.add(n));
  }
  const unresolved = facts
    .filter((f) => f.harmonic === null && !explained.has(f.id))
    .map((f) => ({ note: f.id, reason: `${formatPitch(f.pitch)} is not a tone of the sounding chord and the surrounding motion does not clearly fit any known figure` }));

  return { voice, facts, interpretations: withAlts, unresolved };
}

/** Interpretations in their stored form (provenance "inferred" is implied by living under semantics.interpretations). */
export function interpretationsToIR(a: MelodyAnalysis): IRInterpretation[] {
  return a.interpretations.map((r) => ({
    id: r.id,
    kind: r.kind,
    notes: r.notes,
    ...(r.target ? { target: r.target } : {}),
    confidence: r.confidence,
    evidence: r.evidence,
    ...(r.alternatives.length ? { alternatives: r.alternatives } : {}),
  }));
}

/** Attach an analysis to a document (replacing earlier interpretations); nothing else changes. */
export function withInterpretations(ir: MusicIR, a: MelodyAnalysis): MusicIR {
  return { ...ir, semantics: { ...(ir.semantics ?? { version: 1 as const }), version: 1 as const, interpretations: interpretationsToIR(a) } };
}
