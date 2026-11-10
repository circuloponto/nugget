"use client";

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
  frac,
  fstr,
  generationSpaceFromRequest,
  irTuning,
  LENGTHS,
  makeFretboard,
  makeTuning,
  parseFraction,
  parseMusicIR,
  parsePhraseRequest,
  phraseToIR,
  PLUCK_TONES,
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
function Dim<T extends string>({ label, value, options, onChange, testid }: { label: string; value: readonly T[] | "all"; options: readonly { id: T; name: string }[]; onChange: (v: readonly T[] | "all") => void; testid: string }) {
  const current = value === "all" || value.length !== 1 ? "" : value[0]!;
  return (
    <label>
      {label}
      <select value={current} onChange={(e) => onChange(e.target.value === "" ? "all" : [e.target.value as T])} data-testid={testid}>
        <option value="">explore all</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
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
  const exploreAllDegrees = e.degrees === "all";
  const naturalDegrees = targets.options.filter((o) => o.kind !== "alteration").map((o) => o.degree);
  const activeDegrees = exploreAllDegrees ? naturalDegrees : (e.degrees as readonly string[]);

  return (
    <main className="lab lab2 ph">
      <header className="lab2-head">
        <div>
          <h1>
            Phrase Constructor <span>phase 3</span>
          </h1>
          <p>
            Contrasting phrases built from a grammar of targets, outlines, enclosures, runs and rhythm; inspect them note by note, then develop the one you like. <a href="/">← Musical Lab</a> ·{" "}
            <a href="/evaluator">Engine evaluator →</a>
          </p>
        </div>
        <div className="docbar">
          <button onClick={save} disabled={!ir}>
            ⬇ Save MusicIR
          </button>
          <button onClick={() => fileRef.current?.click()}>⬆ Load MusicIR…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(ev) => void onFile(ev.target.files?.[0])} data-testid="ph-file" />
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

      <section className="panel ph-controls" aria-label="Phrase request">
        <fieldset>
          <legend>1 · Harmony</legend>
          <label>
            Key
            <select value={req.tonic} onChange={(ev) => set({ tonic: ev.target.value })}>
              {TONICS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select value={req.mode} onChange={(ev) => set({ mode: ev.target.value as "major" | "minor" })}>
              <option value="major">major ii–V–I</option>
              <option value="minor">minor ii–V–i</option>
            </select>
          </label>
          <label>
            Tempo <b>{req.bpm}</b>
            <input type="range" min={50} max={200} value={req.bpm} onChange={(ev) => set({ bpm: Number(ev.target.value) })} />
          </label>
        </fieldset>

        <fieldset>
          <legend>2 · Target (on {targets.chord})</legend>
          <label>
            Mode
            <select value={e.mode} onChange={(ev) => setE({ mode: ev.target.value as "explore" | "focus" })} data-testid="ph-mode">
              <option value="explore">Explore: every compatible target</option>
              <option value="focus">Focus: lock one target</option>
            </select>
          </label>
          {e.mode === "focus" ? (
            <label>
              Arrive on
              <select value={e.focusDegree} onChange={(ev) => setE({ focusDegree: ev.target.value })} data-testid="ph-target">
                {targets.options.map((o) => (
                  <option key={o.degree} value={o.degree}>
                    {o.degree} · {o.note} · {o.role}
                    {o.kind === "alteration" ? " (alteration)" : o.kind === "extension" ? " (extension)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="ph-degrees" data-testid="ph-degrees">
              {targets.options.map((o) => (
                <label key={o.degree} className="check" title={`${o.role}${o.kind === "chord-tone" ? "" : ` (${o.kind})`}`}>
                  <input
                    type="checkbox"
                    checked={activeDegrees.includes(o.degree)}
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
          )}
          <Dim label="Octave" value={e.bands} options={BAND_NAMES.map((b) => ({ id: b, name: `${b} register` }))} onChange={(v) => setE({ bands: v })} testid="ph-bands" />
        </fieldset>

        <fieldset>
          <legend>3 · Melody</legend>
          <Dim label="Melodic strategy" value={e.strategies} options={STRATEGIES.map((s) => ({ id: s.id, name: s.name }))} onChange={(v) => setE({ strategies: v })} testid="ph-strategies" />
          <Dim label="Contour" value={e.contours} options={CONTOUR_CHOICES.filter((c) => c !== "any").map((c) => ({ id: c, name: c }))} onChange={(v) => setE({ contours: v })} testid="ph-contours" />
          <Dim label="Phrase length" value={e.lengths} options={LENGTHS.map((l) => ({ id: l, name: l === "short" ? "short (2 beats)" : l === "standard" ? "standard (1 bar)" : "long (1½ bars, two chords)" }))} onChange={(v) => setE({ lengths: v })} testid="ph-lengths" />
        </fieldset>

        <fieldset>
          <legend>4 · Rhythm</legend>
          <Dim label="Rhythmic character" value={e.rhythms} options={RHYTHM_CHARACTERS.map((r) => ({ id: r.id, name: r.name }))} onChange={(v) => setE({ rhythms: v })} testid="ph-rhythms" />
          <Dim label="Density" value={e.densities} options={DENSITIES.map((d) => ({ id: d, name: d }))} onChange={(v) => setE({ densities: v })} testid="ph-densities" />
        </fieldset>

        <fieldset>
          <legend>Constraints</legend>
          <label>
            Lowest note
            <select value={regLo} onChange={(ev) => set({ register: [Math.min(Number(ev.target.value), regHi), regHi] })}>
              {REGISTER.map((m) => (
                <option key={m} value={m}>
                  {midiName(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Highest note
            <select value={regHi} onChange={(ev) => set({ register: [regLo, Math.max(Number(ev.target.value), regLo)] })}>
              {REGISTER.map((m) => (
                <option key={m} value={m}>
                  {midiName(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Largest leap <b>{req.maxLeap}</b> semitones
            <input type="range" min={2} max={14} value={req.maxLeap} onChange={(ev) => set({ maxLeap: Number(ev.target.value) })} />
          </label>
          <label>
            Highest fret <b>{req.maxFret}</b>
            <input type="range" min={5} max={22} value={req.maxFret} onChange={(ev) => set({ maxFret: Number(ev.target.value) })} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Results</legend>
          <label>
            Contrasting phrases (at most)
            <select value={e.count} onChange={(ev) => setE({ count: Number(ev.target.value) })} data-testid="ph-count">
              {COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input type="number" min={0} value={e.seed} onChange={(ev) => setE({ seed: Math.max(0, Math.floor(Number(ev.target.value) || 0)) })} data-testid="ph-seed" />
          </label>
        </fieldset>

        {e.locks && Object.keys(e.locks).length > 0 && (
          <div className="ph-active-locks" data-testid="ph-active-locks">
            <b>Locked from the phrase you developed:</b>{" "}
            {[
              e.locks.targetPitch !== undefined ? `target pitch ${midiName(e.locks.targetPitch)}` : null,
              e.locks.rhythmPlan ? "rhythm (every onset and length)" : null,
              e.locks.contourShape !== undefined ? `contour shape ${e.locks.contourShape || "(none)"}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            . Every exploration keeps these until you clear them.{" "}
            <button onClick={() => setE({ locks: undefined })} data-testid="ph-clear-locks">
              Clear locks
            </button>
          </div>
        )}

        <div className="ph-go">
          <button className="play" onClick={generate} disabled={busy} data-testid="ph-generate">
            {busy ? "Exploring…" : e.mode === "explore" ? "Explore" : "Generate"}
          </button>
          <button onClick={newSeed} disabled={busy || candidates.length === 0} data-testid="ph-newseed">
            Another set (next seed)
          </button>
          <span className="muted">
            Same settings and seed always give the same phrases. A dimension set to “explore all” is varied across its values; pick one to lock it. Fewer phrases are returned rather than near-duplicates.
          </span>
        </div>
      </section>

      {failure && (
        <div className="panel error" role="alert" data-testid="ph-failure">
          {failure}
        </div>
      )}
      {note && (
        <p className="panel ph-note" data-testid="ph-transform-note">
          {note}
        </p>
      )}

      {candidates.length > 0 && stats && (
        <section className="panel" aria-label="Candidates">
          <h2>
            {candidates.length} contrasting phrase{candidates.length === 1 ? "" : "s"} <small>seed {stats.seed}</small>
          </h2>
          <p className="muted ph-stats" data-testid="ph-stats">
            {stats.intentionsTried} intentions tried, {stats.intentionsReachable} reachable → {stats.poolSize} phrases, all verified ({stats.rejectedInvalid} rejected) → {stats.exactDuplicates} exact and {stats.nearDuplicates} near duplicates removed → {stats.selected} kept. Closest pair: distance{" "}
            {stats.minDistance} (a near duplicate is below {stats.threshold}); on average {stats.meanDistance}. Covers {stats.coverage.targets} target degrees, {stats.coverage.registers} registers, {stats.coverage.strategies} strategy families, {stats.coverage.rhythms} rhythmic characters, {stats.coverage.contours} contours.
          </p>
          {stats.note && (
            <p className="ph-note" data-testid="ph-fewer">
              {stats.note}
            </p>
          )}
          <ol className="ph-cands" data-testid="ph-candidates">
            {candidates.map((c, i) => (
              <li key={`${c.id}-${i}`} className={candidate === c ? "active" : ""}>
                <div className="ph-cand-head">
                  <b>#{i + 1}</b>
                  <span className="ph-score" title="adherence to the stated heuristics, not beauty">
                    {c.score.total.toFixed(2)}
                  </span>
                  <span className="ph-chips">
                    {c.chips.map((chip) => (
                      <span key={chip} className="ph-chip">
                        {chip}
                      </span>
                    ))}
                  </span>
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
                  <button onClick={() => setOpenScore(openScore === `${i}` ? null : `${i}`)}>details</button>
                </div>
                <div className="ph-how">{c.summary}</div>
                {c.distinguishing.length > 0 && <div className="ph-distinct">{c.distinguishing.join(" · ")}</div>}
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

      {candidate && !edited && !loaded && (
        <section className="panel ph-develop" aria-label="Develop the selected phrase" data-testid="ph-develop">
          <h2>
            Develop phrase {candidate.id.replace("phrase-", "#")} <small>lock what you like, vary the rest</small>
          </h2>
          <div className="ph-locks">
            {LOCKS.map((l) => (
              <label key={l.aspect} className="check" title={l.hint}>
                <input type="checkbox" checked={locks.includes(l.aspect)} onChange={(ev) => setLocks((cur) => (ev.target.checked ? [...cur, l.aspect] : cur.filter((a) => a !== l.aspect)))} data-testid={`ph-lock-${l.aspect}`} />
                keep {l.label}
              </label>
            ))}
            <button className="play" onClick={develop} disabled={busy} data-testid="ph-develop-go">
              Develop variations
            </button>
          </div>
        </section>
      )}

      {ir && schedule && (
        <>
          {loaded && (
            <div className="panel loaded-note" data-testid="ph-loaded">
              Showing <b>{loaded.name}</b>. You can inspect, analyse and edit its notes. Exploring again uses the controls above.
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
              <input type="range" min={40} max={300} value={pxPerSecond} onChange={(ev) => setPxPerSecond(Number(ev.target.value))} />
            </label>
          </section>

          <section className="panel">
            <h2>
              Rhythm and harmony <small>click a note to inspect it; click the background to move the playhead</small>
            </h2>
            <div className="ph-legend">
              <i className="ph-note ph-target" /> target arrival <i className="ph-note ph-outline" /> chord outline <i className="ph-note ph-embellish" /> approach / enclosure / run <i className="ph-note ph-bass" /> bass root
            </div>
            <PhraseRoll ir={ir} schedule={schedule} pxPerSecond={pxPerSecond} selected={selected} melodyVoice={MELODY} playheadRef={playheadRef} scrollRef={scrollRef} onSelect={setSelected} onSeek={(f) => playerRef.current?.seek(f)} />
          </section>

          <section className="panel">
            <h2>
              Fretboard <small>rings: the whole phrase · filled: sounding now, or the selected note</small>
            </h2>
            <Fretboard board={board} frets={Math.min(22, Math.max(req.maxFret + 2, 12))} notes={fretNotes} ghost={fretGhost.filter((g) => !fretNotes.some((n) => n.string === g.string && n.fret === g.fret))} showScale={false} />
          </section>

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
                    <button onClick={() => edit({ midi: sel.pitch.midi - 12 })}>−8ve</button>
                    <button onClick={() => edit({ midi: sel.pitch.midi - 1 })}>−1</button>
                    <button onClick={() => edit({ midi: sel.pitch.midi + 1 })}>+1</button>
                    <button onClick={() => edit({ midi: sel.pitch.midi + 12 })}>+8ve</button>
                    <label>
                      length
                      <select value={fstr(parseFraction(sel.duration))} onChange={(ev) => edit({ duration: ev.target.value })}>
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

            <section className="panel" aria-label="Construction">
              <h2>Construction</h2>
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
              {edited && <p className="muted">This phrase has been edited by hand, so its construction is history, not a promise; explore again to develop a phrase.</p>}
              <h3>Analysis</h3>
              <label className="check">
                <input type="checkbox" checked={attachAnalysis} onChange={(ev) => setAttachAnalysis(ev.target.checked)} /> save the analysis with the document
              </label>
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
