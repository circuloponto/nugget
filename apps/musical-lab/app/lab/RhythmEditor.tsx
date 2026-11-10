"use client";

import {
  RHYTHM_GRIDS,
  RHYTHM_MODES,
  RHYTHM_PRESETS,
  resamplePattern,
  rotateSteps,
  stepsFromString,
  stepsToString,
  type RhythmMode,
  type RhythmSpec,
  type StepKind,
} from "@musical-lab/engine";

interface Props {
  rhythm: RhythmSpec;
  onChange: (next: RhythmSpec) => void;
}

const NEXT: Record<StepKind, StepKind> = { rest: "hit", hit: "accent", accent: "tie", tie: "rest" };
const GLYPH: Record<StepKind, string> = { rest: "·", hit: "●", accent: "▲", tie: "—" };
const LABEL: Record<StepKind, string> = { rest: "rest", hit: "hit", accent: "accent", tie: "tie (holds the previous note)" };

/**
 * An editable step grid. Each step of the bar cycles rest → hit → accent → tie. The bar can be
 * divided into 4, 6, 8, 12, 16 steps or into 5 or 7 (a quintuplet or septuplet against the bar).
 * All timing is the engine's: this only edits the pattern string.
 */
export default function RhythmEditor({ rhythm, onChange }: Props) {
  const steps = stepsFromString(rhythm.pattern);
  const set = (next: readonly StepKind[]) => onChange({ ...rhythm, pattern: stepsToString(next) });
  const hits = steps.filter((s) => s === "hit" || s === "accent").length;
  const gate = rhythm.gate ?? 1;
  const group = steps.length % 4 === 0 ? 4 : steps.length % 3 === 0 ? 3 : 0; // visual grouping of the buttons

  return (
    <section className="panel rhythm" aria-label="Rhythm editor">
      <h2>
        Rhythm <small>one bar of pattern, repeated on every chord</small>
      </h2>

      <div className="rhythm-top">
        <label>
          Preset
          <select
            value=""
            onChange={(e) => {
              const p = RHYTHM_PRESETS.find((x) => x.id === e.target.value);
              if (p) onChange({ ...rhythm, pattern: p.pattern });
              e.target.blur();
            }}
          >
            <option value="" disabled>
              choose…
            </option>
            {RHYTHM_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Divide the bar into
          <select
            value={steps.length}
            onChange={(e) => {
              set(resamplePattern(steps, Number(e.target.value)));
              e.target.blur();
            }}
          >
            {RHYTHM_GRIDS.map((g) => (
              <option key={g.grid} value={g.grid}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Spread over the voices
          <select
            value={rhythm.mode}
            onChange={(e) => {
              onChange({ ...rhythm, mode: e.target.value as RhythmMode });
              e.target.blur();
            }}
          >
            {RHYTHM_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.hint}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note length <b>{Math.round(gate * 100)}%</b>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={gate}
            onChange={(e) => onChange({ ...rhythm, gate: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="steps" role="group" aria-label="Steps of the bar" data-testid="steps">
        {steps.map((kind, i) => (
          <button
            key={i}
            className={`step step-${kind}${group && i % group === 0 ? " group-start" : ""}`}
            onClick={() => set(steps.map((k, j) => (j === i ? NEXT[k] : k)))}
            title={`step ${i + 1} of ${steps.length}: ${LABEL[kind]} (click to change)`}
            aria-label={`step ${i + 1}: ${LABEL[kind]}`}
          >
            {GLYPH[kind]}
          </button>
        ))}
      </div>

      <div className="rhythm-bottom">
        <button onClick={() => set(rotateSteps(steps, -1))} title="shift the pattern earlier by one step">
          ◀ rotate
        </button>
        <button onClick={() => set(rotateSteps(steps, 1))} title="shift the pattern later by one step">
          rotate ▶
        </button>
        <button onClick={() => set(steps.map(() => "rest"))}>clear</button>
        <span className="muted">
          <code data-testid="pattern">{rhythm.pattern}</code> · {hits} hit{hits === 1 ? "" : "s"} per chord · ● hit ▲ accent — tie · rest
        </span>
      </div>
    </section>
  );
}
