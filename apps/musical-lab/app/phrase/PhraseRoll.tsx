"use client";

import { memo, useMemo, type RefObject } from "react";
import { fstr, parseFraction, type FrameSchedule, type IRNoteEvent, type MusicIR } from "@musical-lab/engine";

export type NoteKind = "target" | "outline" | "embellish" | "other";

/** How a note is drawn: by its construction role (target, outline, approach/enclosure), not only its harmony. */
export function noteKind(ir: MusicIR, note: IRNoteEvent): NoteKind {
  const f = ir.semantics?.noteFunctions?.find((x) => x.note === note.id);
  const structural = f?.structural ?? (note.roles?.structural ? [note.roles.structural] : []);
  if (structural.includes("target")) return "target";
  if (structural.includes("enclosure-member") || structural.includes("approach-note") || structural.includes("run-note")) return "embellish";
  if (structural.includes("outline")) return "outline";
  return "other";
}

interface Props {
  ir: MusicIR;
  schedule: FrameSchedule;
  pxPerSecond: number;
  selected: string | null;
  melodyVoice: string;
  playheadRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onSeek: (frame: number) => void;
}

const ROW = 11;
const TOP = 28;

/**
 * Piano-roll of the phrase on an exact time axis. Every rectangle sits on the frame the scheduler
 * gave it; colour is the note's role in the phrase's construction.
 */
function PhraseRollView({ ir, schedule, pxPerSecond, selected, melodyVoice, playheadRef, scrollRef, onSelect, onSeek }: Props) {
  const pxPerFrame = pxPerSecond / schedule.sampleRate;
  const width = Math.max(1, Math.round(schedule.totalFrames * pxPerFrame));
  const notes = useMemo(() => ir.events.filter((e): e is IRNoteEvent => e.kind === "note"), [ir]);
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n] as const)), [notes]);
  const [lo, hi] = useMemo(() => {
    const ms = notes.map((n) => n.pitch.midi);
    return ms.length ? [Math.min(...ms), Math.max(...ms)] : [48, 72];
  }, [notes]);
  const height = TOP + (hi - lo + 3) * ROW;
  const y = (midi: number) => TOP + (hi - midi + 1) * ROW;

  // beat lines come from the schedule's own chord frames and the tempo: one per quarter within each chord
  const beatFrames = useMemo(() => {
    const out: number[] = [];
    const first = schedule.chords[0];
    if (!first) return out;
    const chordLen = first.endFrame - first.startFrame;
    const beat = chordLen / 4;
    for (let f = 0; f < schedule.totalFrames; f += beat) out.push(Math.round(f));
    return out;
  }, [schedule]);

  return (
    <div className="tl-scroll" ref={scrollRef}>
      <div className="tl" style={{ width, height }} data-testid="phrase-roll">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Piano-roll of the phrase"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, Math.round((e.clientX - r.left) / pxPerFrame)));
          }}
        >
          {schedule.chords.map((c) => (
            <g key={c.id}>
              <rect x={c.startFrame * pxPerFrame} y={0} width={Math.max(1, (c.endFrame - c.startFrame) * pxPerFrame)} height={TOP - 2} className="tl-chord" />
              <text x={c.startFrame * pxPerFrame + 6} y={17} className="tl-chord-label">
                {c.symbol}
              </text>
            </g>
          ))}
          {beatFrames.map((f, i) => (
            <line key={f} x1={f * pxPerFrame} x2={f * pxPerFrame} y1={i % 4 === 0 ? 0 : TOP} y2={height} className={i % 4 === 0 ? "tl-bar" : "tl-beat"} />
          ))}
          {schedule.events.map((e) => {
            const n = byId.get(e.id);
            if (!n) return null;
            const kind = noteKind(ir, n);
            const isMelody = n.voice === melodyVoice;
            return (
              <rect
                key={e.id}
                x={e.startFrame * pxPerFrame}
                y={y(e.midi)}
                width={Math.max(3, (e.endFrame - e.startFrame) * pxPerFrame - 1)}
                height={ROW - 1}
                rx={2}
                className={`ph-note ph-${isMelody ? kind : "bass"}${selected === e.id ? " selected" : ""}`}
                data-note={e.id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (isMelody) onSelect(e.id);
                }}
              >
                <title>
                  {n.pitch.name} · {fstr(parseFraction(n.onset))} + {fstr(parseFraction(n.duration))} · {e.startFrame}–{e.endFrame} frames
                </title>
              </rect>
            );
          })}
        </svg>
        <div className="tl-playhead" ref={playheadRef} />
      </div>
    </div>
  );
}

export default memo(PhraseRollView);
