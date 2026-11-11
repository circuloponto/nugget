"use client";

import { Repeat } from "lucide-react";
import { IC, IC_SM } from "../ui/icons";
import type { IRChordSegment } from "@musical-lab/engine";

interface Props {
  chords: readonly IRChordSegment[];
  activeIndex: number;
  /** The last chord leads back into the first (a closed loop). */
  closed: boolean;
  onSeek: (index: number) => void;
}

/** The harmonic progression: one block per chord segment of the document. The active one follows the playhead. */
export default function ProgressionStrip({ chords, activeIndex, closed, onSeek }: Props) {
  return (
    <nav className="prog" aria-label="Harmonic progression">
      {chords.map((c, i) => (
        <button
          key={c.id}
          className={i === activeIndex ? "prog-chip active" : "prog-chip"}
          onClick={() => onSeek(i)}
          title={`${c.symbol} · ${c.quality}${c.inversion ? ` · inversion ${c.inversion}` : ""}${c.voicing ? ` · ${c.voicing.map((v) => v.pitch.name).join(" ")}` : ""}`}
          aria-current={i === activeIndex ? "true" : undefined}
        >
          <small>{c.roman ?? ""}</small>
          <b>{c.symbol}</b>
          <i>{c.inversion ? `/${c.inversion}` : ""}</i>
        </button>
      ))}
      {closed && <span className="prog-loop" title="The last chord leads straight back into the first"><Repeat {...IC_SM} /></span>}
    </nav>
  );
}
