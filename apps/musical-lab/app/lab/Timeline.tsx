"use client";

import { memo, useMemo, type RefObject } from "react";
import {
  frac,
  fadd,
  fmul,
  parseFraction,
  toSampleFrameExact,
  type FrameSchedule,
  type IRNoteEvent,
  type MusicIR,
} from "@musical-lab/engine";

interface Props {
  ir: MusicIR;
  schedule: FrameSchedule;
  /** The document's tempo as exact fractions (for the beat grid). */
  tempo: { bpm: ReturnType<typeof parseFraction>; beat: ReturnType<typeof parseFraction> };
  /** Steps per chord in the rhythm editor, to draw its grid (triplets, quintuplets, ...). */
  gridSteps: number;
  pxPerSecond: number;
  activeIndex: number;
  /** The playhead element: the parent moves it every animation frame without re-rendering this. */
  playheadRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSeek: (frame: number) => void;
}

const ROW = 9; // px per semitone
const TOP = 26; // chord band
const COLORS = { root: "var(--brass)", third: "var(--ink)", fifth: "var(--stone)", none: "var(--stone)" } as const;

/**
 * The rhythmic timeline: a piano-roll of the document's notes on an exact time axis, with the
 * beat grid, the rhythm's own subdivision grid (so triplets and quintuplets are visible as what
 * they are), and the chord segments. Everything is placed from the exact frames in the schedule.
 */
function TimelineView({ ir, schedule, tempo, gridSteps, pxPerSecond, activeIndex, playheadRef, scrollRef, onSeek }: Props) {
  const pxPerFrame = pxPerSecond / schedule.sampleRate;
  const width = Math.max(1, Math.round(schedule.totalFrames * pxPerFrame));

  const notes = useMemo(() => ir.events.filter((e): e is IRNoteEvent => e.kind === "note"), [ir]);
  const [lo, hi] = useMemo(() => {
    const ms = notes.map((n) => n.pitch.midi);
    return ms.length ? [Math.min(...ms), Math.max(...ms)] : [48, 72];
  }, [notes]);
  const height = TOP + (hi - lo + 3) * ROW;
  const y = (midi: number) => TOP + (hi - midi + 1) * ROW;

  // beat and subdivision lines, from exact positions (not accumulated floats)
  const lines = useMemo(() => {
    const beats: number[] = [];
    const bars: number[] = [];
    const total = schedule.totalFrames;
    for (let k = 0; ; k++) {
      const f = toSampleFrameExact(frac(k, 4), tempo.bpm, schedule.sampleRate, tempo.beat);
      if (f >= total) break;
      (k % 4 === 0 ? bars : beats).push(f);
    }
    const steps: number[] = [];
    if (gridSteps > 1) {
      for (const c of ir.chords) {
        const start = parseFraction(c.onset);
        const dur = parseFraction(c.duration);
        for (let i = 1; i < gridSteps; i++) {
          steps.push(toSampleFrameExact(fadd(start, fmul(dur, frac(i, gridSteps))), tempo.bpm, schedule.sampleRate, tempo.beat));
        }
      }
    }
    return { beats, bars, steps };
  }, [ir.chords, tempo, schedule.sampleRate, schedule.totalFrames, gridSteps]);

  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n] as const)), [notes]);

  return (
    <div className="tl-scroll" ref={scrollRef}>
      <div className="tl" style={{ width, height }} data-testid="timeline">
        <svg
          width={width}
          height={height}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, Math.round((e.clientX - r.left) / pxPerFrame)));
          }}
          role="img"
          aria-label="Rhythmic timeline of the notes"
        >
          {/* chord band */}
          {schedule.chords.map((c, i) => (
            <g key={c.id}>
              <rect
                x={c.startFrame * pxPerFrame}
                y={0}
                width={Math.max(1, (c.endFrame - c.startFrame) * pxPerFrame)}
                height={TOP - 2}
                className={i === activeIndex ? "tl-chord active" : "tl-chord"}
              />
              <text x={c.startFrame * pxPerFrame + 6} y={16} className="tl-chord-label">
                {c.symbol}
              </text>
            </g>
          ))}
          {/* grid */}
          {lines.steps.map((f, i) => (
            <line key={`s${i}`} x1={f * pxPerFrame} x2={f * pxPerFrame} y1={TOP} y2={height} className="tl-step" />
          ))}
          {lines.beats.map((f) => (
            <line key={`b${f}`} x1={f * pxPerFrame} x2={f * pxPerFrame} y1={TOP} y2={height} className="tl-beat" />
          ))}
          {lines.bars.map((f) => (
            <line key={`m${f}`} x1={f * pxPerFrame} x2={f * pxPerFrame} y1={0} y2={height} className="tl-bar" />
          ))}
          {/* notes */}
          {schedule.events.map((e) => {
            const n = byId.get(e.id);
            const role = (n?.roles?.harmonic as keyof typeof COLORS | undefined) ?? "none";
            return (
              <rect
                key={e.id}
                x={e.startFrame * pxPerFrame}
                y={y(e.midi)}
                width={Math.max(2, (e.endFrame - e.startFrame) * pxPerFrame - 1)}
                height={ROW - 1}
                rx={2}
                fill={COLORS[role] ?? COLORS.none}
                opacity={0.45 + 0.18 * Math.min(3, e.accent)}
                data-note={e.id}
              >
                <title>{`${n?.pitch.name ?? ""} · ${e.startFrame}–${e.endFrame} frames`}</title>
              </rect>
            );
          })}
        </svg>
        <div className="tl-playhead" ref={playheadRef} />
      </div>
    </div>
  );
}

/** Re-renders only when the document or the view settings change, never per animation frame. */
export default memo(TimelineView);
