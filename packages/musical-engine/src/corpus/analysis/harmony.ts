/**
 * Melody against EXPLICIT harmony. Where a piece carries chord symbols, notes are related to the chord that
 * sounds under them; where it does not, this returns `present: false` and nothing is invented. Roles are
 * given as the semitone distance above the chord root, not as jazz function names, so the same analysis can
 * describe any chord vocabulary the source states.
 */
import { fnum } from "../../time/rational";
import type { MelodyLine, MelodyNote } from "./melody";
import { histogram, round, share, summarize, type Histogram, type Summary } from "./stats";

export type HarmonicAnalysis =
  | { readonly present: false; readonly reason: string }
  | {
      readonly present: true;
      /** Share of notes that begin under a stated chord. */
      readonly annotatedShare: number;
      readonly chordCount: number;
      /** Chord-tone notes by semitones above the root ("0" root, "4" or "3" third, "7" fifth, ...); "nct" is a non-chord tone. */
      readonly noteRoles: Histogram;
      readonly chordToneShare: number;
      /** Counts behind the shares, so a corpus can pool them instead of averaging averages. */
      readonly counts: { readonly annotated: number; readonly chordTones: number; readonly strong: readonly [number, number]; readonly beat: readonly [number, number]; readonly weak: readonly [number, number]; readonly changes: number; readonly changesOnDownbeat: number };
      /** Chord-tone share by metric weight class. */
      readonly chordToneShareByStrength: { readonly strong: number; readonly beat: number; readonly weak: number };
      /** Non-chord tones by how they are approached and left. */
      readonly nonChordTones: Histogram;
      /** Share of chord changes that fall on a downbeat. */
      readonly changeOnDownbeatShare: number;
      readonly harmonicRhythm: Summary;
      /** Notes that begin exactly where a chord changes: what they are relative to the new chord. */
      readonly onChordChange: { readonly count: number; readonly chordToneShare: number; readonly rootShare: number };
    };

const EPS = 1e-9;

export function harmonicAnalysis(line: MelodyLine): HarmonicAnalysis {
  const chords = line.chords.filter((c) => c.intervals);
  if (chords.length === 0) return { present: false, reason: line.chords.length ? "chord symbols are present but none has interpreted tones" : "the piece states no chords (none are inferred)" };

  const chordAt = (n: MelodyNote) => chords.find((c) => fnum(c.onset) <= fnum(n.onset) + EPS && fnum(n.onset) < fnum(c.end) - EPS);
  const roles: Histogram = {};
  const nct: Histogram = {};
  const byStrength = { strong: [0, 0], beat: [0, 0], weak: [0, 0] } as Record<"strong" | "beat" | "weak", [number, number]>;
  let annotated = 0;
  let chordTones = 0;
  const changeOnsets = new Set(chords.map((c) => fnum(c.onset)));
  let onChange = 0;
  let onChangeCT = 0;
  let onChangeRoot = 0;

  line.notes.forEach((n, i) => {
    const c = chordAt(n);
    if (!c) return;
    annotated++;
    const rel = (((Math.round(n.midi) - c.rootPc) % 12) + 12) % 12;
    const isCT = c.intervals!.includes(rel);
    const strength = n.weight >= 3 ? "strong" : n.weight === 2 ? "beat" : "weak";
    byStrength[strength][1]++;
    if (isCT) {
      chordTones++;
      byStrength[strength][0]++;
      roles[String(rel)] = (roles[String(rel)] ?? 0) + 1;
    } else {
      roles.nct = (roles.nct ?? 0) + 1;
      const prev = line.notes[i - 1];
      const next = line.notes[i + 1];
      const inStep = prev ? Math.abs(n.midi - prev.midi) <= 2 && n.midi !== prev.midi : false;
      const outStep = next ? Math.abs(next.midi - n.midi) <= 2 && next.midi !== n.midi : false;
      let kind: string;
      if (!prev || !next) kind = "edge";
      else if (inStep && outStep) kind = Math.sign(n.midi - prev.midi) === Math.sign(next.midi - n.midi) ? "passing" : "neighbor";
      else if (!inStep && outStep) kind = "leap-approached";
      else if (inStep && !outStep) kind = "step-approached-leap-left";
      else kind = "other";
      nct[kind] = (nct[kind] ?? 0) + 1;
    }
    if (changeOnsets.has(fnum(n.onset)) && fnum(n.onset) > 0) {
      onChange++;
      if (isCT) onChangeCT++;
      if (rel === 0) onChangeRoot++;
    }
  });

  const downbeat = (c: (typeof chords)[number]) => {
    const n = line.notes.find((x) => Math.abs(fnum(x.onset) - fnum(c.onset)) < EPS);
    if (n) return n.weight >= 4;
    const bar = line.bars.find((b) => fnum(b.onset) <= fnum(c.onset) + EPS && fnum(c.onset) < fnum(b.onset) + fnum(b.length) - EPS);
    return !!bar && Math.abs(fnum(c.onset) - fnum(bar.onset)) < EPS && !bar.pickup;
  };
  const beatLen = fnum(line.bars[0]?.beat ?? { num: 1, den: 4 });
  return {
    present: true,
    annotatedShare: share(annotated, line.notes.length),
    chordCount: chords.length,
    noteRoles: roles,
    chordToneShare: share(chordTones, annotated),
    counts: { annotated, chordTones, strong: byStrength.strong, beat: byStrength.beat, weak: byStrength.weak, changes: chords.length, changesOnDownbeat: chords.filter(downbeat).length },
    chordToneShareByStrength: { strong: share(byStrength.strong[0], byStrength.strong[1]), beat: share(byStrength.beat[0], byStrength.beat[1]), weak: share(byStrength.weak[0], byStrength.weak[1]) },
    nonChordTones: nct,
    changeOnDownbeatShare: share(chords.filter(downbeat).length, chords.length),
    harmonicRhythm: summarize(chords.map((c) => round((fnum(c.end) - fnum(c.onset)) / beatLen, 3))),
    onChordChange: { count: onChange, chordToneShare: share(onChangeCT, onChange), rootShare: share(onChangeRoot, onChange) },
  };
}

export { histogram };
