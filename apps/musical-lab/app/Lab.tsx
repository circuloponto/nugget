"use client";

import { Download, SkipBack, Pause, Play, SkipForward, Music2, SlidersHorizontal, Info, ArrowLeft, ArrowRight, Repeat, Check, X, Volume2 } from "lucide-react";
import { IC, IC_SM } from "./ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import Modal from "./ui/Modal";
import Tabs from "./ui/Tabs";
import { Topbar } from "./ui/shellContext";
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

export default function Lab({ active = true }: { active?: boolean }) {
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
  const [rtab, setRtab] = useState<"chord" | "neck" | "verdict" | "steps">("chord");
  const [modal, setModal] = useState<null | "more" | "loop">(null);
  const closeModal = useCallback(() => setModal(null), []);

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
    if (!active || !playing || mode !== "cycle" || frames.length < 2) return;
    hear(frames[idx]);
    const t = setTimeout(() => {
      if (idx + 1 < frames.length) setStep(idx + 1);
      else if (wraps) setStep(0);
      else setPlaying(false);
    }, chordSeconds * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playing, mode, idx, frames, wraps, chordSeconds]);

  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "SELECT" || tag === "INPUT") return;
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, frames, idx, wraps, sound]);

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
    <div className="wb ev">
      <Topbar active={active}>
        {mode === "cycle" && frames.length > 1 ? (
          <>
            <button className="tool-btn" onClick={() => move(-1)} disabled={!wraps && idx === 0} aria-label="Previous chord" title="Previous chord (←)">
              <SkipBack {...IC} />
            </button>
            <button
              className="tool-btn primary"
              onClick={() => {
                if (!playing && sound) ensureAudio(); // browsers only allow sound after a click
                setPlaying((p) => !p);
              }}
              aria-label={playing ? "Pause" : "Play"}
              data-testid="ev-play"
            >
              {playing ? <Pause {...IC} /> : <Play {...IC} />}
            </button>
            <button className="tool-btn" onClick={() => move(1)} disabled={!wraps && idx === frames.length - 1} aria-label="Next chord" title="Next chord (→)">
              <SkipForward {...IC} />
            </button>
            <span className="pill" title="One chord is one beat">
              <Music2 {...IC} />
              <input type="number" min={20} max={240} value={bpm} onChange={(e) => setBpm(clamp(Number(e.target.value), 20, 240))} aria-label="Tempo" />
            </span>
            <span className="pill pill-opt">
              Chord {idx + 1} of {frames.length}
            </span>
          </>
        ) : null}
        <button className="tool-btn" onClick={() => hear(frame)} disabled={!sound || !frame} aria-label="Hear this chord again" title="Hear this chord again">
          <Volume2 {...IC} />
          <span className="lbl">Hear</span>
        </button>
        <button className="tool-btn" onClick={exportIR} disabled={!result.ir} title="Export the plan as a MusicIR document" data-testid="ev-export">
          <Download {...IC} />
          <span className="lbl">Export</span>
        </button>
        <button className="tool-btn" onClick={() => setModal("more")} aria-label="View settings" title="Fretboard, playback and sound options" data-testid="ev-more">
          <SlidersHorizontal {...IC} />
        </button>
      </Topbar>

      {/* After a dropdown changes, hand focus back to the page: otherwise ← → keep
          editing the dropdown (changing the cycle and resetting to chord 1). */}
      <section
        className="ev-controls"
        aria-label="Controls"
        onChange={(e) => {
          if (e.target instanceof HTMLSelectElement) e.target.blur();
        }}
      >
        <label className="field">
          <span>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as "cycle" | "voicings")}>
            <option value="cycle">Cycle (voice-led path)</option>
            <option value="voicings">All voicings of one triad</option>
          </select>
        </label>
        <label className="field">
          <span>Key</span>
          <select value={tonic} onChange={(e) => setTonic(e.target.value)}>
            {TONICS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scale</span>
          <select value={scaleType} onChange={(e) => setScaleType(e.target.value as ScaleType)}>
            {SCALE_TYPES.map((t) => (
              <option key={t} value={t}>
                {SCALE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {mode === "cycle" && (
          <label className="field">
            <span>Cycle</span>
            <select value={cycle} onChange={(e) => setCycle(Number(e.target.value))}>
              {CYCLE_IDS.map((c) => (
                <option key={c} value={c}>
                  Cycle {c} (root up {c - 1})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{mode === "cycle" ? "Start on degree" : "Triad on degree"}</span>
          <select value={degree} onChange={(e) => setDegree(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Inversion</span>
          <select value={inversion} onChange={(e) => setInversion(Number(e.target.value) as Inversion)}>
            {INVERSION_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="wb-chords ev-chords" aria-label="Chords">
        <span className="label">Chords</span>
        <div className="chord-row ev-strip">
          {mode === "cycle" && result.theory.length > 0 ? (
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
                    {f?.wrapped ? <em><Repeat {...IC_SM} /></em> : null}
                  </button>
                );
              })}
              {wraps && <span className="wrap-note" title="the circuit repeats"><Repeat {...IC_SM} /> back to {result.theory[0]!.roman}</span>}
            </nav>
          ) : mode === "voicings" && frames.length > 0 ? (
            <div className="slider ev-slider">
              <button className="btn small" onClick={() => go(Math.max(0, idx - 1))}><ArrowLeft {...IC} /></button>
              <input type="range" min={0} max={frames.length - 1} value={idx} onChange={(e) => go(Number(e.target.value))} aria-label="Voicing" />
              <button className="btn small" onClick={() => go(Math.min(frames.length - 1, idx + 1))}><ArrowRight {...IC} /></button>
              <span>{idx + 1} / {frames.length}</span>
            </div>
          ) : (
            <span className="hint">no chords</span>
          )}
        </div>
        <div className="wb-chords-right">
          {mode === "cycle" && frames.length > 0 && fold === "sweep" && result.info && (
            <button className="icon-btn" onClick={() => setModal("loop")} aria-label="About this loop" title="About this loop" data-testid="ev-loop-info">
              <Info {...IC} />
            </button>
          )}
          {frame?.wrapped && <span className="badge"><Repeat {...IC_SM} /> wrapped to the {descending ? "top" : "bottom"}</span>}
        </div>
      </section>

      <div className="wb-messages">
        {result.error && (
          <div className="banner error" role="alert">
            {result.error}
          </div>
        )}
      </div>

      {frame ? (
        <div className="wb-main ev-main">
          <section className="card wb-left" aria-label="Fretboard">
            <div className="wb-left-head">
              <strong>
                {formatNote(scale.tonic)} {SCALE_LABEL[scale.type].toLowerCase()}:
              </strong>
              <span className="muted">{scale.notes.map(formatNote).join("  ")}</span>
            </div>
            <div className="wb-stage">
              <div className="stage-pane board" style={{ flex: "1 1 100%" }}>
                <Fretboard board={board} scale={scale} frets={22} notes={toDisplay(frame)} ghost={prev ? toDisplay(prev) : []} showScale={showScale} />
              </div>
            </div>
            <div className="legend-inline">
              <i className="dot root" /> root <i className="dot third" /> third <i className="dot fifth" /> fifth {prev && (
                <>
                  <i className="dot ghost root" /> previous chord
                </>
              )}
            </div>
          </section>

          <aside className="card wb-right ev-right" aria-label="Details">
            <Tabs
              label="Details"
              value={rtab}
              onChange={setRtab}
              tabs={[
                { id: "chord", label: "Chord", testId: "ev-tab-chord" },
                { id: "neck", label: "On the neck", testId: "ev-tab-neck" },
                { id: "verdict", label: "Verdict", testId: "ev-tab-verdict" },
                ...(mode === "cycle" ? [{ id: "steps" as const, label: "All steps", testId: "ev-tab-steps" }] : []),
              ]}
            />
            <div className="scroll-y ev-right-body">
              {rtab === "chord" && (
                <div>
                  <h2 className="co2-h">
                    {frame.triad.symbol} <small className="muted">{frame.triad.roman}</small>
                  </h2>
                  <dl>
                    <dt>Quality</dt><dd>{frame.triad.quality}</dd>
                    <dt>Chord tones</dt><dd>{frame.triad.notes.map(formatNote).join(" – ")}</dd>
                    <dt>Inversion</dt><dd>{INVERSION_NAMES[frame.inversion]}</dd>
                    <dt>Sounding</dt><dd>{frame.pitches.map(formatPitch).join("  ")} <small>(bass → top)</small></dd>
                  </dl>
                </div>
              )}
              {rtab === "neck" && (
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
                  {wraps && idx === 0 && result.closing !== null && <><dt>Cost from last chord (wrap)</dt><dd>{result.closing.toFixed(1)}</dd></>}
                </dl>
              )}
              {rtab === "verdict" && (
                <div>
                  {violations.length === 0 ? (
                    <p className="ok"><Check {...IC_SM} /> valid under the configured constraints, with exact pitches</p>
                  ) : (
                    <ul className="bad">{violations.map((v, i) => <li key={i}><b>{v.code}</b> {v.message}</li>)}</ul>
                  )}
                  <p className="muted">
                    An approximation: it checks string order, fret stretch, exact pitches and an estimated finger count. It does not guarantee a shape is comfortable to play.
                  </p>
                  {mode === "cycle" && result.cost !== null && <p className="muted">Whole {wraps ? "loop" : "path"} cost: {result.cost.toFixed(1)}</p>}
                  {sound && heard && <p className="muted" data-testid="heard"><Volume2 {...IC_SM} /> last heard: {heard}</p>}
                  {result.ir &&
                    (irIssues.length === 0 ? (
                      <p className="ok" data-testid="ir-status">
                        <Check {...IC_SM} /> MusicIR valid · {result.ir.chords.length} chords, {result.ir.events.length} notes
                      </p>
                    ) : (
                      <p className="bad" data-testid="ir-status"><X {...IC_SM} /> MusicIR has {irIssues.length} problem(s): {irIssues[0]!.message}</p>
                    ))}
                </div>
              )}
              {rtab === "steps" && mode === "cycle" && (
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
                          <td>{f.wrapped ? <><Repeat {...IC_SM} /> wrap</> : f.octaveShift ? (f.octaveShift > 0 ? `+${f.octaveShift}` : f.octaveShift) : "–"}</td>
                          <td>{i === 0 ? "–" : f.cost?.toFixed(1)}</td>
                        </tr>
                      ))}
                      {wraps && result.closing !== null && (
                        <tr className="wrap-row" onClick={() => go(0)}>
                          <td><Repeat {...IC_SM} /></td>
                          <td colSpan={5}>then back to chord 1</td>
                          <td>{result.closing.toFixed(1)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : (
        <div className="stage-empty" style={{ gridRow: "4 / 5" }}>
          <div>
            <b>No chords</b>
            Change the settings above.
          </div>
        </div>
      )}

      <Modal open={modal === "more"} onClose={closeModal} title="Fretboard, playback and sound" size="wide" testId="ev-more-modal" footer={<button className="btn primary" onClick={closeModal}>Done</button>}>
        <div className="form-grid">
          {mode === "cycle" && fold !== "sweep" && (
            <label className="field">
              <span>Chords</span>
              <input type="number" min={1} max={90} value={length} onChange={(e) => setLength(clamp(Number(e.target.value), 1, 90))} />
            </label>
          )}
          {mode === "cycle" && (
            <label className="field">
              <span>Across the neck</span>
              <select value={fold} onChange={(e) => setFold(e.target.value as FoldPolicy)}>
                <option value="sweep">Perfect loop (runs the neck, restarts)</option>
                <option value="whole-voicing">Fold each chord to fit (smoothest)</option>
                <option value="none">Exact pitches, no wrap (may fail)</option>
              </select>
            </label>
          )}
          {mode === "cycle" && (
            <label className="field">
              <span>Start near fret</span>
              <input type="number" min={0} max={22} placeholder="any" value={anchor} onChange={(e) => setAnchor(e.target.value === "" ? "" : clamp(Number(e.target.value), 0, 22))} />
            </label>
          )}
          <label className="field">
            <span>Max stretch (frets)</span>
            <input type="number" min={0} max={6} value={maxFretSpan} onChange={(e) => setMaxFretSpan(clamp(Number(e.target.value), 0, 6))} />
          </label>
          <label className="field">
            <span>Highest fret</span>
            <input type="number" min={5} max={22} value={maxFret} onChange={(e) => setMaxFret(clamp(Number(e.target.value), 5, 22))} />
          </label>
          <label className="field">
            <span>Tone</span>
            <select
              value={tone}
              onChange={(e) => {
                setTone(e.target.value as PluckTone);
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
          <div className="span-all deg-grid">
            {mode === "cycle" && fold !== "sweep" && (
              <label>
                <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop: last chord continues to the first
              </label>
            )}
            <label>
              <input type="checkbox" checked={showScale} onChange={(e) => setShowScale(e.target.checked)} /> Show scale notes
            </label>
            <label>
              <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
            </label>
          </div>
          {tone === "sine" && (
            <div className="span-all">
              <h3>Shape the sound <small className="muted">move a slider and the current chord replays</small></h3>
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
              <button className="btn small" onClick={() => setShape(SINE_SHAPE)}>Reset to default</button>
            </div>
          )}
        </div>
      </Modal>

      <Modal open={modal === "loop" && !!result.info} onClose={closeModal} title="About this loop" size="narrow" testId="ev-loop-modal">
        {result.info && (
          <p>
            <b>Perfect loop · {result.info.length} chords, {result.info.wraps} wrap{result.info.wraps === 1 ? "" : "s"} (<Repeat {...IC_SM} />)</b>
            {" "}Cycle {cycle} {descending ? "descends" : "ascends"}: it runs {descending ? "down from the high strings and frets toward the lowest strings" : "up from the low strings toward the highest strings and frets"}, changing string sets as it goes. When the next triad has no room left it wraps back to the {descending ? "top" : "bottom"} and carries on with the next triad of the cycle. After chord {result.info.length} the next triad is the first one again, in the same place, so the loop closes and repeats forever.
          </p>
        )}
      </Modal>
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
