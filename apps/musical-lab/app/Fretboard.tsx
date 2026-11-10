"use client";

import { formatPitch, midiAt, spellMidiInScale, type Fretboard as Board, type Scale } from "@musical-lab/engine";

export type Role = "root" | "third" | "fifth";

export interface DisplayNote {
  string: number; // engine convention: 0 = lowest string
  fret: number;
  role: Role;
  label: string; // spelled pitch name (no octave)
  pitch: string; // spelled pitch with octave
}

const MARKERS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21]);

interface Props {
  board: Board;
  scale: Scale;
  frets: number; // highest fret to draw
  notes: DisplayNote[]; // the voicing being evaluated
  ghost?: DisplayNote[]; // previous chord, drawn as rings
  showScale: boolean;
}

/**
 * String × fret grid in the style of the triad_playground fretboard. The highest
 * string is drawn on top, as in a chord diagram; the engine's string 0 (lowest)
 * is the bottom row.
 */
export default function Fretboard({ board, scale, frets, notes, ghost = [], showScale }: Props) {
  const rows = [...board.tuning.strings.keys()].reverse(); // highest string first
  const cols = Array.from({ length: frets + 1 }, (_, i) => i);
  const at = (list: DisplayNote[], s: number, f: number) => list.find((n) => n.string === s && n.fret === f);

  return (
    <div className="board-scroll">
      <div className="board" role="img" aria-label="Guitar fretboard showing the current voicing">
        <div className="board-row board-numbers">
          <div className="string-label" />
          {cols.map((f) => (
            <div key={f} className="fret-number">{f}</div>
          ))}
        </div>
        {rows.map((s) => (
          <div className="board-row" key={s}>
            <div className="string-label">{formatPitch(board.tuning.strings[s]!).replace(/\d+$/, "")}</div>
            {cols.map((f) => {
              const hit = at(notes, s, f);
              const prev = at(ghost, s, f);
              const m = midiAt(board, s, f);
              const inScale = spellMidiInScale(scale, m);
              const cls = ["cell", f === 0 ? "open" : "", MARKERS.has(f) && s === 2 ? "marker" : ""];
              return (
                <div key={f} className={cls.join(" ")} title={`string ${board.tuning.strings.length - s}, fret ${f}`}>
                  <span className="wire" />
                  {prev && !hit && <span className={`dot ghost ${prev.role}`} title={`previous: ${prev.pitch}`} />}
                  {hit ? (
                    <span className={`dot ${hit.role}`} title={hit.pitch}>{hit.label}</span>
                  ) : (
                    showScale && inScale && <span className="scale-note">{inScale.letter}{accidental(inScale.accidental)}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div className="board-row board-numbers">
          <div className="string-label" />
          {cols.map((f) => (
            <div key={f} className="fret-number dim">{MARKERS.has(f) ? "•" : ""}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

const accidental = (a: number) => (a === 0 ? "" : (a > 0 ? "#" : "b").repeat(Math.abs(a)));
