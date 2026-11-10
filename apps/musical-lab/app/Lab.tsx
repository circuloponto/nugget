"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildScale,
  CYCLE_IDS,
  cyclePlanToIR,
  cycleDrift,
  findTriadVoicings,
  formatNote,
  formatPitch,
  frac,
  guitarStringNumber,
  INVERSION_NAMES,
  isSameNote,
  LETTERS,
  makeFretboard,
  PLUCK_TONES,
  planCycleOnGuitar,
  planPerfectCycleLoop,
  SCALE_TYPES,
  serializeMusicIR,
  STANDARD_TUNING,
  toSeconds,
  validateMusicIR,
  validateVoicing,
  withDefaults,
  type DiatonicTriad,
  type GuitarNote,
  type Inversion,
  type MusicIR,
  type Pitch,
  type ScaleType,
} from "@musical-lab/engine";
import { ensureAudio, playChord, type PluckOptions, type PluckTone } from "./audio";
import Fretboard, { type DisplayNote, type Role } from "./Fretboard";

const TONICS = LETTERS.flatMap((l) => [l, `${l}b`, `${l}#`]);
const SCALE_LABEL: Record<ScaleType, string> = {
  major: "Major",
  naturalMinor: "Natural minor",
  harmonicMinor: "Harmonic minor",
};

type FoldPolicy = "sweep" | "whole-voicing" | "none";

/** The four dials of the Sine sound, starting at the engine's own preset. */
interface Shape {
  ringSeconds: number;
  attackSeconds: number;
  brightness: number;
  lowEnd: number;
}
const SINE_SHAPE: Shape = {
  ringSeconds: PLUCK_TONES.sine.ringSeconds,
  attackSeconds: PLUCK_TONES.sine.attackSeconds,
  brightness: PLUCK_TONES.sine.brightness,
  lowEnd: PLUCK_TONES.sine.lowEnd,
};

/** Facts about a perfect loop, shown to the user. */
interface LoopInfo {
  laps: number;
  length: number;
  wraps: number;
  restartJump: number;
}

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
  const [sound, setSound] = useState(true);
  const [tone, setTone] = useState<PluckTone>("sine");
  const [shape, setShape] = useState<Shape>(SINE_SHAPE);
  const [bpm, setBpm] = useState(72);
  const [heard, setHeard] = useState("");
  const [step, setStep] = useState(0);

  const board = useMemo(() => makeFretboard(STANDARD_TUNING, 22), []);
  const scale = useMemo(() => buildScale(tonic, scaleType), [tonic, scaleType]);
  const constraints = useMemo(() => withDefaults({ maxFretSpan, maxFret }), [maxFretSpan, maxFret]);
  // Sweep is a perfect loop by construction: the last chord always hands back to the first.
  const looping = fold === "sweep" || loop;

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
        info: null as LoopInfo | null,
        ir: null as MusicIR | null,
      };
    }
    const anchorFret = anchor === "" ? undefined : anchor;
    const loopPlan =
      fold === "sweep"
        ? planPerfectCycleLoop(scale, cycle, board, {
            startDegree: degree,
            inversion,
            anchorFret,
            constraints: { maxFretSpan, maxFret },
          })
        : null;
    const plan =
      loopPlan ??
      planCycleOnGuitar(scale, cycle, board, {
        startDegree: degree,
        inversion,
        length,
        octaveShift: fold,
        anchorFret,
        loop,
        constraints: { maxFretSpan, maxFret },
      });
    const info: LoopInfo | null = loopPlan
      ? {
          laps: loopPlan.laps,
          length: loopPlan.length,
          wraps: loopPlan.wraps,
          restartJump: loopPlan.restartJumpOctaves,
        }
      : null;
    const theory = plan.cycle.map((s) => s.triad);
    if (!plan.path.ok) {
      return { frames: [] as Frame[], error: plan.path.reason, theory, cost: null, closing: null, info, ir: null };
    }
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
    // the same plan as a MusicIR document (exact times, voice leading, constraints, provenance)
    const ir = cyclePlanToIR(scale, cycle, plan, { constraints, tuning: STANDARD_TUNING, tempo: { bpm } });
    return { frames, error: null, theory, cost: plan.path.totalCost, closing: plan.path.closingCost ?? null, info, ir };
  }, [mode, scale, cycle, degree, inversion, length, fold, anchor, loop, maxFretSpan, maxFret, board, constraints, bpm]);

  const irIssues = useMemo(() => (result.ir ? validateMusicIR(result.ir) : []), [result.ir]);

  const frames = result.frames;
  const idx = Math.min(step, Math.max(0, frames.length - 1));
  const frame = frames[idx];
  const wraps = mode === "cycle" && looping && frames.length > 1;
  const wrapCount = frames.filter((f) => f.wrapped).length;
  const descending = cycleDrift(cycle) < 0;
  // the chord we just came from: the previous step, or the last one when wrapping
  const prev = mode === "cycle" ? (idx > 0 ? frames[idx - 1] : wraps ? frames[frames.length - 1] : undefined) : undefined;

  /** Strum a chord (the notes' MIDI numbers, bass first) if sound is on. */
  const hear = (f: Frame | undefined) => {
    if (!sound || !f) return;
    if (playChord(f.guitar.map((n) => n.midi), tone, tone === "sine" ? shape : undefined)) setHeard(f.pitches.map(formatPitch).join("  "));
  };

  /** Jump to a chord and let it sound. */
  const go = (i: number) => {
    setStep(i);
    hear(frames[i]);
  };

  /** Step forward/back; in a loop the last chord continues to the first and vice versa. */
  const move = (dir: 1 | -1) => {
    const n = frames.length;
    if (n === 0) return;
    const next = idx + dir;
    const target = next >= 0 && next < n ? next : wraps ? (next + n) % n : idx;
    if (target !== idx) go(target);
  };

  useEffect(() => setStep(0), [mode, tonic, scaleType, cycle, degree, inversion, length]);

  // One chord = one beat. Its length in real time comes from the temporal engine, not a constant.
  const chordSeconds = toSeconds(frac(1, 4), bpm);

  // Auto-play: sound each chord as it comes up, then advance after one beat. Wraps when looping,
  // otherwise stops on the last chord.
  useEffect(() => {
    if (!playing || mode !== "cycle" || frames.length < 2) return;
    hear(frames[idx]);
    const t = setTimeout(() => {
      if (idx + 1 < frames.length) setStep(idx + 1);
      else if (wraps) setStep(0);
      else setPlaying(false);
    }, chordSeconds * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, mode, idx, frames, wraps, chordSeconds]);

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
  }, [frames, idx, wraps, sound]);

  /** Download the current plan as a MusicIR JSON document. */
  const exportIR = () => {
    if (!result.ir) return;
    const blob = new Blob([serializeMusicIR(result.ir)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `musicir-${tonic}-${scaleType}-cycle${cycle}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
            {fold !== "sweep" && (
              <label>Chords
                <input type="number" min={1} max={90} value={length} onChange={(e) => setLength(clamp(Number(e.target.value), 1, 90))} />
              </label>
            )}
            <label>Across the neck
              <select value={fold} onChange={(e) => setFold(e.target.value as FoldPolicy)}>
                <option value="sweep">Perfect loop (runs the neck, restarts)</option>
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
        <label className="check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
        </label>
        <label>Tone
          <select
            value={tone}
            onChange={(e) => {
              setTone(e.target.value as PluckTone);
              // let the new tone be heard right away, with the chord on screen
              const next = e.target.value as PluckTone;
              if (sound && frame) playChord(frame.guitar.map((n) => n.midi), next, next === "sine" ? shape : undefined);
            }}
          >
            <option value="sine">Sine (almost a plucked sine wave)</option>
            <option value="soft">Soft string (round, short)</option>
            <option value="mellow">Mellow string</option>
            <option value="bright">Bright string (the original)</option>
          </select>
        </label>
        {mode === "cycle" && (
          <label>Tempo (BPM, 1 chord = 1 beat)
            <input type="number" min={20} max={240} value={bpm} onChange={(e) => setBpm(clamp(Number(e.target.value), 20, 240))} />
          </label>
        )}
      </section>

      {tone === "sine" && (
        <section className="panel shaping" aria-label="Shape the sine sound">
          <h2>Shape the sound <small>move a slider and the current chord replays</small></h2>
          <div className="sliders">
            {(
              [
                { key: "ringSeconds", label: "Ring (resonance)", hint: "seconds to fade out; lower = shorter", min: 0.3, max: 3, step: 0.05, show: (v: number) => `${v.toFixed(2)} s` },
                { key: "attackSeconds", label: "Attack (pluck)", hint: "fade-in; higher = softer start", min: 0.002, max: 0.04, step: 0.001, show: (v: number) => `${Math.round(v * 1000)} ms` },
                { key: "brightness", label: "Brightness", hint: "upper partials; 0 = pure sine", min: 0, max: 0.6, step: 0.01, show: (v: number) => v.toFixed(2) },
                { key: "lowEnd", label: "Low-end definition", hint: "clearer low notes; 0 = off", min: 0, max: 1, step: 0.05, show: (v: number) => v.toFixed(2) },
              ] as const
            ).map((d) => (
              <label key={d.key} className="slider-row">
                <span>
                  {d.label} <b>{d.show(shape[d.key])}</b>
                </span>
                <input
                  type="range"
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  value={shape[d.key]}
                  onChange={(e) => {
                    const next: Shape = { ...shape, [d.key]: Number(e.target.value) };
                    setShape(next);
                    if (sound && frame) playChord(frame.guitar.map((n) => n.midi), "sine", next as PluckOptions);
                  }}
                />
                <em>{d.hint}</em>
              </label>
            ))}
          </div>
          <button className="export" onClick={() => setShape(SINE_SHAPE)}>Reset to default</button>
        </section>
      )}

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
                onClick={() => go(i)}
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

      {mode === "cycle" && frames.length > 0 && fold === "sweep" && result.info && (
        <p className="hint">
          <b>Perfect loop · {result.info.length} chords, {result.info.wraps} wrap{result.info.wraps === 1 ? "" : "s"} (⟲)</b>
          {" "}Cycle {cycle} {descending ? "descends" : "ascends"}: it runs {descending ? "down from the high strings and frets toward the lowest strings" : "up from the low strings toward the highest strings and frets"},
          changing string sets as it goes. When the next triad has no room left it wraps back to the {descending ? "top" : "bottom"} and
          carries on with the next triad of the cycle. After chord {result.info.length} the next triad is the first one again, in the same place,
          so the loop closes and repeats forever.
        </p>
      )}

      {mode === "cycle" && frames.length > 1 && (
        <div className="nav">
          <button
            onClick={() => {
              if (!playing && sound) ensureAudio(); // browsers only allow sound after a click
              setPlaying((p) => !p);
            }}
            aria-label={playing ? "Pause" : "Play"}
          >
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
          <button onClick={() => hear(frame)} disabled={!sound} aria-label="Hear this chord again">🔊 Hear</button>
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
          <button onClick={() => go(Math.max(0, idx - 1))}>←</button>
          <input type="range" min={0} max={frames.length - 1} value={idx} onChange={(e) => go(Number(e.target.value))} />
          <button onClick={() => go(Math.min(frames.length - 1, idx + 1))}>→</button>
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
                <p className="ok">✓ valid under the configured constraints, with exact pitches</p>
              ) : (
                <ul className="bad">{violations.map((v, i) => <li key={i}><b>{v.code}</b> {v.message}</li>)}</ul>
              )}
              <p className="muted">
                An approximation: it checks string order, fret stretch, exact pitches and an estimated finger count.
                It does not guarantee a shape is comfortable to play.
              </p>
              {mode === "cycle" && result.cost !== null && (
                <p className="muted">Whole {wraps ? "loop" : "path"} cost: {result.cost.toFixed(1)}</p>
              )}
              {sound && heard && <p className="muted" data-testid="heard">🔊 last heard: {heard}</p>}
              {result.ir && (
                <>
                  {irIssues.length === 0 ? (
                    <p className="ok" data-testid="ir-status">
                      ✓ MusicIR valid · {result.ir.chords.length} chords, {result.ir.events.length} notes
                    </p>
                  ) : (
                    <p className="bad" data-testid="ir-status">✗ MusicIR has {irIssues.length} problem(s): {irIssues[0]!.message}</p>
                  )}
                  <button className="export" onClick={exportIR}>⬇ Export MusicIR (JSON)</button>
                </>
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
                      <tr key={i} className={i === idx ? "sel" : ""} onClick={() => go(i)}>
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
                      <tr className="wrap-row" onClick={() => go(0)}>
                        <td>↻</td>
                        <td colSpan={5}>
                          then back to chord 1{fold === "sweep" ? " (the next triad of the cycle is the first one again, in the same place: loop repeats)" : " (string-set change / octave fold happens here if needed)"}
                        </td>
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
