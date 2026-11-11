"use client";

import { FolderOpen, Save as SaveIcon, SkipBack, Pause, Play, Square, Music2, SlidersHorizontal, ChevronDown, ChevronRight, ChevronLeft, Info, EllipsisVertical } from "lucide-react";
import { IC, IC_SM } from "../ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeMelody,
  BAND_NAMES,
  CONTOUR_CHOICES,
  DEFAULT_PHRASE_REQUEST,
  DENSITIES,
  developRequest,
  editPhraseNote,
  explorePhrases,
  formatPitch,
  fnum,
  frac,
  fstr,
  generationSpaceFromRequest,
  irTuning,
  LENGTHS,
  makeFretboard,
  makeTuning,
  midi,
  parseFraction,
  parseMusicIR,
  parsePhraseRequest,
  phraseToIR,
  PLUCK_TONES,
  progressionFor,
  renderDocument,
  RHYTHM_CHARACTERS,
  scheduleFrames,
  serializeMusicIR,
  spellInSpace,
  STANDARD_TUNING,
  STRATEGIES,
  targetOptions,
  withInterpretations,
  type ExploreStats,
  type ExploredPhrase,
  type IRIssue,
  type IRNoteEvent,
  type LockAspect,
  type MusicIR,
  type PhraseRequest,
} from "@musical-lab/engine";
import Fretboard, { type DisplayNote, type Role } from "../Fretboard";
import { LabPlayer } from "../lab/player";
import PhraseRoll, { noteKind } from "./PhraseRoll";
import Modal from "../ui/Modal";
import Tabs from "../ui/Tabs";
import { Topbar } from "../ui/shellContext";

const TONICS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const DURATIONS = ["1/16", "1/12", "1/8", "3/16", "1/6", "1/4", "3/8", "1/2", "3/4", "1"];
const COUNTS = [3, 5, 6, 7, 8, 10, 12];
const MELODY = "melody";
const midiName = (m: number): string => formatPitch(spellInSpace(m, { scale: [] }));
const REGISTER = Array.from({ length: 49 }, (_, i) => 40 + i);

const LOCKS: { aspect: LockAspect; label: string; hint: string }[] = [
  { aspect: "target", label: "target", hint: "same degree and the same octave" },
  { aspect: "register", label: "register", hint: "same octave band" },
  { aspect: "strategy", label: "melodic strategy", hint: "same outline / embellishment" },
  { aspect: "rhythm", label: "rhythm", hint: "every onset and length exactly" },
  { aspect: "contour", label: "contour", hint: "the same up/down shape" },
  { aspect: "density", label: "density", hint: "same notes per beat class" },
  { aspect: "length", label: "length", hint: "same phrase length" },
];

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

/** "explore all" or one value: the UI form of a dimension of the generation space. */
function Dim<T extends string>({ label, value, options, onChange, testid, all = "explore all" }: { label: string; value: readonly T[] | "all"; options: readonly { id: T; name: string }[]; onChange: (v: readonly T[] | "all") => void; testid: string; all?: string }) {
  const current = value === "all" || value.length !== 1 ? "" : value[0]!;
  return (
    <label className="field">
      <span>{label}</span>
      <select value={current} onChange={(e) => onChange(e.target.value === "" ? "all" : [e.target.value as T])} data-testid={testid}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function PhraseConstructor({ active = true }: { active?: boolean }) {
  const playerRef = useRef<LabPlayer | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastTotal = useRef(0);

  const [req, setReq] = useState<PhraseRequest>(DEFAULT_PHRASE_REQUEST);
  const [sampleRate, setSampleRate] = useState(44100);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ExploredPhrase[]>([]);
  const [stats, setStats] = useState<ExploreStats | null>(null);
  const [candidate, setCandidate] = useState<ExploredPhrase | null>(null);
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
  const [note, setNote] = useState("");
  const [openScore, setOpenScore] = useState<string | null>(null);
  const [audioMs, setAudioMs] = useState(0);
  const [locks, setLocks] = useState<LockAspect[]>(["target"]);
  const [stage, setStage] = useState<"roll" | "board" | "both">("both");
  const [modal, setModal] = useState<null | "space" | "develop" | "inspect" | "analysis" | "stats" | "detail" | "settings">(null);
  const [spaceTab, setSpaceTab] = useState<"targets" | "melody" | "constraints" | "results">("targets");
  const [analysisTab, setAnalysisTab] = useState<"construction" | "analysis">("construction");
  const [menuOpen, setMenuOpen] = useState(false);
  const [chordIdx, setChordIdx] = useState(-1);
  const closeModal = useCallback(() => setModal(null), []);

  const targets = useMemo(() => targetOptions(req.tonic, req.mode), [req.tonic, req.mode]);
  const e = req.exploration;
  const setE = (patch: Partial<PhraseRequest["exploration"]>) => setReq((r) => ({ ...r, exploration: { ...r.exploration, ...patch } }));

  // ── audio ────────────────────────────────────────────────────────────────
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
        const now = p.isPlaying ? schedule.events.filter((ev) => ev.voice === MELODY && ev.startFrame <= frame && frame < ev.endFrame).map((ev) => ev.id) : [];
        const key = now.join(",");
        if (key !== lastKey) {
          lastKey = key;
          setSounding(now);
        }
        const ci = p.isPlaying ? schedule.chords.findIndex((c) => frame >= c.startFrame && frame < c.endFrame) : -1;
        setChordIdx((prev) => (prev === ci ? prev : ci));
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

  // ── exploring, choosing, developing ──────────────────────────────────────
  const adopt = useCallback((c: ExploredPhrase, forReq: PhraseRequest) => {
    const doc = phraseToIR(c, c.spec, { bpm: forReq.bpm, request: forReq as unknown as Record<string, unknown> });
    setCandidate(c);
    setIr(doc);
    setEdited(false);
    setLoaded(null);
    setSelected(c.targetNote);
    setEditError([]);
    setLoadError([]);
  }, []);

  const explore = (forReq: PhraseRequest, message = "") => {
    setBusy(true);
    setFailure(null);
    setNote("");
    setTimeout(() => {
      const r = explorePhrases(generationSpaceFromRequest(forReq));
      if (!r.ok) {
        setFailure(r.reason);
        setBusy(false);
        return;
      }
      setReq(forReq);
      setCandidates([...r.candidates]);
      setStats(r.stats);
      adopt(r.candidates[0]!, forReq);
      setNote(message);
      setBusy(false);
    }, 20);
  };

  const generate = () => explore(req);
  const newSeed = () => explore({ ...req, exploration: { ...e, seed: e.seed + 1 } }, `New seed ${e.seed + 1}: a different, equally reproducible set.`);
  const develop = () => {
    if (!candidate) return;
    const next = developRequest(req, candidate, locks);
    explore(next, locks.length ? `Variations of phrase ${candidate.id.replace("phrase-", "#")} with ${locks.join(", ")} held fixed (seed ${next.exploration.seed}).` : `Seed ${next.exploration.seed}: nothing locked.`);
  };

  // ── editing one note ─────────────────────────────────────────────────────
  const edit = (change: { midi?: number; duration?: string; onsetShift?: string }) => {
    if (!ir || !selected) return;
    const ev = ir.events.find((x): x is IRNoteEvent => x.kind === "note" && x.id === selected);
    if (!ev) return;
    const res = editPhraseNote(
      ir,
      selected,
      {
        ...(change.midi !== undefined ? { midi: change.midi } : {}),
        ...(change.duration ? { duration: parseFraction(change.duration) } : {}),
        ...(change.onsetShift ? { onset: addFraction(ev.onset, change.onsetShift) } : {}),
      },
      { scale: [] },
    );
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
    a.download = `phrase-${req.tonic}-${req.mode}-seed${e.seed}.musicir.json`;
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
    // restore the controls (including the seed and locks) that produced it, if the file says what they were
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
    setStats(null);
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
  const melody = useMemo(() => (ir ? ir.events.filter((x): x is IRNoteEvent => x.kind === "note" && x.voice === MELODY) : []), [ir]);
  const toDisplay = useCallback(
    (n: IRNoteEvent): DisplayNote | null => (n.instrument && ir ? { string: n.instrument.string, fret: n.instrument.fret, role: roleOf(ir, n), label: n.pitch.name.replace(/-?\d+$/, ""), pitch: n.pitch.name } : null),
    [ir],
  );
  const shownIds = sounding.length ? sounding : selected ? [selected] : [];
  const fretNotes = melody.filter((n) => shownIds.includes(n.id)).map(toDisplay).filter((x): x is DisplayNote => x !== null);
  const fretGhost = melody.map(toDisplay).filter((x): x is DisplayNote => x !== null);

  const sel = ir?.events.find((x): x is IRNoteEvent => x.kind === "note" && x.id === selected) ?? null;
  const selFunctions = ir?.semantics?.noteFunctions?.find((f) => f.note === selected);
  const selGestures = ir?.semantics?.gestures?.filter((g) => selected && (g.notes.includes(selected) || ir.semantics?.targets?.some((t) => t.id === g.target && t.note === selected))) ?? [];
  const selReadings = analysis?.interpretations.filter((i) => selected && i.notes.includes(selected)) ?? [];
  const selFacts = analysis?.facts.find((f) => f.id === selected);

  const regLo = req.register[0];
  const regHi = req.register[1];
  const set = (patch: Partial<PhraseRequest>) => setReq((r) => ({ ...r, ...patch }));
  const prog = useMemo(() => progressionFor(req.tonic, req.mode), [req.tonic, req.mode]);
  const targetChoice = e.mode === "focus" ? `focus:${e.focusDegree}` : "explore";
  const onTarget = (v: string) => (v === "explore" ? setE({ mode: "explore" }) : setE({ mode: "focus", focusDegree: v.slice(6) }));
  const hasLocks = !!(e.locks && Object.keys(e.locks).length > 0);
  const lockText = [
    e.locks?.targetPitch !== undefined ? `target pitch ${midiName(e.locks.targetPitch)}` : null,
    e.locks?.rhythmPlan ? "rhythm (every onset and length)" : null,
    e.locks?.contourShape !== undefined ? `contour shape ${e.locks.contourShape || "(none)"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  /** Tempo applies at once: the document's own tempo changes, so the audio re-renders from the same position. */
  const setTempo = (bpm: number) => {
    set({ bpm });
    setIr((cur) => (cur && cur.tempo ? { ...cur, tempo: { ...cur.tempo, bpm: String(bpm) } } : cur));
  };
  const exploreAllDegrees = e.degrees === "all";
  const naturalDegrees = targets.options.filter((o) => o.kind !== "alteration").map((o) => o.degree);
  const activeDegrees = exploreAllDegrees ? naturalDegrees : (e.degrees as readonly string[]);

  return (
    <div className="wb">
      <Topbar active={active}>
        <button className="tool-btn" onClick={rewind} aria-label="Back to the start" title="Back to the start" disabled={!ir}>
          <SkipBack {...IC} />
        </button>
        <button className="tool-btn primary" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"} disabled={!ir} data-testid="ph-play">
          {playing ? <Pause {...IC} /> : <Play {...IC} />}
        </button>
        <button className="tool-btn" onClick={rewind} aria-label="Stop and rewind" title="Stop" disabled={!ir}>
          <Square {...IC} />
        </button>
        <span className="pill" title="Tempo (quarter notes per minute)">
          <Music2 {...IC} />
          <input type="number" min={50} max={200} value={req.bpm} onChange={(ev) => setTempo(Math.max(50, Math.min(200, Number(ev.target.value) || 100)))} aria-label="Tempo" data-testid="ph-bpm" />
        </span>
        <span className="pill pill-opt" title="The harmony is a ii–V–I, one bar per chord">
          4/4
        </span>
        <span className="pill pill-opt muted" data-testid="ph-audio" title="rendering time of the audio">
          {ir ? `${audioMs} ms` : "—"}
        </span>
        <button className="tool-btn" onClick={() => fileRef.current?.click()} title="Open a MusicIR document" data-testid="ph-open">
          <FolderOpen {...IC} />
          <span className="lbl">Open</span>
        </button>
        <button className="tool-btn" onClick={save} disabled={!ir} title="Save the phrase as a MusicIR document" data-testid="ph-save">
          <SaveIcon {...IC} />
          <span className="lbl">Save</span>
        </button>
        <button className="tool-btn" onClick={() => setModal("settings")} aria-label="View settings" title="View settings" data-testid="ph-settings">
          <SlidersHorizontal {...IC} />
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(ev) => void onFile(ev.target.files?.[0])} data-testid="ph-file" />
      </Topbar>

      <section className="wb-controls" aria-label="Phrase request">
        <label className="field">
          <span>Key</span>
          <select value={req.tonic} onChange={(ev) => set({ tonic: ev.target.value })} data-testid="ph-key">
            {TONICS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scale / mode</span>
          <select value={req.mode} onChange={(ev) => set({ mode: ev.target.value as "major" | "minor" })} data-testid="ph-scale">
            <option value="major">major ii–V–I</option>
            <option value="minor">minor ii–V–i</option>
          </select>
        </label>
        <label className="field">
          <span>Target on {targets.chord}</span>
          <select value={targetChoice} onChange={(ev) => onTarget(ev.target.value)} data-testid="ph-target">
            <option value="explore">Explore every target</option>
            {targets.options.map((o) => (
              <option key={o.degree} value={`focus:${o.degree}`}>
                Focus: {o.note} · {o.role}
                {o.kind === "alteration" ? " (alt)" : o.kind === "extension" ? " (ext)" : ""}
              </option>
            ))}
          </select>
        </label>
        <Dim label="Strategy" value={e.strategies} options={STRATEGIES.map((s) => ({ id: s.id, name: s.name }))} onChange={(v) => setE({ strategies: v })} testid="ph-strategies" all="Explore all" />
        <Dim label="Rhythm" value={e.rhythms} options={RHYTHM_CHARACTERS.map((r) => ({ id: r.id, name: r.name }))} onChange={(v) => setE({ rhythms: v })} testid="ph-rhythms" all="Explore all" />
        <Dim label="Density" value={e.densities} options={DENSITIES.map((d) => ({ id: d, name: d }))} onChange={(v) => setE({ densities: v })} testid="ph-densities" all="Explore all" />
        <div className="split">
          <button className="main" onClick={generate} disabled={busy} data-testid="ph-generate">
            {busy ? "Exploring…" : e.mode === "explore" ? "Explore" : "Generate"}
          </button>
          <button className="caret" onClick={() => setMenuOpen((o) => !o)} aria-label="More generate options" aria-expanded={menuOpen} data-testid="ph-generate-menu">
            <ChevronDown {...IC} />
          </button>
          {menuOpen && (
            <div className="menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  newSeed();
                }}
                disabled={busy || candidates.length === 0}
                data-testid="ph-newseed"
              >
                Another set (next seed)
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setModal("space");
                }}
                data-testid="ph-space-open"
              >
                Generation space…
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="wb-chords" aria-label="Harmony">
        <span className="label">Chords</span>
        <div className="chord-row" data-testid="ph-chords">
          {prog.map((p, i) => (
            <div key={i} className={`chord-chip${chordIdx === i ? " active" : ""}${i === prog.length - 1 ? " target" : ""}`} title={i === prog.length - 1 ? "the chord the phrase arrives on" : p.roman}>
              <b>{p.chord.symbol}</b>
              <small>
                | {i + 1} · {p.roman}
              </small>
            </div>
          ))}
        </div>
        <div className="wb-chords-right">
          <Dim label="Length" value={e.lengths} options={LENGTHS.map((l) => ({ id: l, name: l === "short" ? "2 beats" : l === "standard" ? "1 bar" : "1½ bars" }))} onChange={(v) => setE({ lengths: v })} testid="ph-lengths" all="Any" />
          <label className="field">
            <span>Variations</span>
            <select value={e.count} onChange={(ev) => setE({ count: Number(ev.target.value) })} data-testid="ph-count">
              {COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button className="tool-btn" onClick={() => setModal("space")} aria-label="Generation space" title="All the dimensions and constraints" data-testid="ph-space">
            <SlidersHorizontal {...IC} />
          </button>
        </div>
      </section>

      <div className="wb-messages">
        {loadError.length > 0 && (
          <div className="banner error" role="alert" data-testid="ph-load-error">
            <b>That file is not usable, so nothing was loaded.</b> {loadError.slice(0, 4).map((i) => `${i.path || "(document)"}: ${i.message}`).join(" · ")}
          </div>
        )}
        {failure && (
          <div className="banner error" role="alert" data-testid="ph-failure">
            {failure}
          </div>
        )}
        {note && (
          <p className="banner" data-testid="ph-transform-note">
            {note}
          </p>
        )}
        {loaded && ir && (
          <div className="banner" data-testid="ph-loaded">
            Showing <b>{loaded.name}</b>. You can inspect, analyse and edit its notes. Exploring again uses the controls above.
          </div>
        )}
        {hasLocks && (
          <div className="banner" data-testid="ph-active-locks">
            <b>Locked from the phrase you developed:</b> {lockText}. Every exploration keeps these until you clear them.
            <button className="btn small" onClick={() => setE({ locks: undefined })} data-testid="ph-clear-locks">
              Clear locks
            </button>
          </div>
        )}
      </div>

      <div className="wb-main">
        <section className="card wb-left" aria-label="Phrase">
          <div className="wb-left-head">
            <Tabs
              label="Phrase view"
              value={stage}
              onChange={setStage}
              tabs={[
                { id: "roll", label: "Roll", testId: "ph-tab-roll" },
                { id: "board", label: "Fretboard", testId: "ph-tab-board" },
                { id: "both", label: "Both", testId: "ph-tab-both" },
              ]}
            />
            <div className="wb-toolbar">
              {sel && (
                <span className="sel-note" data-testid="ph-selected">
                  <b>{sel.pitch.name}</b> selected
                  <button className="btn small" onClick={() => setModal("inspect")} data-testid="ph-inspect-open">
                    Inspect <ChevronRight {...IC_SM} />
                  </button>
                </span>
              )}
              {stage !== "board" && (
                <label>
                  Zoom <input type="range" min={40} max={300} value={pxPerSecond} onChange={(ev) => setPxPerSecond(Number(ev.target.value))} aria-label="Zoom" />
                </label>
              )}
            </div>
          </div>
          {!ir || !schedule ? (
            <div className="stage-empty" data-testid="ph-empty">
              <div>
                <b>No phrase yet</b>
                Choose a key and what to explore, then press Explore. Every result is verified before it is shown, and the same settings and seed always give the same phrases.
              </div>
            </div>
          ) : (
            <div className="wb-stage">
              {stage !== "board" && (
                <div className="stage-pane roll">
                  <div className="ph-legend">
                    <i className="ph-note ph-target" /> target arrival <i className="ph-note ph-outline" /> chord outline <i className="ph-note ph-embellish" /> approach / enclosure / run <i className="ph-note ph-bass" /> bass root
                  </div>
                  <PhraseRoll ir={ir} schedule={schedule} pxPerSecond={pxPerSecond} selected={selected} melodyVoice={MELODY} playheadRef={playheadRef} scrollRef={scrollRef} onSelect={setSelected} onSeek={(f) => playerRef.current?.seek(f)} />
                </div>
              )}
              {stage !== "roll" && (
                <div className="stage-pane board">
                  <Fretboard board={board} frets={22} notes={fretNotes} ghost={fretGhost.filter((g) => !fretNotes.some((n) => n.string === g.string && n.fret === g.fret))} showScale={false} />
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="card wb-right" aria-label="Alternatives">
          <div className="wb-right-head">
            <h2 data-testid="ph-alt-title">Alternatives ({candidates.length})</h2>
            {stats && (
              <button className="icon-btn" onClick={() => setModal("stats")} aria-label="How these were chosen" title="How these were chosen" data-testid="ph-stats-open">
                <Info {...IC} />
              </button>
            )}
          </div>
          {stats?.note && (
            <p className="banner" data-testid="ph-fewer">
              {stats.note}
            </p>
          )}
          {candidates.length === 0 ? (
            <p className="hint">{loaded ? "A loaded document has no alternatives." : "Contrasting phrases will appear here, each differing in target, register, strategy, contour or rhythm."}</p>
          ) : (
            <ol className="wb-alts" data-testid="ph-candidates">
              {candidates.map((c, i) => (
                <li key={`${c.id}-${i}`} className={`alt${candidate === c ? " active" : ""}`} onClick={() => adopt(c, req)} data-alt={i + 1}>
                  <button
                    className="alt-play"
                    aria-label={`Listen to phrase ${i + 1}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      adopt(c, req);
                      setTimeout(() => void playerRef.current?.play().then(() => setPlaying(true)), 400);
                    }}
                    data-testid={`ph-listen-${i + 1}`}
                  >
                    <Play {...IC_SM} />
                  </button>
                  <div className="alt-mid">
                    <Spark c={c} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <span className="alt-no">{i + 1}</span>
                    <button
                      className="alt-more"
                      aria-label={`Details of phrase ${i + 1}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setOpenScore(`${i}`);
                        setModal("detail");
                      }}
                      data-testid={`ph-detail-${i + 1}`}
                    >
                      <EllipsisVertical {...IC} />
                    </button>
                  </div>
                  <div className="alt-chips">
                    {c.chips.slice(0, 3).map((chip) => (
                      <span key={chip} className="ph-chip">
                        {chip}
                      </span>
                    ))}
                  </div>
                  <div className="alt-how">{c.summary}</div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      <footer className="wb-bottom">
        <div className="seg" role="group" aria-label="Actions">
          <button className="primary" onClick={generate} disabled={busy} data-testid="ph-generate-bottom">
            Generate
          </button>
          <button onClick={() => setModal("develop")} disabled={!ir} data-testid="ph-develop-open">
            Develop
          </button>
          <button onClick={() => setModal("inspect")} disabled={!ir} data-testid="ph-inspect-tab">
            Inspect
          </button>
          <button onClick={() => setModal("analysis")} disabled={!ir} data-testid="ph-analysis-open">
            Analysis
          </button>
        </div>
        <div className="bottom-right">
          <span className="muted">
            seed <b>{e.seed}</b>
          </span>
          <button className="btn" onClick={newSeed} disabled={busy || candidates.length === 0} data-testid="ph-newseed-bottom">
            Another set <ChevronRight {...IC_SM} />
          </button>
        </div>
      </footer>

      {/* ── modals ─────────────────────────────────────────────────────────── */}
      <Modal open={modal === "space"} onClose={closeModal} title="Generation space" size="wide" testId="ph-space-modal" footer={<button className="btn primary" onClick={closeModal}>Done</button>}>
        <Tabs
          label="Generation space"
          value={spaceTab}
          onChange={setSpaceTab}
          tabs={[
            { id: "targets", label: "Targets", testId: "ph-space-targets" },
            { id: "melody", label: "Melody", testId: "ph-space-melody" },
            { id: "constraints", label: "Constraints", testId: "ph-space-constraints" },
            { id: "results", label: "Results", testId: "ph-space-results" },
          ]}
        />
        <div style={{ marginTop: 14 }}>
          {spaceTab === "targets" && (
            <div className="form-grid">
              <div className="span-all">
                <p className="hint">Explore tries the targets ticked here (none ticked means every compatible chord tone and natural extension of {targets.chord}). Choosing a single target in the Target menu locks it instead.</p>
              </div>
              <div className="span-all deg-grid" data-testid="ph-degrees">
                {targets.options.map((o) => (
                  <label key={o.degree} title={`${o.role}${o.kind === "chord-tone" ? "" : ` (${o.kind})`}`}>
                    <input
                      type="checkbox"
                      checked={activeDegrees.includes(o.degree)}
                      disabled={e.mode === "focus"}
                      onChange={(ev) => {
                        const next = ev.target.checked ? [...activeDegrees, o.degree] : activeDegrees.filter((d) => d !== o.degree);
                        setE({ degrees: next.length === 0 ? "all" : next });
                      }}
                    />
                    {o.note}
                    <small>{o.degree}</small>
                  </label>
                ))}
              </div>
              <Dim label="Octave" value={e.bands} options={BAND_NAMES.map((b) => ({ id: b, name: `${b} register` }))} onChange={(v) => setE({ bands: v })} testid="ph-bands" />
            </div>
          )}
          {spaceTab === "melody" && (
            <div className="form-grid">
              <Dim label="Melodic strategy" value={e.strategies} options={STRATEGIES.map((s) => ({ id: s.id, name: s.name }))} onChange={(v) => setE({ strategies: v })} testid="ph-strategies-modal" />
              <Dim label="Contour" value={e.contours} options={CONTOUR_CHOICES.filter((c) => c !== "any").map((c) => ({ id: c, name: c }))} onChange={(v) => setE({ contours: v })} testid="ph-contours" />
              <Dim label="Rhythmic character" value={e.rhythms} options={RHYTHM_CHARACTERS.map((r) => ({ id: r.id, name: r.name }))} onChange={(v) => setE({ rhythms: v })} testid="ph-rhythms-modal" />
              <Dim label="Density" value={e.densities} options={DENSITIES.map((d) => ({ id: d, name: d }))} onChange={(v) => setE({ densities: v })} testid="ph-densities-modal" />
              <Dim label="Phrase length" value={e.lengths} options={LENGTHS.map((l) => ({ id: l, name: l === "short" ? "short (2 beats)" : l === "standard" ? "standard (1 bar)" : "long (1½ bars, two chords)" }))} onChange={(v) => setE({ lengths: v })} testid="ph-lengths-modal" />
              <p className="hint span-all">A dimension left on “explore all” is varied across its values; pick one to lock it. Fewer phrases are returned rather than near-duplicates.</p>
            </div>
          )}
          {spaceTab === "constraints" && (
            <div className="form-grid">
              <label className="field">
                <span>Lowest note</span>
                <select value={regLo} onChange={(ev) => set({ register: [Math.min(Number(ev.target.value), regHi), regHi] })}>
                  {REGISTER.map((m) => (
                    <option key={m} value={m}>
                      {midiName(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Highest note</span>
                <select value={regHi} onChange={(ev) => set({ register: [regLo, Math.max(Number(ev.target.value), regLo)] })}>
                  {REGISTER.map((m) => (
                    <option key={m} value={m}>
                      {midiName(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>
                  Largest leap <b>{req.maxLeap}</b> semitones
                </span>
                <input type="range" min={2} max={14} value={req.maxLeap} onChange={(ev) => set({ maxLeap: Number(ev.target.value) })} />
              </label>
              <label className="field">
                <span>
                  Highest fret <b>{req.maxFret}</b>
                </span>
                <input type="range" min={5} max={22} value={req.maxFret} onChange={(ev) => set({ maxFret: Number(ev.target.value) })} />
              </label>
            </div>
          )}
          {spaceTab === "results" && (
            <div className="form-grid">
              <label className="field">
                <span>Contrasting phrases (at most)</span>
                <select value={e.count} onChange={(ev) => setE({ count: Number(ev.target.value) })} data-testid="ph-count-modal">
                  {COUNTS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Seed</span>
                <input type="number" min={0} value={e.seed} onChange={(ev) => setE({ seed: Math.max(0, Math.floor(Number(ev.target.value) || 0)) })} data-testid="ph-seed" />
              </label>
              <p className="hint span-all">The same settings and seed always give the same phrases. “Another set” moves to the next seed.</p>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={modal === "develop"}
        onClose={closeModal}
        title={candidate ? `Develop phrase ${candidate.id.replace("phrase-", "#")}` : "Develop"}
        testId="ph-develop"
        footer={
          <>
            <button className="btn" onClick={closeModal}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || !candidate || edited || !!loaded}
              onClick={() => {
                closeModal();
                develop();
              }}
              data-testid="ph-develop-go"
            >
              Develop variations
            </button>
          </>
        }
      >
        {candidate && !edited && !loaded ? (
          <>
            <p className="hint" style={{ marginBottom: 12 }}>Lock what you like about this phrase and explore variations of the rest.</p>
            <div className="lock-grid">
              {LOCKS.map((l) => (
                <label key={l.aspect} title={l.hint}>
                  <input type="checkbox" checked={locks.includes(l.aspect)} onChange={(ev) => setLocks((cur) => (ev.target.checked ? [...cur, l.aspect] : cur.filter((a) => a !== l.aspect)))} data-testid={`ph-lock-${l.aspect}`} />
                  <span>
                    <b>keep {l.label}</b>
                    <small>{l.hint}</small>
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="hint">Develop works on a generated phrase that has not been edited by hand. Select one of the alternatives first{edited ? " (this one has been edited)" : ""}.</p>
        )}
      </Modal>

      <Modal open={modal === "inspect"} onClose={closeModal} title="Inspect a note" testId="ph-inspector" size="normal">
        {!sel || !ir ? (
          <p className="hint">Select a note in the roll, then open this again.</p>
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
              <p className="hint">no recorded gesture</p>
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
              <p className="hint">none: this note is {selFacts?.harmonic ? "a plain chord tone or tension" : "not explained by any figure"}</p>
            ) : (
              <ul className="ph-steps">
                {selReadings.map((r) => (
                  <li key={r.id}>
                    <b>{r.kind}</b>{" "}
                    <span className="muted">
                      confidence {r.confidence.toFixed(2)}
                      {r.alternatives.length ? ` · rivals: ${r.alternatives.join(", ")}` : ""}
                    </span>
                    <ul>
                      {r.evidence.map((x, k) => (
                        <li key={k}>{x}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            <h3>Change it</h3>
            <div className="ph-edit">
              <button className="btn small" onClick={() => edit({ midi: sel.pitch.midi - 12 })}>−8ve</button>
              <button className="btn small" onClick={() => edit({ midi: sel.pitch.midi - 1 })}>−1</button>
              <button className="btn small" onClick={() => edit({ midi: sel.pitch.midi + 1 })}>+1</button>
              <button className="btn small" onClick={() => edit({ midi: sel.pitch.midi + 12 })}>+8ve</button>
              <label>
                length{" "}
                <select value={fstr(parseFraction(sel.duration))} onChange={(ev) => edit({ duration: ev.target.value })}>
                  {[...new Set([fstr(parseFraction(sel.duration)), ...DURATIONS])].map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <button className="btn small" onClick={() => edit({ onsetShift: "-1/16" })}><ChevronLeft {...IC_SM} /> 1/16</button>
              <button className="btn small" onClick={() => edit({ onsetShift: "1/16" })}>1/16 <ChevronRight {...IC_SM} /></button>
            </div>
            {editError.length > 0 && (
              <div className="banner error" role="alert" data-testid="ph-edit-error">
                <b>That edit would make the document invalid, so it was refused:</b> {editError.slice(0, 5).map((i) => i.message).join(" · ")}
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal open={modal === "analysis"} onClose={closeModal} title="Construction and analysis" size="wide" testId="ph-analysis-modal">
        <Tabs
          label="Analysis"
          value={analysisTab}
          onChange={setAnalysisTab}
          tabs={[
            { id: "construction", label: "Construction", testId: "ph-an-construction" },
            { id: "analysis", label: "Analysis", testId: "ph-an-analysis" },
          ]}
        />
        {ir && analysisTab === "construction" && (
          <div style={{ marginTop: 12 }}>
            <ol className="ph-steps" data-testid="ph-construction">
              {(ir.semantics?.gestures ?? []).map((g) => (
                <li key={g.id}>
                  <b>{g.kind}</b>{" "}
                  <span className="muted">
                    · {g.provenance.status} · notes {g.notes.join(" ")}
                  </span>
                  <div>{g.steps.map(describeStep).join(" → ")}</div>
                </li>
              ))}
            </ol>
            {edited && <p className="hint">This phrase has been edited by hand, so its construction is history, not a promise; explore again to develop a phrase.</p>}
          </div>
        )}
        {ir && analysisTab === "analysis" && (
          <div style={{ marginTop: 12 }}>
            <ul className="ph-steps" data-testid="ph-analysis">
              {(analysis?.interpretations ?? []).map((r) => (
                <li key={r.id}>
                  <b>{r.kind}</b>{" "}
                  <span className="muted">
                    {r.confidence.toFixed(2)} · {r.notes.join(" ")}
                  </span>
                </li>
              ))}
            </ul>
            {analysis && analysis.unresolved.length > 0 && <p className="hint">Unexplained non-chord tones: {analysis.unresolved.map((u) => u.note).join(", ")}</p>}
          </div>
        )}
      </Modal>

      <Modal open={modal === "stats" && !!stats} onClose={closeModal} title="How these phrases were chosen" testId="ph-stats-modal">
        {stats && (
          <>
            <p className="ph-stats" data-testid="ph-stats">
              {stats.intentionsTried} intentions tried, {stats.intentionsReachable} reachable → {stats.poolSize} phrases, all verified ({stats.rejectedInvalid} rejected) → {stats.exactDuplicates} exact and {stats.nearDuplicates} near duplicates removed → {stats.selected} kept. Closest pair: distance {stats.minDistance} (a near duplicate is below {stats.threshold}); on average {stats.meanDistance}.
            </p>
            <p>
              Covers {stats.coverage.targets} target degrees, {stats.coverage.registers} registers, {stats.coverage.strategies} strategy families, {stats.coverage.rhythms} rhythmic characters, {stats.coverage.contours} contours. Seed {stats.seed}.
            </p>
            <p className="hint">Scores measure adherence to the stated heuristics, not beauty.</p>
          </>
        )}
      </Modal>

      <Modal open={modal === "detail" && openScore !== null && !!candidates[Number(openScore)]} onClose={closeModal} title={`Phrase ${Number(openScore) + 1}`} testId="ph-detail-modal">
        {openScore !== null && candidates[Number(openScore)] && (
          <>
            <p>{candidates[Number(openScore)]!.summary}</p>
            <p className="ph-distinct">{candidates[Number(openScore)]!.distinguishing.join(" · ")}</p>
            <table className="ph-score-table">
              <tbody>
                {candidates[Number(openScore)]!.score.parts.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{p.value.toFixed(2)}</td>
                    <td>×{p.weight}</td>
                    <td className="muted" style={{ whiteSpace: "normal" }}>{p.why}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="muted" style={{ whiteSpace: "normal" }}>
                    {candidates[Number(openScore)]!.score.disclaimer}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </Modal>

      <Modal open={modal === "settings"} onClose={closeModal} title="Settings" size="narrow" testId="ph-settings-modal" footer={<button className="btn primary" onClick={closeModal}>Done</button>}>
        <div className="form-grid">
          <label className="field span-all">
            <span>
              Roll zoom <b>{pxPerSecond}</b> px per second
            </span>
            <input type="range" min={40} max={300} value={pxPerSecond} onChange={(ev) => setPxPerSecond(Number(ev.target.value))} />
          </label>
          <label className="field span-all" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <input type="checkbox" checked={attachAnalysis} onChange={(ev) => setAttachAnalysis(ev.target.checked)} style={{ width: "auto" }} />
            <span>Save the analysis with the document</span>
          </label>
          <p className="hint span-all">Tempo, key and the generation controls are on the main screen; every dimension of the space is under the ⚙ next to Variations.</p>
        </div>
      </Modal>
    </div>
  );
}

/** A tiny contour of a candidate phrase, to tell the alternatives apart at a glance. */
function Spark({ c }: { c: ExploredPhrase }) {
  const pts: { x: number; m: number }[] = [];
  for (const ev of c.events) if (ev.kind === "note") pts.push({ x: fnum(ev.onset), m: midi(ev.pitch) });
  if (pts.length === 0) return null;
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x), x0 + 1e-9);
  const lo = Math.min(...pts.map((p) => p.m));
  const hi = Math.max(...pts.map((p) => p.m), lo + 1);
  const W = 200;
  const H = 34;
  const px = (x: number) => 4 + ((x - x0) / (x1 - x0)) * (W - 8);
  const py = (m: number) => H - 4 - ((m - lo) / (hi - lo)) * (H - 8);
  return (
    <svg className="alt-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="contour of the phrase">
      <path d={pts.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.m).toFixed(1)}`).join(" ")} />
      {pts.map((p, i) => (
        <circle key={i} cx={px(p.x)} cy={py(p.m)} r={1.8} />
      ))}
    </svg>
  );
}

/** Add two exact fraction strings (kept here only to shift an onset by a fixed step). */
function addFraction(a: string, b: string) {
  const x = parseFraction(a);
  const y = parseFraction(b);
  return frac(x.num * y.den + y.num * x.den, x.den * y.den);
}
