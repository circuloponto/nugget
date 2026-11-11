"use client";

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

export default function MusicalLab() {
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

  // ── the audio transport ───────────────────────────────────────────────────
  useEffect(() => {
    const p = new LabPlayer();
    playerRef.current = p;
    setSampleRate(p.sampleRate);
    return () => p.dispose();
  }, []);

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
    <main className="lab lab2">
      <header className="lab2-head">
        <div>
          <h1>
            Musical Lab <span>phase 2</span>
          </h1>
          <p>
            One document, three synchronized views, sample-accurate audio. <a href="/phrase">Phrase Constructor →</a> · <a href="/corpus">Corpus Analysis →</a> · <a href="/evaluator">Engine evaluator →</a>
          </p>
        </div>
        <div className="docbar">
          <button onClick={save} disabled={!doc}>
            ⬇ Save MusicIR
          </button>
          <button onClick={() => fileRef.current?.click()}>⬆ Load MusicIR…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} data-testid="file" />
        </div>
      </header>

      {loadIssues.length > 0 && (
        <div className="panel error" role="alert" data-testid="load-error">
          <b>That file is not a valid MusicIR document, so nothing was loaded.</b> {loadIssues.length} problem{loadIssues.length === 1 ? "" : "s"}:
          <ul>
            {loadIssues.slice(0, 8).map((i, k) => (
              <li key={k}>
                <code>{i.path || "(document)"}</code> {i.message}
              </li>
            ))}
          </ul>
          {loadIssues.length > 8 && <small>…and {loadIssues.length - 8} more</small>}
        </div>
      )}

      <section className={lockedGenerator ? "panel controls locked" : "panel controls"} aria-label="Progression" onChange={(e) => e.target instanceof HTMLSelectElement && e.target.blur()}>
        <label>
          Key
          <select value={params.tonic} disabled={lockedGenerator} onChange={(e) => setParam("tonic", e.target.value)}>
            {TONICS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Scale
          <select value={params.scale} disabled={lockedGenerator} onChange={(e) => setParam("scale", e.target.value as ScaleType)}>
            {SCALE_TYPES.map((t) => (
              <option key={t} value={t}>
                {SCALE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cycle
          <select value={params.cycle} disabled={lockedGenerator} onChange={(e) => setParam("cycle", Number(e.target.value))}>
            {CYCLE_IDS.map((c) => (
              <option key={c} value={c}>
                Cycle {c} (root up {c - 1})
              </option>
            ))}
          </select>
        </label>
        <label>
          Start on degree
          <select value={params.degree} disabled={lockedGenerator} onChange={(e) => setParam("degree", Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Inversion
          <select value={params.inversion} disabled={lockedGenerator} onChange={(e) => setParam("inversion", Number(e.target.value) as Inversion)}>
            {INVERSION_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Chords
          <select
            value={String(params.chords)}
            disabled={lockedGenerator}
            onChange={(e) => setParam("chords", e.target.value === "loop" ? "loop" : (Number(e.target.value) as 7 | 14))}
          >
            <option value="7">7 (one pass of the cycle)</option>
            <option value="14">14</option>
            <option value="loop">The whole perfect loop</option>
          </select>
        </label>
        <label>
          Chord length
          <select value={params.chordBeats} disabled={lockedGenerator} onChange={(e) => setParam("chordBeats", Number(e.target.value))}>
            <option value={2}>2 beats</option>
            <option value={4}>1 bar (4 beats)</option>
          </select>
        </label>
        <label>
          Tempo (BPM)
          <input
            type="number"
            min={40}
            max={200}
            value={params.bpm}
            onChange={(e) => {
              setParam("bpm", clamp(Number(e.target.value), 40, 200));
              setBpmTouched(true);
            }}
          />
        </label>
        <label>
          Tone
          <select value={tone} onChange={(e) => setTone(e.target.value as PluckTone)}>
            <option value="sine">Sine</option>
            <option value="soft">Soft string</option>
            <option value="mellow">Mellow string</option>
            <option value="bright">Bright string</option>
          </select>
        </label>
        {lockedGenerator && (
          <div className="loaded-note">
            Showing <b>{loaded.name}</b>. The progression controls are off because the notes come from the file; the rhythm and tempo can still be edited.{" "}
            <button onClick={regenerate}>Back to generated progression</button>
          </div>
        )}
      </section>

      {built && !built.ok && (
        <div className="panel error" role="alert">
          {built.reason}
        </div>
      )}

      {doc && schedule && tempo && (
        <>
          <section className="panel transport" aria-label="Transport">
            <button className="play" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button onClick={stop} aria-label="Stop and rewind">
              ⏹ Rewind
            </button>
            <button onClick={() => seekChord(activeIndex - 1)} aria-label="Previous chord">
              ◀ chord
            </button>
            <button onClick={() => seekChord(activeIndex + 1)} aria-label="Next chord">
              chord ▶
            </button>
            <span className="readout" data-testid="readout">
              {readout || "bar 1 · beat 1.0"} · <b>{chordView?.chord.symbol ?? "—"}</b>
            </span>
            <label className="zoom">
              Zoom
              <input type="range" min={30} max={260} value={pxPerSecond} onChange={(e) => setPxPerSecond(Number(e.target.value))} />
            </label>
            <span className="muted" data-testid="audio-info">
              {audioInfo.busy ? "rendering…" : `loop ${(schedule.totalFrames / sampleRate).toFixed(1)} s · ${sampleRate} Hz · ${audioInfo.state}`}
            </span>
          </section>

          <ProgressionStrip chords={doc.chords} activeIndex={activeIndex} closed={doc.relations.some((r) => r.data?.closing === true)} onSeek={seekChord} />

          <section className="panel">
            <Timeline
              ir={doc}
              schedule={schedule}
              tempo={tempo}
              gridSteps={gridSteps}
              pxPerSecond={pxPerSecond}
              activeIndex={activeIndex}
              playheadRef={playheadRef}
              scrollRef={scrollRef}
              onSeek={seekFrame}
            />
            <div className="legend">
              <span>
                <i className="dot root" /> root
              </span>
              <span>
                <i className="dot third" /> third
              </span>
              <span>
                <i className="dot fifth" /> fifth
              </span>
              <span className="muted">dashed lines are the rhythm’s own grid ({gridSteps} per chord); solid are beats and bars; click to move the playhead</span>
            </div>
          </section>

          <section className="panel">
            {hasPositions ? (
              <>
                <Fretboard board={board} scale={fretScale} frets={17} notes={sounding} ghost={silent} showScale={fretScale !== undefined} />
                <div className="legend">
                  <span>
                    <b>{chordView?.chord.symbol}</b>
                    {chordView?.chord.roman ? ` (${chordView.chord.roman})` : ""} · filled = sounding now · rings = in the chord, not sounding
                  </span>
                </div>
              </>
            ) : (
              <p className="muted">This document has no fretted positions, so there is nothing to draw on the fretboard.</p>
            )}
          </section>

          <RhythmEditor rhythm={rhythm} onChange={editRhythm} />

          <section className="panel docinfo" aria-label="Document">
            {issues.length === 0 ? (
              <p className="ok" data-testid="doc-status">
                ✓ valid MusicIR · {doc.chords.length} chords · {noteCount} notes · tempo {doc.tempo ? fnum(parseFraction(doc.tempo.bpm)) : "—"} BPM · every fret position checked against its pitch and tuning
              </p>
            ) : (
              <p className="bad" data-testid="doc-status">
                ✗ {issues.length} problem(s): {issues[0]!.message}
              </p>
            )}
            <p className="muted">
              Save writes exactly this document. Load accepts a file only if it passes the same checks, structure first and then meaning (frets against pitches and tuning, chord labels against notes).
            </p>
          </section>
        </>
      )}
    </main>
  );
}
