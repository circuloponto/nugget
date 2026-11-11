"use client";

import { memo, useMemo, type RefObject } from "react";
import { corpus, fnum, fstr, parseFraction } from "@musical-lab/engine";

export const TL_LEFT = 14;
export const pxPerWhole = (pxPerQuarter: number): number => pxPerQuarter * 4;

export interface Segment {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly confidence: number;
}

interface Props {
  line: corpus.MelodyLine;
  harmony: readonly corpus.CorpusHarmony[];
  segments: readonly Segment[];
  /** Boundary note indices drawn as solid lines for the chosen level, with their scores. */
  boundaries: readonly { index: number; score: number }[];
  /** Every other hypothesis worth showing (faint), when asked for. */
  faint: readonly { index: number; score: number }[];
  selectedSegment: number | null;
  selectedNote: string | null;
  selectedBoundary: number | null;
  highlight: ReadonlySet<string>;
  sounding: ReadonlySet<string>;
  pxPerQuarter: number;
  playheadRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelectNote: (id: string) => void;
  onSelectSegment: (i: number) => void;
  onSelectBoundary: (index: number) => void;
  onSeek: (wholeNotes: number) => void;
}

const CHORD_H = 20;
const BAR_H = 22;
const PHRASE_H = 24;
const ROW = 7;
const ROLL_TOP = CHORD_H + BAR_H + PHRASE_H + 8;
const DENS_H = 54;

function TimelineView({ line, harmony, segments, boundaries, faint, selectedSegment, selectedNote, selectedBoundary, highlight, sounding, pxPerQuarter, playheadRef, scrollRef, onSelectNote, onSelectSegment, onSelectBoundary, onSeek }: Props) {
  const ppw = pxPerWhole(pxPerQuarter);
  const x = (t: number) => TL_LEFT + t * ppw;
  const width = Math.ceil(x(fnum(line.length))) + 24;
  const [lo, hi] = useMemo(() => {
    const ms = line.notes.map((n) => n.midi);
    return [Math.floor(Math.min(...ms)) - 1, Math.ceil(Math.max(...ms)) + 1];
  }, [line]);
  const rollH = (hi - lo + 1) * ROW;
  const densTop = ROLL_TOP + rollH + 14;
  const height = densTop + DENS_H + 10;
  const y = (m: number) => ROLL_TOP + (hi - m) * ROW;

  // attacks in each beat-long window, from the written bar starts
  const density = useMemo(() => {
    const out: { start: number; len: number; n: number }[] = [];
    for (const b of line.bars) {
      const beat = fnum(b.beat);
      const startPhase = fnum(b.startPhase);
      const first = Math.floor(startPhase / beat + 1e-9);
      const slots = Math.max(1, Math.ceil((startPhase + fnum(b.length)) / beat - 1e-9) - first);
      for (let s = 0; s < slots; s++) {
        const w0 = fnum(b.onset) + (first + s) * beat - startPhase;
        const w1 = w0 + beat;
        const lo0 = Math.max(w0, fnum(b.onset));
        const n = line.notes.filter((nt) => nt.bar === b.index && fnum(nt.onset) >= lo0 - 1e-9 && fnum(nt.onset) < w1 - 1e-9).length;
        out.push({ start: lo0, len: Math.min(w1, fnum(b.onset) + fnum(b.length)) - lo0, n });
      }
    }
    return out;
  }, [line]);
  const maxDens = Math.max(1, ...density.map((d) => d.n));

  return (
    <div className="tl-scroll" ref={scrollRef}>
      <div className="tl co-tl" style={{ width, height }} data-testid="co-timeline">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Symbolic timeline of the melody with bars, chords, phrase hypotheses, notes, rests and attack density"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, (e.clientX - r.left - TL_LEFT) / ppw));
          }}
        >
          {/* phrase hypotheses */}
          {segments.map((s, i) => {
            const a = line.notes[s.from]!;
            const b = line.notes[s.to]!;
            const x0 = x(fnum(a.onset));
            const x1 = x(fnum(b.end));
            return (
              <g key={s.id} onClick={(e) => { e.stopPropagation(); onSelectSegment(i); }} className="co-seg-g">
                <rect x={x0} y={ROLL_TOP - 4} width={Math.max(1, x1 - x0)} height={rollH + 8} className={`co-seg ${i % 2 ? "odd" : ""}${selectedSegment === i ? " sel" : ""}`} />
                <rect x={x0} y={CHORD_H + BAR_H + 2} width={Math.max(1, x1 - x0 - 1)} height={PHRASE_H - 4} rx={4} className={`co-seg-head ${selectedSegment === i ? "sel" : ""}`} data-segment={s.id} />
                <text x={x0 + 6} y={CHORD_H + BAR_H + 17} className="co-seg-label">
                  {s.id} <tspan className="co-seg-conf">{Math.round(s.confidence * 100)}%</tspan>
                </text>
              </g>
            );
          })}

          {/* chords */}
          {harmony.map((h) => {
            const on = fnum(parseFraction(h.onset));
            const x0 = x(on);
            const x1 = x(on + fnum(parseFraction(h.duration)));
            return (
              <g key={h.id}>
                <rect x={x0} y={0} width={Math.max(1, x1 - x0 - 1)} height={CHORD_H - 2} className="tl-chord" />
                <text x={x0 + 4} y={14} className="tl-chord-label">{h.symbol}</text>
              </g>
            );
          })}

          {/* bars, repeat signs, endings */}
          {line.bars.map((b) => {
            const x0 = x(fnum(b.onset));
            return (
              <g key={b.index}>
                <line x1={x0} x2={x0} y1={CHORD_H} y2={densTop + DENS_H} className={b.pickup ? "tl-beat" : "tl-bar"} />
                <text x={x0 + 3} y={CHORD_H + 13} className="co-barnum">{b.pickup ? "pickup" : b.number}</text>
                {b.repeat?.forward && <text x={x0 + 3} y={CHORD_H + BAR_H - 1} className="co-repeat">‖:</text>}
                {b.repeat?.backward && <text x={x(fnum(b.onset) + fnum(b.length)) - 14} y={CHORD_H + BAR_H - 1} className="co-repeat">:‖</text>}
                {b.ending && b.ending.type === "start" && <text x={x0 + 22} y={CHORD_H + 13} className="co-ending">{b.ending.numbers}.</text>}
              </g>
            );
          })}

          {/* phrase boundaries */}
          {faint.map((c) => {
            const bx = x(fnum(line.notes[c.index + 1]!.onset));
            return <line key={`f${c.index}`} x1={bx} x2={bx} y1={CHORD_H + BAR_H} y2={densTop + DENS_H} className="co-bnd-faint" />;
          })}
          {boundaries.map((c) => {
            const bx = x(fnum(line.notes[c.index + 1]!.onset));
            return (
              <g key={`b${c.index}`} onClick={(e) => { e.stopPropagation(); onSelectBoundary(c.index); }} className="co-bnd-g">
                <line x1={bx} x2={bx} y1={CHORD_H + BAR_H} y2={densTop + DENS_H} className={`co-bnd${selectedBoundary === c.index ? " sel" : ""}`} style={{ strokeWidth: 1.5 + c.score * 2.5 }} data-boundary={c.index} />
                <rect x={bx - 5} y={CHORD_H + BAR_H} width={10} height={PHRASE_H} fill="transparent" />
              </g>
            );
          })}

          {/* piano roll: rests first, so notes sit on top */}
          {line.events.map((e) =>
            e.kind === "rest" ? (
              <g key={e.id}>
                <rect x={x(fnum(e.onset))} y={ROLL_TOP} width={Math.max(2, fnum(e.duration) * ppw - 1)} height={rollH} className={e.suspect ? "co-rest co-rest-pad" : "co-rest"} data-rest={e.id}>
                  <title>{e.suspect ? "suspected converter padding (the original does not write this rest)" : "written rest"} · {fstr(e.duration)}</title>
                </rect>
                <text x={x(fnum(e.onset)) + 3} y={ROLL_TOP + 11} className="co-rest-label">{e.suspect ? "pad" : "rest"}</text>
              </g>
            ) : null,
          )}
          {line.notes.map((n) => {
            const beats = fnum(n.duration) / fnum(line.bars[n.bar]!.beat);
            const cls = beats <= 0.5 + 1e-9 ? "short" : beats >= 1 - 1e-9 ? "long" : "mid";
            return (
              <rect
                key={n.id}
                x={x(fnum(n.onset))}
                y={y(n.midi) - ROW / 2 + 0.5}
                width={Math.max(3, fnum(n.duration) * ppw - 1)}
                height={ROW - 1}
                rx={2}
                className={`co-note co-${cls} w${n.weight}${selectedNote === n.id ? " selected" : ""}${highlight.has(n.id) ? " hl" : ""}${sounding.has(n.id) ? " now" : ""}`}
                data-note={n.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectNote(n.id);
                }}
              >
                <title>
                  {n.name ?? n.midi} · {fstr(n.onset)} + {fstr(n.duration)} · {round1(beats)} beat(s) · metric weight {n.weight}
                </title>
              </rect>
            );
          })}

          {/* attack density */}
          <text x={TL_LEFT} y={densTop - 3} className="co-lane-label">attacks per beat</text>
          {density.map((d, i) => (
            <g key={i}>
              <rect x={x(d.start) + 1} y={densTop + DENS_H - (d.n / maxDens) * (DENS_H - 4)} width={Math.max(1, d.len * ppw - 2)} height={(d.n / maxDens) * (DENS_H - 4)} className="co-dens" />
              {d.n > 0 && <text x={x(d.start) + d.len * ppw / 2} y={densTop + DENS_H - (d.n / maxDens) * (DENS_H - 4) - 2} className="co-dens-n" textAnchor="middle">{d.n}</text>}
            </g>
          ))}
        </svg>
        <div className="tl-playhead" ref={playheadRef} />
      </div>
    </div>
  );
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export default memo(TimelineView);
