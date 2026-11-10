"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeMelody,
  DEFAULT_PHRASE_REQUEST,
  editPhraseNote,
  formatPitch,
  frac,
  fstr,
  generatePhrase,
  irTuning,
  makeFretboard,
  makeTuning,
  midi,
  parseFraction,
  parseMusicIR,
  parsePhraseRequest,
  phraseSpecFromRequest,
  phraseToIR,
  PLUCK_TONES,
  renderDocument,
  scheduleFrames,
  serializeMusicIR,
  spellInSpace,
  STANDARD_TUNING,
  targetOptions,
  withInterpretations,
  type IRIssue,
  type IRNoteEvent,
  type MusicIR,
  type PhraseCandidate,
  type PhraseRequest,
} from "@musical-lab/engine";
import Fretboard, { type DisplayNote, type Role } from "../Fretboard";
import { LabPlayer } from "../lab/player";
import PhraseRoll, { noteKind } from "./PhraseRoll";

const TONICS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const DURATIONS = ["1/16", "1/12", "1/8", "3/16", "1/6", "1/4", "3/8", "1/2", "3/4", "1"];
const MELODY = "melody";
const midiName = (m: number): string => formatPitch(spellInSpace(m, { scale: [] }));
const REGISTER = Array.from({ length: 49 }, (_, i) => 40 + i);

type Loaded = { name: string } | null;

function roleOf(ir: MusicIR, n: IRNoteEvent): Role {
  const kind = noteKind(ir, n);
  return kind === "other" ? "other" : kind;
}

function describeStep(step: { op: string; params: Readonly<Record<string, unknown>> }): string {
  const p = Object.entries(step.params)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  return p ? `${step.op}(${p})` : step.op;
}

export default function PhraseConstructor() {
  const playerRef = useRef<LabPlayer | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastTotal = useRef(0);

  const [req, setReq] = useState<PhraseRequest>(DEFAULT_PHRASE_REQUEST);
  const [sampleRate, setSampleRate] = useState(44100);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PhraseCandidate[]>([]);
  const [considered, setConsidered] = useState(0);
  const [candidate, setCandidate] = useState<PhraseCandidate | null>(null);
  const [ir, setIr] = useState<MusicIR | null>(null);
  const [edited, setEdited] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editError, setEditError] = useState<IRIssue[]>([]);
  const [loadError, setLoadError] = useState<IRIssue[]>([]);
  const [playing, setPlaying] = useState(false);
  const [sounding, setSounding] = useState<string[]>([]);
  const [pxPerSecond, setPxPerSecond] = useState(110);
  const [attachAnalysis, setAttachAnalysis] = useState(true);
  const [transformNote, setTransformNote] = useState("");
  const [openScore, setOpenScore] = useState<string | null>(null);
  const [audioMs, setAudioMs] = useState(0);

  const spec = useMemo(() => phraseSpecFromRequest(req), [req]);
  const targets = useMemo(() => targetOptions(req.tonic, req.mode), [req.tonic, req.mode]);

  // ── audio ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const p = new LabPlayer();
    playerRef.current = p;
    setSampleRate(p.sampleRate);
    return () => p.dispose();
  }, []);

  const schedule = useMemo(() => (ir ? scheduleFrames(ir, sampleRate) : null), [ir, sampleRate]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || !ir) return;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const r = renderDocument(ir, { sampleRate: p.sampleRate, tone: PLUCK_TONES.sine });
      const old = lastTotal.current;
      const at = old > 0 ? Math.round((p.position() * r.samples.length) / old) : 0;
      p.load(r.samples, at);
      lastTotal.current = r.samples.length;
      setAudioMs(Math.round(performance.now() - t0));
    }, 120);
    return () => clearTimeout(timer);
  }, [ir]);

  const pxPerFrame = pxPerSecond / sampleRate;
  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    const tick = () => {
      const p = playerRef.current;
      if (p && schedule) {
        const frame = p.position();
        const el = playheadRef.current;
        if (el) el.style.transform = `translateX(${frame * pxPerFrame}px)`;
        const sc = scrollRef.current;
        if (sc && p.isPlaying) {
          const x = frame * pxPerFrame;
          if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = Math.max(0, x - 100);
        }
        const now = p.isPlaying ? schedule.events.filter((e) => e.voice === MELODY && e.startFrame <= frame && frame < e.endFrame).map((e) => e.id) : [];
        const key = now.join(",");
        if (key !== lastKey) {
          lastKey = key;
          setSounding(now);
        }
        if (p.isPlaying !== playing) setPlaying(p.isPlaying);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [schedule, pxPerFrame, playing]);

  const toggle = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying) p.pause();
    else await p.play();
    setPlaying(p.isPlaying);
  }, []);
  const rewind = () => {
    const p = playerRef.current;
    p?.pause();
    p?.seek(0);
    setPlaying(false);
    setSounding([]);
  };

  // ── generating, choosing, transforming ───────────────────────────────────
  const adopt = useCallback(
    (c: PhraseCandidate, forReq: PhraseRequest) => {
      const s = phraseSpecFromRequest(forReq);
      const doc = phraseToIR(c, s, { bpm: forReq.bpm, request: forReq as unknown as Record<string, unknown> });
      setCandidate(c);
      setIr(doc);
      setEdited(false);
      setLoaded(null);
      setSelected(c.targetNote);
      setEditError([]);
      setLoadError([]);
    },
    [],
  );

  const run = (build: () => ReturnType<typeof generatePhrase>, label: string, after?: (list: PhraseCandidate[]) => PhraseCandidate[]) => {
    setBusy(true);
    setFailure(null);
    setTransformNote("");
    setTimeout(() => {
      const r = build();
      if (!r.ok) {
        setFailure(r.reason);
        setBusy(false);
        return;
      }
      const list = after ? after([...r.candidates]) : [...r.candidates];
      if (list.length === 0) {
        setFailure("Nothing new could be built that way: every result repeated what you already have.");
        setBusy(false);
        return;
      }
      setCandidates(list);
      setConsidered(r.considered);
      adopt(list[0]!, req);
      if (label) setTransformNote(label);
      setBusy(false);
    }, 20);
  };

  const generate = () => run(() => generatePhrase(spec), "");

  const keepRhythm = () => {
    if (!candidate) return;
    const exact = candidate.choices.pitches.map(midi);
    run(() => generatePhrase({ ...spec, fixed: { rhythm: candidate.choices.rhythm }, avoidPitchSequences: [exact] }), "Same rhythm, new pitches: every note keeps its exact time; the harmonic goal is unchanged.");
  };

  const keepPitches = () => {
    if (!candidate) return;
    const before = candidate.choices.rhythm.id;
    run(
      () => generatePhrase({ ...spec, fixed: { template: candidate } }),
      "Same notes and construction, new rhythm: the target still arrives at its exact time.",
      (list) => list.filter((c) => c.choices.rhythm.id !== before),
    );
  };

  // ── editing one note ─────────────────────────────────────────────────────
  const edit = (change: { midi?: number; duration?: string; onsetShift?: string }) => {
    if (!ir || !selected) return;
    const ev = ir.events.find((e): e is IRNoteEvent => e.kind === "note" && e.id === selected);
    if (!ev) return;
    const res = editPhraseNote(ir, selected, {
      ...(change.midi !== undefined ? { midi: change.midi } : {}),
      ...(change.duration ? { duration: parseFraction(change.duration) } : {}),
      ...(change.onsetShift ? { onset: addFraction(ev.onset, change.onsetShift) } : {}),
    }, { scale: [] });
    if (!res.ok) {
      setEditError(res.issues);
      return;
    }
    setEditError([]);
    setIr(res.ir);
    setEdited(true);
  };

  // ── save / load ──────────────────────────────────────────────────────────
  const save = () => {
    if (!ir) return;
    const doc = attachAnalysis ? withInterpretations(ir, analyzeMelody(ir)) : ir;
    const blob = new Blob([serializeMusicIR(doc)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `phrase-${req.tonic}-${req.mode}.musicir.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseMusicIR(await file.text());
    if (!parsed.ok) {
      setLoadError(parsed.issues);
      return;
    }
    const doc = parsed.ir;
    if (!doc.voices.some((v) => v.id === MELODY)) {
      setLoadError([{ path: "voices", message: `the Phrase Constructor edits a document with a "${MELODY}" voice; this one has none` }]);
      return;
    }
    // restore the controls that produced it, if the file says what they were
    const stored = doc.transformations.find((t) => t.op === "phrase-generate")?.params.request;
    if (typeof stored === "string") {
      try {
        const r = parsePhraseRequest(JSON.parse(stored));
        if (r.ok) setReq(r.request);
      } catch {
        /* a damaged request is ignored: the controls stay as they are */
      }
    }
    setLoadError([]);
    setIr(doc);
    setCandidate(null);
    setCandidates([]);
    setEdited(false);
    setLoaded({ name: file.name });
    setSelected(doc.semantics?.targets?.[0]?.note ?? null);
    setEditError([]);
    if (fileRef.current) fileRef.current.value = "";
  };

  // ── derived views ────────────────────────────────────────────────────────
  const analysis = useMemo(() => (ir ? analyzeMelody(ir, { voice: MELODY }) : null), [ir]);
  const tuningNames = ir ? irTuning(ir) : null;
  const tuningKey = tuningNames?.join(" ") ?? "";
  const board = useMemo(
    () => makeFretboard(tuningNames ? makeTuning("document", tuningNames) : STANDARD_TUNING, 22),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tuningKey],
  );
  const melody = useMemo(() => (ir ? ir.events.filter((e): e is IRNoteEvent => e.kind === "note" && e.voice === MELODY) : []), [ir]);
  const toDisplay = useCallback(
    (n: IRNoteEvent): DisplayNote | null =>
      n.instrument && ir ? { string: n.instrument.string, fret: n.instrument.fret, role: roleOf(ir, n), label: n.pitch.name.replace(/-?\d+$/, ""), pitch: n.pitch.name } : null,
    [ir],
  );
  const shownIds = sounding.length ? sounding : selected ? [selected] : [];
  const fretNotes = melody.filter((n) => shownIds.includes(n.id)).map(toDisplay).filter((x): x is DisplayNote => x !== null);
  const fretGhost = melody.map(toDisplay).filter((x): x is DisplayNote => x !== null);

  const sel = ir?.events.find((e): e is IRNoteEvent => e.kind === "note" && e.id === selected) ?? null;
  const selFunctions = ir?.semantics?.noteFunctions?.find((f) => f.note === selected);
  const selGestures = ir?.semantics?.gestures?.filter((g) => selected && (g.notes.includes(selected) || ir.semantics?.targets?.some((t) => t.id === g.target && t.note === selected))) ?? [];
  const selReadings = analysis?.interpretations.filter((i) => selected && i.notes.includes(selected)) ?? [];
  const selFacts = analysis?.facts.find((f) => f.id === selected);

  const regLo = req.register[0];
  const regHi = req.register[1];
  const set = (patch: Partial<PhraseRequest>) => setReq((r) => ({ ...r, ...patch }));

  return (
    <main className="lab lab2 ph">
      <header className="lab2-head">
        <div>
          <h1>
            Phrase Constructor <span>phase 3</span>
          </h1>
          <p>
            A ii–V–I phrase built from a grammar of targets, outlines, enclosures and rhythm, then inspected note by note. <a href="/">← Musical Lab</a> · <a href="/evaluator">Engine evaluator →</a>
          </p>
        </div>
        <div className="docbar">
          <button onClick={save} disabled={!ir}>
            ⬇ Save MusicIR
          </button>
          <button onClick={() => fileRef.current?.click()}>⬆ Load MusicIR…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} data-testid="ph-file" />
        </div>
      </header>

      {loadError.length > 0 && (
        <div className="panel error" role="alert" data-testid="ph-load-error">
          <b>That file is not usable, so nothing was loaded.</b>
          <ul>
            {loadError.slice(0, 8).map((i, k) => (
              <li key={k}>
                <code>{i.path || "(document)"}</code> {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 1-4: what to build ─────────────────────────────────────────── */}
      <section className="panel ph-controls" aria-label="Phrase request">
        <fieldset>
          <legend>1 · Harmony</legend>
          <label>
            Key
            <select value={req.tonic} onChange={(e) => set({ tonic: e.target.value })}>
              {TONICS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select value={req.mode} onChange={(e) => set({ mode: e.target.value as "major" | "minor", targetDegree: "3" })}>
              <option value="major">major ii–V–I</option>
              <option value="minor">minor ii–V–i</option>
            </select>
          </label>
          <label>
            Tempo <b>{req.bpm}</b>
            <input type="range" min={50} max={200} value={req.bpm} onChange={(e) => set({ bpm: Number(e.target.value) })} />
          </label>
        </fieldset>

        <fieldset>
          <legend>2 · Target (on {targets.chord})</legend>
          <label>
            Arrive on
            <select value={req.targetDegree} onChange={(e) => set({ targetDegree: e.target.value })} data-testid="ph-target">
              {targets.options.map((o) => (
                <option key={o.degree} value={o.degree}>
                  {o.degree} · {o.note} · {o.role}
                  {o.kind === "alteration" ? " (alteration)" : o.kind === "extension" ? " (extension)" : ""}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>3 · Melodic operations</legend>
          <label>
            Outline the V chord
            <select
              value={req.outline.direction}
              onChange={(e) => set({ outline: { ...req.outline, direction: e.target.value as PhraseRequest["outline"]["direction"] } })}
              data-testid="ph-outline"
            >
              <option value="any">arpeggio, any shape</option>
              <option value="up">arpeggio up</option>
              <option value="down">arpeggio down</option>
              <option value="updown">arpeggio up then down</option>
              <option value="mixed">arpeggio, mixed</option>
              <option value="none">no outline</option>
            </select>
          </label>
          <label>
            Reach the target by
            <select value={req.embellishment.kind} onChange={(e) => set({ embellishment: { ...req.embellishment, kind: e.target.value as PhraseRequest["embellishment"]["kind"] } })} data-testid="ph-emb">
              <option value="enclosure">an enclosure (both sides)</option>
              <option value="approach">an approach (one side)</option>
              <option value="none">nothing: arrive directly</option>
            </select>
          </label>
          <label>
            Steps are
            <select value={req.embellishment.step} onChange={(e) => set({ embellishment: { ...req.embellishment, step: e.target.value as PhraseRequest["embellishment"]["step"] } })}>
              <option value="chromatic">chromatic (semitones)</option>
              <option value="diatonic">diatonic (scale steps)</option>
              <option value="mixed">mixed</option>
              <option value="any">any</option>
            </select>
          </label>
          <label>
            From
            <select value={req.embellishment.side ?? "any"} onChange={(e) => set({ embellishment: { ...req.embellishment, side: e.target.value as "above" | "below" | "any" } })}>
              <option value="any">either side</option>
              <option value="above">above first</option>
              <option value="below">below first</option>
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>4 · Rhythm</legend>
          <label>
            Feel
            <select value={req.rhythm.feel ?? "any"} onChange={(e) => set({ rhythm: { ...req.rhythm, feel: e.target.value as "straight" | "triplet" | "any" } })}>
              <option value="any">any</option>
              <option value="straight">straight</option>
              <option value="triplet">triplets</option>
            </select>
          </label>
          <label>
            Shape
            <select value={req.rhythm.shape ?? "any"} onChange={(e) => set({ rhythm: { ...req.rhythm, shape: e.target.value as "even" | "accelerating" | "decelerating" | "any" } })}>
              <option value="any">any</option>
              <option value="accelerating">accelerating into the target</option>
              <option value="decelerating">decelerating</option>
              <option value="even">even</option>
            </select>
          </label>
          <label>
            Density
            <select
              value={req.rhythm.density ?? ""}
              onChange={(e) => {
                const { density: _d, ...rest } = req.rhythm;
                void _d;
                set({ rhythm: e.target.value ? { ...rest, density: Number(e.target.value) } : rest });
              }}
            >
              <option value="">no preference</option>
              <option value="1">sparse</option>
              <option value="2">medium</option>
              <option value="3">busy</option>
            </select>
          </label>
          <label>
            Syncopation
            <select
              value={req.rhythm.syncopation ?? ""}
              onChange={(e) => {
                const { syncopation: _s, ...rest } = req.rhythm;
                void _s;
                set({ rhythm: e.target.value ? { ...rest, syncopation: Number(e.target.value) } : rest });
              }}
            >
              <option value="">no preference</option>
              <option value="0.1">little</option>
              <option value="0.4">some</option>
              <option value="0.8">a lot</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={req.rhythm.rests !== false} onChange={(e) => set({ rhythm: { ...req.rhythm, rests: e.target.checked } })} /> allow rests
          </label>
        </fieldset>

        <fieldset>
          <legend>Constraints</legend>
          <label>
            Lowest note
            <select value={regLo} onChange={(e) => set({ register: [Math.min(Number(e.target.value), regHi), regHi] })}>
              {REGISTER.map((m) => (
                <option key={m} value={m}>
                  {midiName(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Highest note
            <select value={regHi} onChange={(e) => set({ register: [regLo, Math.max(Number(e.target.value), regLo)] })}>
              {REGISTER.map((m) => (
                <option key={m} value={m}>
                  {midiName(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Largest leap <b>{req.maxLeap}</b> semitones
            <input type="range" min={2} max={14} value={req.maxLeap} onChange={(e) => set({ maxLeap: Number(e.target.value) })} />
          </label>
          <label>
            Highest fret <b>{req.maxFret}</b>
            <input type="range" min={5} max={22} value={req.maxFret} onChange={(e) => set({ maxFret: Number(e.target.value) })} />
          </label>
          <label>
            Prefer
            <select
              value={req.soft.direction ?? ""}
              onChange={(e) => {
                const { direction: _d, ...rest } = req.soft;
                void _d;
                set({ soft: e.target.value ? { ...rest, direction: e.target.value as "ascending" | "descending" | "arch" } : rest });
              }}
            >
              <option value="">no direction preference</option>
              <option value="ascending">ascending</option>
              <option value="descending">descending</option>
              <option value="arch">an arch (climax inside)</option>
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>Results</legend>
          <label>
            How many candidates
            <select value={req.candidates} onChange={(e) => set({ candidates: Number(e.target.value) })} data-testid="ph-count">
              {[5, 8, 12, 20, 30, 40].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <div className="ph-go">
          <button className="play" onClick={generate} disabled={busy} data-testid="ph-generate">
            {busy ? "Generating…" : "Generate candidates"}
          </button>
          <span className="muted">Hard constraints must hold; preferences only rank. The engine is deterministic: the same request gives the same candidates.</span>
        </div>
      </section>

      {failure && (
        <div className="panel error" role="alert" data-testid="ph-failure">
          {failure}
        </div>
      )}
      {transformNote && <p className="panel ph-note" data-testid="ph-transform-note">{transformNote}</p>}

      {/* ── 5-6: candidates, listen and compare ────────────────────────── */}
      {candidates.length > 0 && (
        <section className="panel" aria-label="Candidates">
          <h2>
            Candidates <small>{considered} combinations considered · ranked by transparent heuristics, not by beauty</small>
          </h2>
          <ol className="ph-cands" data-testid="ph-candidates">
            {candidates.map((c, i) => (
              <li key={`${c.id}-${i}`} className={candidate === c ? "active" : ""}>
                <div className="ph-cand-head">
                  <b>#{i + 1}</b>
                  <span className="ph-score" title="weighted mean of the named parts below">
                    {c.score.total.toFixed(2)}
                  </span>
                  <span className="ph-summary">{c.summary}</span>
                  <button
                    onClick={() => {
                      adopt(c, req);
                      setTimeout(() => void playerRef.current?.play().then(() => setPlaying(true)), 400);
                    }}
                  >
                    ▶ Listen
                  </button>
                  <button onClick={() => adopt(c, req)} disabled={candidate === c}>
                    {candidate === c ? "Selected" : "Select"}
                  </button>
                  <button onClick={() => setOpenScore(openScore === `${i}` ? null : `${i}`)}>why this score</button>
                </div>
                {openScore === `${i}` && (
                  <table className="ph-score-table">
                    <tbody>
                      {c.score.parts.map((p) => (
                        <tr key={p.name}>
                          <td>{p.name}</td>
                          <td>{p.value.toFixed(2)}</td>
                          <td>×{p.weight}</td>
                          <td className="muted">{p.why}</td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={4} className="muted">
                          {c.score.disclaimer}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {ir && schedule && (
        <>
          {loaded && (
            <div className="panel loaded-note" data-testid="ph-loaded">
              Showing <b>{loaded.name}</b>. You can inspect, analyse and edit its notes. Regenerating comes from the controls above.
            </div>
          )}

          <section className="panel transport" aria-label="Transport">
            <button className="play" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button onClick={rewind} aria-label="Stop and rewind">
              ⏹ Rewind
            </button>
            <span className="muted" data-testid="ph-audio">
              {ir.chords.map((c) => c.symbol).join(" → ")} · {ir.tempo?.bpm} BPM · rendered in {audioMs} ms · looping
            </span>
            <label className="zoom">
              Zoom
              <input type="range" min={40} max={300} value={pxPerSecond} onChange={(e) => setPxPerSecond(Number(e.target.value))} />
            </label>
          </section>

          <section className="panel">
            <h2>
              Rhythm and harmony <small>click a note to inspect it; click the background to move the playhead</small>
            </h2>
            <div className="ph-legend">
              <i className="ph-note ph-target" /> target arrival <i className="ph-note ph-outline" /> chord outline <i className="ph-note ph-embellish" /> approach / enclosure <i className="ph-note ph-bass" /> bass root
            </div>
            <PhraseRoll
              ir={ir}
              schedule={schedule}
              pxPerSecond={pxPerSecond}
              selected={selected}
              melodyVoice={MELODY}
              playheadRef={playheadRef}
              scrollRef={scrollRef}
              onSelect={setSelected}
              onSeek={(f) => playerRef.current?.seek(f)}
            />
          </section>

          <section className="panel">
            <h2>
              Fretboard <small>rings: the whole phrase · filled: sounding now, or the selected note</small>
            </h2>
            <Fretboard board={board} frets={Math.min(22, Math.max(req.maxFret + 2, 12))} notes={fretNotes} ghost={fretGhost.filter((g) => !fretNotes.some((n) => n.string === g.string && n.fret === g.fret))} showScale={false} />
          </section>

          {/* ── 7-8: inspect and change ──────────────────────────────────── */}
          <div className="ph-two">
            <section className="panel ph-inspect" aria-label="Note inspector" data-testid="ph-inspector">
              <h2>Inspect a note</h2>
              {!sel ? (
                <p className="muted">Select a note in the roll.</p>
              ) : (
                <>
                  <p>
                    <b className="ph-big">{sel.pitch.name}</b> · onset {fstr(parseFraction(sel.onset))} · length {fstr(parseFraction(sel.duration))}
                    {sel.instrument ? ` · string ${board.tuning.strings.length - sel.instrument.string}, fret ${sel.instrument.fret}` : ""}
                    {sel.provenance ? ` · ${sel.provenance.status}` : ""}
                  </p>
                  <dl className="ph-roles">
                    <dt>harmonic</dt>
                    <dd>{(selFunctions?.harmonic ?? (selFacts?.harmonic ? [selFacts.harmonic.role] : [])).join(", ") || "not a chord tone"}</dd>
                    <dt>melodic</dt>
                    <dd>{(selFunctions?.melodic ?? (sel.roles?.melodic ? [sel.roles.melodic] : [])).join(", ") || "—"}</dd>
                    <dt>metric</dt>
                    <dd>{selFunctions?.metric ?? selFacts?.metric.label ?? "—"}</dd>
                    <dt>structural</dt>
                    <dd>{(selFunctions?.structural ?? []).join(", ") || "—"}</dd>
                  </dl>
                  <h3>Built by</h3>
                  {selGestures.length === 0 ? (
                    <p className="muted">no recorded gesture</p>
                  ) : (
                    <ul className="ph-steps">
                      {selGestures.map((g) => (
                        <li key={g.id}>
                          <b>{g.kind}</b> <span className="muted">({g.provenance.status})</span>
                          <div>{g.steps.map(describeStep).join(" → ")}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>Readings from analysis</h3>
                  {selReadings.length === 0 ? (
                    <p className="muted">none: this note is {selFacts?.harmonic ? "a plain chord tone or tension" : "not explained by any figure"}</p>
                  ) : (
                    <ul className="ph-steps">
                      {selReadings.map((r) => (
                        <li key={r.id}>
                          <b>{r.kind}</b> <span className="muted">confidence {r.confidence.toFixed(2)}{r.alternatives.length ? ` · rivals: ${r.alternatives.join(", ")}` : ""}</span>
                          <ul>
                            {r.evidence.map((e, k) => (
                              <li key={k}>{e}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>Change it</h3>
                  <div className="ph-edit">
                    <button onClick={() => edit({ midi: sel.pitch.midi - 12 })}>−8ve</button>
                    <button onClick={() => edit({ midi: sel.pitch.midi - 1 })}>−1</button>
                    <button onClick={() => edit({ midi: sel.pitch.midi + 1 })}>+1</button>
                    <button onClick={() => edit({ midi: sel.pitch.midi + 12 })}>+8ve</button>
                    <label>
                      length
                      <select value={fstr(parseFraction(sel.duration))} onChange={(e) => edit({ duration: e.target.value })}>
                        {[...new Set([fstr(parseFraction(sel.duration)), ...DURATIONS])].map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                    <button onClick={() => edit({ onsetShift: "-1/16" })}>◀ 1/16</button>
                    <button onClick={() => edit({ onsetShift: "1/16" })}>1/16 ▶</button>
                  </div>
                  {editError.length > 0 && (
                    <div className="panel error" role="alert" data-testid="ph-edit-error">
                      <b>That edit would make the document invalid, so it was refused:</b>
                      <ul>
                        {editError.slice(0, 5).map((i, k) => (
                          <li key={k}>{i.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="panel" aria-label="Construction and transformations">
              <h2>Construction</h2>
              <ol className="ph-steps" data-testid="ph-construction">
                {(ir.semantics?.gestures ?? []).map((g) => (
                  <li key={g.id}>
                    <b>{g.kind}</b> <span className="muted">· {g.provenance.status} · notes {g.notes.join(" ")}</span>
                    <div>{g.steps.map(describeStep).join(" → ")}</div>
                  </li>
                ))}
              </ol>
              <h3>Transform while holding part fixed</h3>
              <div className="ph-edit">
                <button onClick={keepRhythm} disabled={busy || !candidate || edited} data-testid="ph-keep-rhythm">
                  Keep the rhythm, new pitches
                </button>
                <button onClick={keepPitches} disabled={busy || !candidate || edited} data-testid="ph-keep-pitches">
                  Keep the pitches, new rhythm
                </button>
              </div>
              <p className="muted">
                {edited ? "This phrase has been edited by hand, so its construction is history, not a promise; generate again to transform." : !candidate ? "Generate or select a candidate to transform it." : "The second one uses the rhythm settings above (try “accelerating”)."}
              </p>
              <h3>Analysis</h3>
              <label className="check">
                <input type="checkbox" checked={attachAnalysis} onChange={(e) => setAttachAnalysis(e.target.checked)} /> save the analysis with the document
              </label>
              <ul className="ph-steps" data-testid="ph-analysis">
                {(analysis?.interpretations ?? []).map((r) => (
                  <li key={r.id}>
                    <b>{r.kind}</b> <span className="muted">{r.confidence.toFixed(2)} · {r.notes.join(" ")}</span>
                  </li>
                ))}
              </ul>
              {analysis && analysis.unresolved.length > 0 && <p className="muted">Unexplained non-chord tones: {analysis.unresolved.map((u) => u.note).join(", ")}</p>}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

/** Add two exact fraction strings (kept here only to shift an onset by a fixed step). */
function addFraction(a: string, b: string) {
  const x = parseFraction(a);
  const y = parseFraction(b);
  return frac(x.num * y.den + y.num * x.den, x.den * y.den);
}
