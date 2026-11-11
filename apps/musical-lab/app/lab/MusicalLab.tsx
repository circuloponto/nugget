"use client";

import { FolderOpen, Save as SaveIcon, SkipBack, Pause, Play, Square, SkipForward, Music2, SlidersHorizontal, Check, X } from "lucide-react";
import { IC, IC_SM } from "../ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildCycleProgressionIR,
  buildScale,
  chordViewAtFrame,
  CYCLE_IDS,
  DEFAULT_RHYTHM,
  fnum,
  INVERSION_NAMES,
  irTuning,
  isScaleType,
  LETTERS,
  makeFretboard,
  makeTuning,
  parseFraction,
  parseMusicIR,
  PLUCK_TONES,
  renderDocument,
  resolveFrameTempo,
  rhythmizeIR,
  rhythmSpecFromIR,
  SCALE_TYPES,
  scheduleFrames,
  serializeMusicIR,
  stepsFromString,
  STANDARD_TUNING,
  toSampleFrameExact,
  validateMusicIR,
  type FrameTempo,
  type Inversion,
  type IRIssue,
  type MusicIR,
  type RhythmSpec,
  type ScaleType,
} from "@musical-lab/engine";
import type { PluckTone } from "../audio";
import Fretboard, { type DisplayNote, type Role } from "../Fretboard";
import { LabPlayer } from "./player";
import ProgressionStrip from "./ProgressionStrip";
import RhythmEditor from "./RhythmEditor";
import Timeline from "./Timeline";
import Modal from "../ui/Modal";
import Tabs from "../ui/Tabs";
import { Topbar } from "../ui/shellContext";

const TONICS = LETTERS.flatMap((l) => [l, `${l}b`, `${l}#`]);
const SCALE_LABEL: Record<ScaleType, string> = { major: "Major", naturalMinor: "Natural minor", harmonicMinor: "Harmonic minor" };

interface Params {
  tonic: string;
  scale: ScaleType;
  cycle: number;
  degree: number;
  inversion: Inversion;
  chords: 7 | 14 | "loop";
  chordBeats: number;
  bpm: number;
}
const INITIAL: Params = { tonic: "C", scale: "major", cycle: 5, degree: 1, inversion: 0, chords: 7, chordBeats: 4, bpm: 90 };

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);

export default function MusicalLab({ active = true }: { active?: boolean }) {
  const playerRef = useRef<LabPlayer | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastTotal = useRef(0);

  const [sampleRate, setSampleRate] = useState(44100);
  const [params, setParams] = useState<Params>(INITIAL);
  const [rhythm, setRhythm] = useState<RhythmSpec>(DEFAULT_RHYTHM);
  const [tone, setTone] = useState<PluckTone>("sine");
  const [loaded, setLoaded] = useState<{ ir: MusicIR; name: string } | null>(null);
  const [rhythmTouched, setRhythmTouched] = useState(false);
  const [bpmTouched, setBpmTouched] = useState(false);
  const [loadIssues, setLoadIssues] = useState<IRIssue[]>([]);
  const [playing, setPlaying] = useState(false);
  const [viewFrame, setViewFrame] = useState(0);
  const [readout, setReadout] = useState("");
  const [pxPerSecond, setPxPerSecond] = useState(90);
  const [audioInfo, setAudioInfo] = useState({ ms: 0, state: "none", busy: false });
  const [stage, setStage] = useState<"timeline" | "board" | "both">("both");
  const [rtab, setRtab] = useState<"rhythm" | "document">("rhythm");
  const [modal, setModal] = useState<null | "settings">(null);
  const closeModal = useCallback(() => setModal(null), []);

  // ── the audio transport ───────────────────────────────────────────────────
  useEffect(() => {
    const p = new LabPlayer();
    playerRef.current = p;
    setSampleRate(p.sampleRate);
    return () => p.dispose();
  }, []);

  useEffect(() => {
    if (!active) {
      playerRef.current?.pause();
      setPlaying(false);
    }
  }, [active]);

  // ── the document: generated from the parameters, or loaded from a file ────
  const built = useMemo(
    () =>
      loaded
        ? null
        : buildCycleProgressionIR({
            tonic: params.tonic,
            scale: params.scale,
            cycle: params.cycle,
            startDegree: params.degree,
            inversion: params.inversion,
            chords: params.chords,
            chordBeats: params.chordBeats,
            bpm: params.bpm,
            rhythm,
          }),
    [loaded, params, rhythm],
  );

  const doc: MusicIR | null = useMemo(() => {
    if (loaded) {
      if (!rhythmTouched) return loaded.ir; // a loaded file plays as saved until the rhythm is edited
      try {
        return rhythmizeIR(loaded.ir, rhythm);
      } catch {
        return loaded.ir;
      }
    }
    return built && built.ok ? built.ir : null;
  }, [loaded, rhythmTouched, rhythm, built]);

  const tempoArg: FrameTempo | undefined = useMemo(
    () => (loaded && bpmTouched ? { bpm: params.bpm } : undefined),
    [loaded, bpmTouched, params.bpm],
  );

  const schedule = useMemo(() => (doc ? scheduleFrames(doc, sampleRate, tempoArg) : null), [doc, sampleRate, tempoArg]);
  const tempo = useMemo(() => (doc ? resolveFrameTempo(doc, tempoArg) : null), [doc, tempoArg]);
  const issues = useMemo(() => (doc ? validateMusicIR(doc) : []), [doc]);
  const pxPerFrame = pxPerSecond / sampleRate;

  // ── render the document to audio (debounced) and hand it to the player ────
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !doc || !schedule) return;
    setAudioInfo((a) => ({ ...a, busy: true }));
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const r = renderDocument(doc, { sampleRate, tempo: tempoArg, tone: PLUCK_TONES[tone] });
      // an edit keeps the musical position: tempo scales every frame by the same factor
      const old = lastTotal.current;
      const mapped = old > 0 ? Math.round((p.position() * r.samples.length) / old) : 0;
      p.load(r.samples, mapped);
      lastTotal.current = r.samples.length;
      setAudioInfo({ ms: Math.round(performance.now() - t0), state: p.state, busy: false });
    }, 150);
    return () => clearTimeout(timer);
  }, [doc, schedule, tone, sampleRate, tempoArg]);

  // ── one animation loop: playhead, follow-scroll, and the moment shown in the other views ──
  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    let lastReadout = "";
    const tick = () => {
      const p = playerRef.current;
      if (p && doc && schedule && tempo) {
        const frame = p.position();
        const el = playheadRef.current;
        if (el) el.style.transform = `translateX(${frame * pxPerFrame}px)`;
        const sc = scrollRef.current;
        if (sc && p.isPlaying) {
          const x = frame * pxPerFrame;
          if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = Math.max(0, x - 100);
        }
        // only re-render the other views when the chord or the set of sounding notes changes
        const view = chordViewAtFrame(doc, schedule, frame);
        const key = view ? `${view.index}|${view.positions.map((x) => (x.sounding ? 1 : 0)).join("")}` : "-";
        if (key !== lastKey) {
          lastKey = key;
          setViewFrame(frame);
        }
        const beatFrames = toSampleFrameExact(tempo.beat, tempo.bpm, sampleRate, tempo.beat);
        const beats = frame / beatFrames;
        const text = `bar ${Math.floor(beats / 4) + 1} · beat ${((beats % 4) + 1).toFixed(1)}`;
        if (text !== lastReadout) {
          lastReadout = text;
          setReadout(text);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [doc, schedule, tempo, pxPerFrame, sampleRate]);

  const chordView = useMemo(() => (doc && schedule ? chordViewAtFrame(doc, schedule, viewFrame) : null), [doc, schedule, viewFrame]);
  const activeIndex = chordView?.index ?? -1;

  // ── fretboard, drawn from the document alone ──────────────────────────────
  const tuningNames = doc ? irTuning(doc) : null;
  const tuningKey = tuningNames?.join(" ") ?? "";
  const board = useMemo(
    () => makeFretboard(tuningNames ? makeTuning("document", tuningNames) : STANDARD_TUNING, 22),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tuningKey],
  );
  const fretScale = useMemo(() => {
    const k = chordView?.chord.key;
    if (!k || !isScaleType(k.scale)) return undefined;
    try {
      return buildScale(k.tonic, k.scale);
    } catch {
      return undefined;
    }
  }, [chordView?.chord.key]);
  const toDisplay = (p: NonNullable<typeof chordView>["positions"][number]): DisplayNote | null =>
    p.string === undefined || p.fret === undefined
      ? null
      : { string: p.string, fret: p.fret, role: (p.role ?? "fifth") as Role, label: p.pitch.replace(/-?\d+$/, ""), pitch: p.pitch };
  const sounding = (chordView?.positions ?? []).filter((p) => p.sounding).map(toDisplay).filter((x): x is DisplayNote => x !== null);
  const silent = (chordView?.positions ?? []).filter((p) => !p.sounding).map(toDisplay).filter((x): x is DisplayNote => x !== null);
  const hasPositions = (chordView?.positions ?? []).some((p) => p.string !== undefined);

  // ── transport ─────────────────────────────────────────────────────────────
  const toggle = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying) {
      p.pause();
      setPlaying(false);
    } else {
      await p.play();
      setPlaying(p.isPlaying);
      setAudioInfo((a) => ({ ...a, state: p.state }));
    }
  }, []);
  const seekFrame = useCallback(
    (frame: number) => {
      playerRef.current?.seek(frame);
      setViewFrame(frame);
    },
    [],
  );
  const seekChord = useCallback(
    (i: number) => {
      if (!schedule || schedule.chords.length === 0) return;
      const n = schedule.chords.length;
      seekFrame(schedule.chords[((i % n) + n) % n]!.startFrame);
    },
    [schedule, seekFrame],
  );
  const stop = () => {
    playerRef.current?.pause();
    setPlaying(false);
    seekFrame(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        void toggle();
      } else if (e.key === "ArrowRight") seekChord(activeIndex + 1);
      else if (e.key === "ArrowLeft") seekChord(activeIndex - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seekChord, activeIndex]);

  // ── save and load, always through the validator ───────────────────────────
  const save = () => {
    if (!doc) return;
    const blob = new Blob([serializeMusicIR(doc)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(doc.title ?? "musical-lab").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.musicir.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const loadText = useCallback((text: string, name: string) => {
    const r = parseMusicIR(text);
    if (!r.ok) {
      setLoadIssues(r.issues);
      return false;
    }
    setLoadIssues([]);
    setLoaded({ ir: r.ir, name });
    const spec = rhythmSpecFromIR(r.ir);
    setRhythm(spec ?? DEFAULT_RHYTHM);
    setRhythmTouched(false);
    setBpmTouched(false);
    if (r.ir.tempo) setParams((x) => ({ ...x, bpm: clamp(fnum(parseFraction(r.ir.tempo!.bpm)), 20, 300) }));
    lastTotal.current = 0;
    playerRef.current?.seek(0);
    setViewFrame(0);
    return true;
  }, []);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    loadText(await file.text(), file.name);
    if (fileRef.current) fileRef.current.value = "";
  };
  const regenerate = () => {
    setLoaded(null);
    setLoadIssues([]);
    setRhythmTouched(false);
    setBpmTouched(false);
    lastTotal.current = 0;
    playerRef.current?.seek(0);
  };

  const setParam = <K extends keyof Params>(key: K, value: Params[K]) => setParams((p) => ({ ...p, [key]: value }));
  const editRhythm = (next: RhythmSpec) => {
    setRhythm(next);
    setRhythmTouched(true);
  };
  const gridSteps = (() => {
    try {
      return stepsFromString(rhythm.pattern).length;
    } catch {
      return 0;
    }
  })();
  const noteCount = doc ? doc.events.filter((e) => e.kind === "note").length : 0;
  const lockedGenerator = loaded !== null;

  return (
    <div className="wb lab3 lab2-frame">
      <Topbar active={active}>
        <button className="tool-btn" onClick={() => seekChord(activeIndex - 1)} aria-label="Previous chord" title="Previous chord" disabled={!doc}>
          <SkipBack {...IC} />
        </button>
        <button className="tool-btn primary" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"} disabled={!doc} data-testid="lab-play">
          {playing ? <Pause {...IC} /> : <Play {...IC} />}
        </button>
        <button className="tool-btn" onClick={stop} aria-label="Stop and rewind" title="Stop and rewind" disabled={!doc}>
          <Square {...IC} />
        </button>
        <button className="tool-btn" onClick={() => seekChord(activeIndex + 1)} aria-label="Next chord" title="Next chord" disabled={!doc}>
          <SkipForward {...IC} />
        </button>
        <span className="pill pill-opt" data-testid="readout" title="Where the playhead is">
          {readout || "bar 1 · beat 1.0"} · <b>{chordView?.chord.symbol ?? "—"}</b>
        </span>
        <span className="pill" title="Tempo (beats per minute)">
          <Music2 {...IC} />
          <input
            type="number"
            min={40}
            max={200}
            value={params.bpm}
            onChange={(e) => {
              setParam("bpm", clamp(Number(e.target.value), 40, 200));
              setBpmTouched(true);
            }}
            aria-label="Tempo"
            data-testid="lab-bpm"
          />
        </span>
        <button className="tool-btn" onClick={() => fileRef.current?.click()} title="Open a MusicIR document" data-testid="lab-open">
          <FolderOpen {...IC} />
          <span className="lbl">Open</span>
        </button>
        <button className="tool-btn" onClick={save} disabled={!doc} title="Save this document as MusicIR" data-testid="lab-save">
          <SaveIcon {...IC} />
          <span className="lbl">Save</span>
        </button>
        <button className="tool-btn" onClick={() => setModal("settings")} aria-label="View settings" title="View settings" data-testid="lab-settings">
          <SlidersHorizontal {...IC} />
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} data-testid="file" />
      </Topbar>

      <section className="wb-controls lab3-controls" aria-label="Progression" onChange={(e) => e.target instanceof HTMLSelectElement && e.target.blur()}>
        <label className="field">
          <span>Key</span>
          <select value={params.tonic} disabled={lockedGenerator} onChange={(e) => setParam("tonic", e.target.value)}>
            {TONICS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scale</span>
          <select value={params.scale} disabled={lockedGenerator} onChange={(e) => setParam("scale", e.target.value as ScaleType)}>
            {SCALE_TYPES.map((t) => (
              <option key={t} value={t}>
                {SCALE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Cycle</span>
          <select value={params.cycle} disabled={lockedGenerator} onChange={(e) => setParam("cycle", Number(e.target.value))}>
            {CYCLE_IDS.map((c) => (
              <option key={c} value={c}>
                Cycle {c} (root up {c - 1})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Start on degree</span>
          <select value={params.degree} disabled={lockedGenerator} onChange={(e) => setParam("degree", Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Inversion</span>
          <select value={params.inversion} disabled={lockedGenerator} onChange={(e) => setParam("inversion", Number(e.target.value) as Inversion)}>
            {INVERSION_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Chords</span>
          <select value={String(params.chords)} disabled={lockedGenerator} onChange={(e) => setParam("chords", e.target.value === "loop" ? "loop" : (Number(e.target.value) as 7 | 14))}>
            <option value="7">7 (one pass of the cycle)</option>
            <option value="14">14</option>
            <option value="loop">The whole perfect loop</option>
          </select>
        </label>
        <label className="field">
          <span>Chord length</span>
          <select value={params.chordBeats} disabled={lockedGenerator} onChange={(e) => setParam("chordBeats", Number(e.target.value))}>
            <option value={2}>2 beats</option>
            <option value={4}>1 bar (4 beats)</option>
          </select>
        </label>
      </section>

      <div className="wb-messages">
        {loadIssues.length > 0 && (
          <div className="banner error" role="alert" data-testid="load-error">
            <b>That file is not a valid MusicIR document, so nothing was loaded.</b> {loadIssues.length} problem{loadIssues.length === 1 ? "" : "s"}: {loadIssues.slice(0, 4).map((i) => `${i.path || "(document)"} ${i.message}`).join(" · ")}
            {loadIssues.length > 4 ? ` …and ${loadIssues.length - 4} more` : ""}
          </div>
        )}
        {built && !built.ok && (
          <div className="banner error" role="alert">
            {built.reason}
          </div>
        )}
        {lockedGenerator && (
          <div className="banner">
            Showing <b>{loaded.name}</b>. The progression controls are off because the notes come from the file; the rhythm and tempo can still be edited.
            <button className="btn small" onClick={regenerate}>Back to generated progression</button>
          </div>
        )}
      </div>

      {doc && schedule && tempo ? (
        <>
          <section className="wb-chords" aria-label="Progression">
            <span className="label">Chords</span>
            <div className="chord-row lab3-chords">
              <ProgressionStrip chords={doc.chords} activeIndex={activeIndex} closed={doc.relations.some((r) => r.data?.closing === true)} onSeek={seekChord} />
            </div>
            <div className="wb-chords-right">
              <span className="pill" data-testid="audio-info" title="The loop, the sample rate and the audio state">
                {audioInfo.busy ? "rendering…" : `loop ${(schedule.totalFrames / sampleRate).toFixed(1)} s · ${audioInfo.state}`}
              </span>
            </div>
          </section>

          <div className="wb-main lab3-main">
            <section className="card wb-left" aria-label="Views">
              <div className="wb-left-head">
                <Tabs
                  label="Lab view"
                  value={stage}
                  onChange={setStage}
                  tabs={[
                    { id: "timeline", label: "Timeline", testId: "lab-tab-timeline" },
                    { id: "board", label: "Fretboard", testId: "lab-tab-board" },
                    { id: "both", label: "Both", testId: "lab-tab-both" },
                  ]}
                />
                <div className="wb-toolbar">
                  <span className="legend-inline">
                    <i className="dot root" /> root <i className="dot third" /> third <i className="dot fifth" /> fifth
                  </span>
                  {stage !== "board" && (
                    <label>
                      Zoom <input type="range" min={30} max={260} value={pxPerSecond} onChange={(e) => setPxPerSecond(Number(e.target.value))} aria-label="Zoom" />
                    </label>
                  )}
                </div>
              </div>
              <div className="wb-stage">
                {stage !== "board" && (
                  <div className="stage-pane roll">
                    <Timeline ir={doc} schedule={schedule} tempo={tempo} gridSteps={gridSteps} pxPerSecond={pxPerSecond} activeIndex={activeIndex} playheadRef={playheadRef} scrollRef={scrollRef} onSeek={seekFrame} />
                    <p className="hint" style={{ marginTop: 6 }}>dashed lines are the rhythm’s own grid ({gridSteps} per chord); solid are beats and bars; click to move the playhead</p>
                  </div>
                )}
                {stage !== "timeline" && (
                  <div className="stage-pane board">
                    {hasPositions ? (
                      <>
                        <Fretboard board={board} scale={fretScale} frets={22} notes={sounding} ghost={silent} showScale={fretScale !== undefined} />
                        <p className="hint" style={{ marginTop: 6 }}>
                          <b>{chordView?.chord.symbol}</b>
                          {chordView?.chord.roman ? ` (${chordView.chord.roman})` : ""} · filled = sounding now · rings = in the chord, not sounding
                        </p>
                      </>
                    ) : (
                      <p className="hint">This document has no fretted positions, so there is nothing to draw on the fretboard.</p>
                    )}
                  </div>
                )}
              </div>
            </section>

            <aside className="card wb-right lab3-right" aria-label="Rhythm and document">
              <Tabs
                label="Rhythm and document"
                value={rtab}
                onChange={setRtab}
                tabs={[
                  { id: "rhythm", label: "Rhythm", testId: "lab-tab-rhythm" },
                  { id: "document", label: "Document", testId: "lab-tab-document" },
                ]}
              />
              <div className="scroll-y lab3-right-body">
                {rtab === "rhythm" && <RhythmEditor rhythm={rhythm} onChange={editRhythm} />}
                {rtab === "document" && (
                  <section aria-label="Document">
                    {issues.length === 0 ? (
                      <p className="ok" data-testid="doc-status">
                        <Check {...IC_SM} /> valid MusicIR · {doc.chords.length} chords · {noteCount} notes · tempo {doc.tempo ? fnum(parseFraction(doc.tempo.bpm)) : "—"} BPM · every fret position checked against its pitch and tuning
                      </p>
                    ) : (
                      <p className="bad" data-testid="doc-status">
                        <X {...IC_SM} /> {issues.length} problem(s): {issues[0]!.message}
                      </p>
                    )}
                    <p className="hint">Save writes exactly this document. Open accepts a file only if it passes the same checks, structure first and then meaning (frets against pitches and tuning, chord labels against notes).</p>
                  </section>
                )}
              </div>
            </aside>
          </div>
        </>
      ) : (
        <div className="stage-empty" style={{ gridRow: "3 / 5" }}>
          <div>
            <b>No progression</b>
            Choose a key, scale and cycle.
          </div>
        </div>
      )}

      <Modal open={modal === "settings"} onClose={closeModal} title="Settings" size="narrow" testId="lab-settings-modal" footer={<button className="btn primary" onClick={closeModal}>Done</button>}>
        <div className="form-grid">
          <label className="field span-all">
            <span>Tone</span>
            <select value={tone} onChange={(e) => setTone(e.target.value as PluckTone)} data-testid="lab-tone">
              <option value="sine">Sine</option>
              <option value="soft">Soft string</option>
              <option value="mellow">Mellow string</option>
              <option value="bright">Bright string</option>
            </select>
          </label>
          <label className="field span-all">
            <span>
              Timeline zoom <b>{pxPerSecond}</b> px per second
            </span>
            <input type="range" min={30} max={260} value={pxPerSecond} onChange={(e) => setPxPerSecond(Number(e.target.value))} />
          </label>
          <p className="hint span-all">Tempo is in the top bar; the progression controls are under it.</p>
        </div>
      </Modal>
    </div>
  );
}
