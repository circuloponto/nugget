"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildScale,
  CYCLE_IDS,
  cycleDrift,
  findTriadVoicings,
  formatNote,
  formatPitch,
  guitarStringNumber,
  INVERSION_NAMES,
  isSameNote,
  LETTERS,
  makeFretboard,
  planCycleOnGuitar,
  SCALE_TYPES,
  STANDARD_TUNING,
  validateVoicing,
  withDefaults,
  type DiatonicTriad,
  type GuitarNote,
  type Inversion,
  type Pitch,
  type ScaleType,
} from "@musical-lab/engine";
import Fretboard, { type DisplayNote, type Role } from "./Fretboard";

const TONICS = LETTERS.flatMap((l) => [l, `${l}b`, `${l}#`]);
const SCALE_LABEL: Record<ScaleType, string> = {
  major: "Major",
  naturalMinor: "Natural minor",
  harmonicMinor: "Harmonic minor",
};

type FoldPolicy = "sweep" | "whole-voicing" | "none";

/** One chord ready to show: abstract theory + the guitar realization of it. */
interface Frame {
  title: string;
  triad: DiatonicTriad;
  inversion: Inversion;
  pitches: readonly Pitch[];
  guitar: readonly GuitarNote[];
  span: number;
  fingers: number;
  octaveShift?: number;
  /** The run wrapped to the other end of the neck at this chord. */
  wrapped?: boolean;
  cost?: number;
}

const roleOf = (triad: DiatonicTriad, p: Pitch): Role =>
  isSameNote(p, triad.root) ? "root" : isSameNote(p, triad.third) ? "third" : "fifth";

const toDisplay = (f: Frame): DisplayNote[] =>
  f.guitar.map((n) => ({
    string: n.string,
    fret: n.fret,
    role: roleOf(f.triad, n.pitch),
    label: formatNote(n.pitch),
    pitch: formatPitch(n.pitch),
  }));

export default function Lab() {
  const [tonic, setTonic] = useState("C");
  const [scaleType, setScaleType] = useState<ScaleType>("major");
  const [mode, setMode] = useState<"cycle" | "voicings">("cycle");
  const [cycle, setCycle] = useState(5);
  const [degree, setDegree] = useState(1);
  const [inversion, setInversion] = useState<Inversion>(0);
  const [length, setLength] = useState(30);
  const [maxFretSpan, setMaxFretSpan] = useState(4);
  const [maxFret, setMaxFret] = useState(17);
  const [fold, setFold] = useState<FoldPolicy>("sweep");
  const [anchor, setAnchor] = useState<number | "">("");
  const [showScale, setShowScale] = useState(true);
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(0);

  const board = useMemo(() => makeFretboard(STANDARD_TUNING, 22), []);
  const scale = useMemo(() => buildScale(tonic, scaleType), [tonic, scaleType]);
  const constraints = useMemo(() => withDefaults({ maxFretSpan, maxFret }), [maxFretSpan, maxFret]);
  // In sweep mode the cycle just keeps going (and wraps when out of room), so the
  // "last chord returns to the first" loop does not apply.
  const looping = loop && fold !== "sweep";

  const result = useMemo(() => {
    if (mode === "voicings") {
      const found = findTriadVoicings(scale, degree, inversion, board, constraints);
      const frames: Frame[] = found.map((f, i) => ({
        title: `Voicing ${i + 1}`,
        triad: f.voicing.triad,
        inversion: f.voicing.inversion,
        pitches: f.voicing.pitches,
        guitar: f.guitar.notes,
        span: f.guitar.span,
        fingers: f.guitar.fingers,
      }));
      return {
        frames,
        error: frames.length === 0 ? "No playable voicing under these limits." : null,
        theory: [] as DiatonicTriad[],
        cost: null as number | null,
        closing: null as number | null,
      };
    }
    const plan = planCycleOnGuitar(scale, cycle, board, {
      startDegree: degree,
      inversion,
      length,
      octaveShift: fold,
      anchorFret: anchor === "" ? undefined : anchor,
      loop: looping,
      constraints: { maxFretSpan, maxFret },
    });
    const theory = plan.cycle.map((s) => s.triad);
    if (!plan.path.ok) return { frames: [] as Frame[], error: plan.path.reason, theory, cost: null, closing: null };
    const frames: Frame[] = plan.path.steps.map((s) => ({
      title: `Step ${s.index + 1}`,
      triad: s.voicing.triad,
      inversion: s.voicing.inversion,
      pitches: s.voicing.pitches,
      guitar: s.guitar.notes,
      span: s.guitar.span,
      fingers: s.guitar.fingers,
      octaveShift: s.octaveShift,
      wrapped: s.wrapped,
      cost: s.costFromPrevious,
    }));
    return { frames, error: null, theory, cost: plan.path.totalCost, closing: plan.path.closingCost ?? null };
  }, [mode, scale, cycle, degree, inversion, length, fold, anchor, looping, maxFretSpan, maxFret, board, constraints]);

  const frames = result.frames;
  const idx = Math.min(step, Math.max(0, frames.length - 1));
  const frame = frames[idx];
  const wraps = mode === "cycle" && looping && frames.length > 1;
  const wrapCount = frames.filter((f) => f.wrapped).length;
  const descending = cycleDrift(cycle) < 0;
  // the chord we just came from: the previous step, or the last one when wrapping
  const prev = mode === "cycle" ? (idx > 0 ? frames[idx - 1] : wraps ? frames[frames.length - 1] : undefined) : undefined;

  /** Step forward/back; in a loop the last chord continues to the first and vice versa. */
  const move = (dir: 1 | -1) =>
    setStep((s) => {
      const n = frames.length;
      const next = s + dir;
      if (next >= 0 && next < n) return next;
      return wraps ? (next + n) % n : s;
    });

  useEffect(() => setStep(0), [mode, tonic, scaleType, cycle, degree, inversion, length]);

  // Auto-play: advance every ~1.1s; wraps when looping, otherwise stops on the last chord.
  useEffect(() => {
    if (!playing || mode !== "cycle" || frames.length < 2) return;
    const t = setTimeout(() => {
      if (idx + 1 < frames.length) setStep(idx + 1);
      else if (wraps) setStep(0);
      else setPlaying(false);
    }, 1100);
    return () => clearTimeout(t);
  }, [playing, mode, idx, frames.length, wraps]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "SELECT" || tag === "INPUT") return;
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames.length, wraps]);

  const violations = frame ? validateVoicing(frame.guitar, board, constraints, frame.pitches) : [];
  const tab = frame
    ? [...board.tuning.strings.keys()]
        .map((s) => frame.guitar.find((n) => n.string === s)?.fret ?? "x")
        .join(" ")
    : "";

  return (
    <main className="lab">
      <header>
        <h1>Musical Lab <span>engine evaluator</span></h1>
        <p>
          Every note on this page comes from <code>@musical-lab/engine</code> running in your browser. Use ← → to step.
        </p>
      </header>

      {/* After a dropdown changes, hand focus back to the page: otherwise ← → keep
          editing the dropdown (changing the cycle and resetting to chord 1). */}
      <section
        className="panel controls"
        aria-label="Controls"
        onChange={(e) => {
          if (e.target instanceof HTMLSelectElement) e.target.blur();
        }}
      >
        <label>Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as "cycle" | "voicings")}>
            <option value="cycle">Cycle (voice-led path)</option>
            <option value="voicings">All voicings of one triad</option>
          </select>
        </label>
        <label>Key
          <select value={tonic} onChange={(e) => setTonic(e.target.value)}>
            {TONICS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Scale
          <select value={scaleType} onChange={(e) => setScaleType(e.target.value as ScaleType)}>
            {SCALE_TYPES.map((t) => <option key={t} value={t}>{SCALE_LABEL[t]}</option>)}
          </select>
        </label>
        {mode === "cycle" && (
          <label>Cycle
            <select value={cycle} onChange={(e) => setCycle(Number(e.target.value))}>
              {CYCLE_IDS.map((c) => <option key={c} value={c}>Cycle {c} (root up {c - 1})</option>)}
            </select>
          </label>
        )}
        <label>{mode === "cycle" ? "Start on degree" : "Triad on degree"}
          <select value={degree} onChange={(e) => setDegree(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d}>{d}</option>)}
          </select>
        </label>
        <label>Inversion
          <select value={inversion} onChange={(e) => setInversion(Number(e.target.value) as Inversion)}>
            {INVERSION_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </label>
        {mode === "cycle" && (
          <>
            <label>Chords
              <input type="number" min={1} max={90} value={length} onChange={(e) => setLength(clamp(Number(e.target.value), 1, 90))} />
            </label>
            <label>Across the neck
              <select value={fold} onChange={(e) => setFold(e.target.value as FoldPolicy)}>
                <option value="sweep">Run the neck, wrap when out of room</option>
                <option value="whole-voicing">Fold each chord to fit (smoothest)</option>
                <option value="none">Exact pitches, no wrap (may fail)</option>
              </select>
            </label>
            <label>Start near fret
              <input type="number" min={0} max={22} placeholder="any" value={anchor}
                onChange={(e) => setAnchor(e.target.value === "" ? "" : clamp(Number(e.target.value), 0, 22))} />
            </label>
          </>
        )}
        <label>Max stretch (frets)
          <input type="number" min={0} max={6} value={maxFretSpan} onChange={(e) => setMaxFretSpan(clamp(Number(e.target.value), 0, 6))} />
        </label>
        <label>Highest fret
          <input type="number" min={5} max={22} value={maxFret} onChange={(e) => setMaxFret(clamp(Number(e.target.value), 5, 22))} />
        </label>
        {mode === "cycle" && fold !== "sweep" && (
          <label className="check">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop: last chord continues to the first
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={showScale} onChange={(e) => setShowScale(e.target.checked)} /> Show scale notes
        </label>
      </section>

      <section className="panel scale-line">
        <strong>{formatNote(scale.tonic)} {SCALE_LABEL[scale.type].toLowerCase()}:</strong>{" "}
        {scale.notes.map(formatNote).join("  ")}
      </section>

      {result.error && <div className="panel error" role="alert">{result.error}</div>}

      {mode === "cycle" && result.theory.length > 0 && (
        <nav className="strip" aria-label="Chords in the cycle">
          {result.theory.map((t, i) => {
            const f = frames[i];
            return (
              <button
                key={i}
                className={["chip", i === idx && f ? "active" : "", f?.wrapped ? "wrapped" : ""].join(" ").trim()}
                disabled={!f}
                onClick={() => setStep(i)}
                title={f?.wrapped ? `wrapped to the ${descending ? "top" : "bottom"} of the neck here` : `chord ${i + 1}`}
              >
                <b>{t.roman}</b>
                <span>{t.symbol}</span>
                {f?.wrapped ? <em>⟲</em> : null}
              </button>
            );
          })}
          {wraps && <span className="wrap-note" title="the circuit repeats">↻ back to {result.theory[0]!.roman}</span>}
        </nav>
      )}

      {mode === "cycle" && frames.length > 0 && fold === "sweep" && (
        <p className="hint">
          Cycle {cycle} {descending ? "descends" : "ascends"}: it runs {descending ? "down toward the lowest strings" : "up toward the highest strings and frets"},
          and when a chord has no room left it wraps to the {descending ? "top (high frets and strings)" : "bottom (low strings)"} and keeps going.
          {" "}{wrapCount === 0 ? "No wrap in these chords. Raise “Chords” to see one." : `${wrapCount} wrap${wrapCount > 1 ? "s" : ""} in ${frames.length} chords (⟲).`}
        </p>
      )}

      {mode === "cycle" && frames.length > 1 && (
        <div className="nav">
          <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button onClick={() => move(-1)} disabled={!wraps && idx === 0} aria-label="Previous chord">← Prev</button>
          <button
            onClick={() => move(1)}
            disabled={!wraps && idx === frames.length - 1}
            title={!wraps && idx === frames.length - 1 ? "Last chord. Turn on Loop to continue to the first." : undefined}
            aria-label="Next chord"
          >
            Next →
          </button>
          <span>
            Chord {idx + 1} of {frames.length}
            {frame?.wrapped && <span className="badge">⟲ wrapped to the {descending ? "top" : "bottom"} of the neck</span>}
            {wraps && idx === frames.length - 1 && <span className="badge">next wraps to chord 1</span>}
            {wraps && idx === 0 && <span className="badge">arrived by wrapping from chord {frames.length}</span>}
          </span>
        </div>
      )}

      {mode === "voicings" && frames.length > 0 && (
        <div className="panel slider">
          <button onClick={() => setStep(Math.max(0, idx - 1))}>←</button>
          <input type="range" min={0} max={frames.length - 1} value={idx} onChange={(e) => setStep(Number(e.target.value))} />
          <button onClick={() => setStep(Math.min(frames.length - 1, idx + 1))}>→</button>
          <span>{idx + 1} / {frames.length}</span>
        </div>
      )}

      {frame && (
        <>
          <section className="panel">
            <Fretboard
              board={board}
              scale={scale}
              frets={maxFret}
              notes={toDisplay(frame)}
              ghost={prev ? toDisplay(prev) : []}
              showScale={showScale}
            />
            <div className="legend">
              <span><i className="dot root" /> root</span>
              <span><i className="dot third" /> third</span>
              <span><i className="dot fifth" /> fifth</span>
              {prev && <span><i className="dot ghost root" /> previous chord</span>}
            </div>
          </section>

          <section className="panel details">
            <div>
              <h2>{frame.triad.symbol} <small>{frame.triad.roman}</small></h2>
              <dl>
                <dt>Quality</dt><dd>{frame.triad.quality}</dd>
                <dt>Chord tones</dt><dd>{frame.triad.notes.map(formatNote).join(" – ")}</dd>
                <dt>Inversion</dt><dd>{INVERSION_NAMES[frame.inversion]}</dd>
                <dt>Sounding</dt><dd>{frame.pitches.map(formatPitch).join("  ")} <small>(bass → top)</small></dd>
              </dl>
            </div>
            <div>
              <h2>On the neck</h2>
              <dl>
                <dt>Strings:frets</dt>
                <dd>{frame.guitar.map((n) => `${guitarStringNumber(board, n.string)}:${n.fret}`).join("  ")}</dd>
                <dt>Tab (6→1)</dt><dd><code>{tab}</code></dd>
                <dt>Stretch / fingers</dt><dd>{frame.span} frets / {frame.fingers}</dd>
                {frame.octaveShift !== undefined && (
                  <>
                    <dt>Octave shift</dt>
                    <dd>{frame.octaveShift === 0 ? "none (theoretical pitch)" : `${frame.octaveShift > 0 ? "+" : ""}${frame.octaveShift} octave(s) from theory`}</dd>
                  </>
                )}
                {frame.cost !== undefined && idx > 0 && <><dt>Cost from previous</dt><dd>{frame.cost.toFixed(1)}</dd></>}
                {wraps && idx === 0 && result.closing !== null && (
                  <><dt>Cost from last chord (wrap)</dt><dd>{result.closing.toFixed(1)}</dd></>
                )}
              </dl>
            </div>
            <div>
              <h2>Engine verdict</h2>
              {violations.length === 0 ? (
                <p className="ok">✓ physically valid, exact pitches, within limits</p>
              ) : (
                <ul className="bad">{violations.map((v, i) => <li key={i}><b>{v.code}</b> {v.message}</li>)}</ul>
              )}
              {mode === "cycle" && result.cost !== null && (
                <p className="muted">Whole {wraps ? "loop" : "path"} cost: {result.cost.toFixed(1)}</p>
              )}
            </div>
          </section>

          {mode === "cycle" && (
            <section className="panel">
              <h2>All steps</h2>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>#</th><th>Chord</th><th>Inv.</th><th>Sounding</th><th>Tab 6→1</th><th>Shift</th><th>Cost</th></tr></thead>
                  <tbody>
                    {frames.map((f, i) => (
                      <tr key={i} className={i === idx ? "sel" : ""} onClick={() => setStep(i)}>
                        <td>{i + 1}</td>
                        <td>{f.triad.roman} {f.triad.symbol}</td>
                        <td>{f.inversion}</td>
                        <td>{f.pitches.map(formatPitch).join(" ")}</td>
                        <td><code>{[...board.tuning.strings.keys()].map((s) => f.guitar.find((n) => n.string === s)?.fret ?? "x").join(" ")}</code></td>
                        <td>{f.wrapped ? "⟲ wrap" : f.octaveShift ? (f.octaveShift > 0 ? `+${f.octaveShift}` : f.octaveShift) : "–"}</td>
                        <td>{i === 0 ? "–" : f.cost?.toFixed(1)}</td>
                      </tr>
                    ))}
                    {wraps && result.closing !== null && (
                      <tr className="wrap-row" onClick={() => setStep(0)}>
                        <td>↻</td>
                        <td colSpan={5}>then back to chord 1 (string-set change / octave fold happens here if needed)</td>
                        <td>{result.closing.toFixed(1)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
