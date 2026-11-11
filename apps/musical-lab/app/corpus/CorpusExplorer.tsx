"use client";

import { SkipBack, Pause, Play, Square, Music2, ZoomIn, Sigma, X, TriangleAlert, ArrowDown, Pin, Repeat } from "lucide-react";
import { IC, IC_SM } from "../ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { corpus, fnum, fstr, PLUCK_TONES, renderDocument, scheduleFrames, type MusicIR } from "@musical-lab/engine";
import { LabPlayer } from "../lab/player";
import CorpusTimeline, { pxPerWhole, TL_LEFT, type Segment } from "./CorpusTimeline";
import { Bars, ContourSvg, pct, RhythmStrip } from "./charts";
import Modal from "../ui/Modal";
import Tabs from "../ui/Tabs";
import { Topbar } from "../ui/shellContext";

interface IndexRow {
  id: string;
  title: string;
  category: string;
  meter: string;
  bars: number;
  notes: number;
  status: string;
  /** false when the piece has no MusicIR projection: it opens for analysis but cannot be played. */
  ir?: boolean;
}
interface Catalogue {
  available: boolean;
  reason?: string;
  corpusId?: string;
  index?: { notice: string; corpus: corpus.CorpusDescriptor; pieces: IndexRow[]; failed: { id: string; title: string; reasons: string[] }[] };
  aggregate?: corpus.CorpusAggregate | null;
}
interface Loaded {
  piece: corpus.CorpusPiece;
  report: corpus.ImportReport | null;
  /** null for an analysis-only piece (no MusicIR projection). */
  ir: MusicIR | null;
  analysis: corpus.MelodyAnalysis;
  line: corpus.MelodyLine;
}
type Level = "period" | "phrase" | "figure";
type Tab = "rhythm" | "melody" | "phrases" | "harmony" | "source";
interface Highlight {
  label: string;
  ids: string[];
}
interface Pinned {
  label: string;
  profile: corpus.PhraseProfile;
}

const LEVELS: { id: Level; name: string; prefix: string; hint: string }[] = [
  { id: "period", name: "periods", prefix: "S", hint: "≥ 4 bars, strongest boundaries only" },
  { id: "phrase", name: "phrases", prefix: "P", hint: "≥ 2 bars: the primary reading" },
  { id: "figure", name: "figures", prefix: "f", hint: "≥ 1 bar, weaker boundaries too" },
];
const WEIGHT_NAMES: Record<string, string> = { "4": "downbeat", "3": "group start", "2": "beat", "1": "half-beat", "0": "finer" };
const defaultBpm = (meter: string): number => {
  const [n, d] = meter.split("/").map(Number);
  if (n! > 3 && n! % 3 === 0 && d! >= 8) return 170;
  return n === 3 ? 140 : 115;
};

export default function CorpusExplorer({ active = true }: { active?: boolean }) {
  const playerRef = useRef<LabPlayer | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastTotal = useRef(0);

  const [cat, setCat] = useState<Catalogue | null>(null);
  const [catError, setCatError] = useState<string | null>(null);
  const [pieceId, setPieceId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const [level, setLevel] = useState<Level>("phrase");
  const [tab, setTab] = useState<Tab>("rhythm");
  const [selSegment, setSelSegment] = useState<number | null>(null);
  const [selNote, setSelNote] = useState<string | null>(null);
  const [selBoundary, setSelBoundary] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [showFaint, setShowFaint] = useState(false);
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const [rightTab, setRightTab] = useState<"phrase" | "compare" | "inspect">("phrase");
  const [modal, setModal] = useState<null | "overview" | "licence">(null);
  const closeModal = useCallback(() => setModal(null), []);

  const [bpm, setBpm] = useState(115);
  const [sampleRate, setSampleRate] = useState(44100);
  const [pxPerQuarter, setPxPerQuarter] = useState(46);
  const [playing, setPlaying] = useState(false);
  /** One-shot by default, so a phrase ending can be heard on its own; Loop repeats the region. */
  const [loop, setLoop] = useState(false);
  /** The part being played: a phrase (whole-note positions) or null for the whole piece. */
  const [region, setRegion] = useState<{ label: string; fromW: number; toW: number } | null>(null);
  /** The piece shown is not the one asked for yet. */
  const stale = pieceId !== null && loaded !== null && loaded.piece.id !== pieceId && !loadError;
  const [sounding, setSounding] = useState<string[]>([]);
  const [audioMs, setAudioMs] = useState<number | null>(null);

  // ── catalogue ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/corpus")
      .then((r) => r.json())
      .then((c: Catalogue) => {
        setCat(c);
        if (c.available && c.index?.pieces[0]) setPieceId((cur) => cur ?? c.index!.pieces[0]!.id);
      })
      .catch((e) => setCatError(String(e)));
  }, []);

  // ── one piece ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pieceId) return;
    let live = true;
    setLoadError(null);
    playerRef.current?.pause();
    setPlaying(false);
    fetch(`/api/corpus?piece=${encodeURIComponent(pieceId)}`)
      .then((r) => r.json())
      .then((d: { error?: string; reason?: string; piece?: { piece: corpus.CorpusPiece; report: corpus.ImportReport }; ir?: MusicIR; analysis?: corpus.MelodyAnalysis }) => {
        if (!live) return;
        if (!d.piece || !d.analysis) { setLoaded(null); return setLoadError(d.error ?? d.reason ?? "This piece could not be loaded."); }
        const piece = d.piece.piece;
        const line = corpus.melodyFromCorpusPiece(piece);
        playerRef.current?.pause();
        playerRef.current?.seek(0);
        setPlaying(false);
        setSounding([]);
        setSelSegment(null);
        setSelNote(null);
        setSelBoundary(null);
        setHighlight(null);
        setRegion(null);
        setBpm(defaultBpm(piece.measures[0]!.meter.text));
        setLoaded({ piece, report: d.piece.report ?? null, ir: d.ir ?? null, analysis: d.analysis, line });
      })
      .catch((e) => { if (live) { setLoaded(null); setLoadError(String(e)); } });
    return () => {
      live = false;
    };
  }, [pieceId]);

  // ── audio: the existing engine renders the MusicIR; the existing player plays it ──
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

  const doc = useMemo<MusicIR | null>(() => (loaded?.ir ? { ...loaded.ir, tempo: { bpm: String(bpm), beat: "1/4" } } : null), [loaded, bpm]);
  const schedule = useMemo(() => (doc ? scheduleFrames(doc, sampleRate) : null), [doc, sampleRate]);
  const framesPerWhole = (sampleRate * 240) / bpm;
  const ppw = pxPerWhole(pxPerQuarter);

  /** Hand the player the loop switch and the region, in frames at the current tempo. */
  const modeRef = useRef({ loop, region, framesPerWhole });
  modeRef.current = { loop, region, framesPerWhole };
  const applyMode = useCallback(() => {
    const m = modeRef.current;
    playerRef.current?.setMode(m.loop, m.region ? { from: Math.round(m.region.fromW * m.framesPerWhole), to: Math.round(m.region.toW * m.framesPerWhole) } : null);
  }, []);
  useEffect(() => {
    applyMode();
  }, [loop, region, framesPerWhole, applyMode]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || !doc) return;
    setAudioMs(null);
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const r = renderDocument(doc, { sampleRate: p.sampleRate, tone: PLUCK_TONES.sine });
      const old = lastTotal.current;
      const at = old > 0 ? Math.round((p.position() * r.samples.length) / old) : 0;
      p.load(r.samples, at);
      lastTotal.current = r.samples.length;
      applyMode();
      setAudioMs(Math.round(performance.now() - t0));
    }, 300);
    return () => clearTimeout(timer);
  }, [doc, applyMode]);

  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    const tick = () => {
      const p = playerRef.current;
      if (p && schedule) {
        const frame = p.position();
        const el = playheadRef.current;
        const px = TL_LEFT + (frame / framesPerWhole) * ppw;
        if (el) el.style.transform = `translateX(${px}px)`;
        const sc = scrollRef.current;
        if (sc && p.isPlaying && (px < sc.scrollLeft + 24 || px > sc.scrollLeft + sc.clientWidth - 80)) sc.scrollLeft = Math.max(0, px - 100);
        const now = p.isPlaying ? schedule.events.filter((ev) => ev.startFrame <= frame && frame < ev.endFrame).map((ev) => ev.id) : [];
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
  }, [schedule, framesPerWhole, ppw, playing]);

  const toggle = useCallback(async () => {
    const p = playerRef.current;
    if (!p || !doc) return;
    if (p.isPlaying) p.pause();
    else await p.play();
    setPlaying(p.isPlaying);
  }, [doc]);
  const rewind = () => {
    playerRef.current?.pause();
    playerRef.current?.seek(0);
    setPlaying(false);
    setSounding([]);
  };
  /** Play one phrase from its start (once, or repeating it if Loop is on). */
  const playPhrase = useCallback(
    async (s: Segment) => {
      const p = playerRef.current;
      if (!p || !doc || !loaded) return;
      const notes = loaded.line.notes;
      const next = { label: s.id, fromW: fnum(notes[s.from]!.onset), toW: fnum(notes[s.to]!.end) };
      modeRef.current = { ...modeRef.current, region: next };
      setRegion(next);
      applyMode();
      p.pause();
      p.seek(Math.round(next.fromW * framesPerWhole));
      await p.play();
      setPlaying(p.isPlaying);
    },
    [doc, loaded, framesPerWhole, applyMode],
  );
  const seekWhole = useCallback((w: number) => playerRef.current?.seek(Math.round(w * framesPerWhole)), [framesPerWhole]);

  // ── phrase segmentation at the chosen level ─────────────────────────────
  const phr = loaded?.analysis.phrases;
  const boundariesAt = useMemo(() => {
    if (!phr) return [] as { index: number; score: number }[];
    const score = new Map(phr.candidates.map((c) => [c.index, c.score] as const));
    const idx = level === "phrase" ? phr.candidates.filter((c) => c.selected).map((c) => c.index) : phr.alternatives.find((a) => a.name === level)!.boundaries;
    return idx.map((i) => ({ index: i, score: score.get(i) ?? 0 }));
  }, [phr, level]);

  const segments = useMemo<Segment[]>(() => {
    if (!loaded) return [];
    const n = loaded.line.notes.length;
    const prefix = LEVELS.find((l) => l.id === level)!.prefix;
    const edges = [-1, ...boundariesAt.map((b) => b.index), n - 1];
    const sc = new Map(boundariesAt.map((b) => [b.index, b.score] as const));
    const out: Segment[] = [];
    for (let e = 0; e + 1 < edges.length; e++) {
      const from = edges[e]! + 1;
      const to = edges[e + 1]!;
      if (to < from) continue;
      const a = e === 0 ? 1 : sc.get(edges[e]!) ?? 0;
      const b = e + 2 === edges.length ? 1 : sc.get(edges[e + 1]!) ?? 0;
      out.push({ id: `${prefix}${out.length + 1}`, from, to, confidence: Math.round(a * b * 1000) / 1000 });
    }
    return out;
  }, [loaded, boundariesAt, level]);
  useEffect(() => setSelSegment(null), [level]);

  const faint = useMemo(() => {
    if (!phr || !showFaint) return [];
    const chosen = new Set(boundariesAt.map((b) => b.index));
    return phr.candidates.filter((c) => !chosen.has(c.index) && c.score >= 0.3).map((c) => ({ index: c.index, score: c.score }));
  }, [phr, showFaint, boundariesAt]);

  const profileOf = useCallback((s: Segment) => (loaded ? corpus.phraseProfile(loaded.line, s.from, s.to) : null), [loaded]);
  const segment = selSegment !== null ? segments[selSegment] ?? null : null;
  const profile = useMemo(() => (segment ? profileOf(segment) : null), [segment, profileOf]);
  const comparison = useMemo(() => (pinned && profile ? corpus.comparePhraseProfiles(pinned.profile, profile) : null), [pinned, profile]);

  const notePoints = (s: Segment) => (loaded ? loaded.line.notes.slice(s.from, s.to + 1).map((n) => ({ x: fnum(n.onset), midi: n.midi })) : []);
  const rhythmTicks = (s: Segment) => {
    const ns = loaded!.line.notes.slice(s.from, s.to + 1);
    const t0 = fnum(ns[0]!.onset);
    return { ticks: ns.map((n) => ({ at: fnum(n.onset) - t0, len: fnum(n.duration) })), total: fnum(ns[ns.length - 1]!.end) - t0 };
  };

  const notesFrom = (id: string, count: number, notesOnly = true) => {
    if (!loaded) return [] as string[];
    const list = notesOnly ? loaded.line.notes : loaded.line.events;
    const at = list.findIndex((e) => e.id === id);
    return at < 0 ? [] : list.slice(at, at + count).filter((e) => e.kind === "note").map((e) => e.id);
  };

  // ── filtering the catalogue ─────────────────────────────────────────────
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cat?.index?.pieces ?? []).filter((p) => (category === "all" || p.category === category) && (!q || p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  }, [cat, query, category]);
  const categories = useMemo(() => [...new Set((cat?.index?.pieces ?? []).map((p) => p.category).filter(Boolean))].sort(), [cat]);

  const selNoteObj = loaded && selNote ? loaded.line.notes.find((n) => n.id === selNote) ?? null : null;
  const selBoundaryObj = phr && selBoundary !== null ? phr.candidates.find((c) => c.index === selBoundary) ?? null : null;

  // ── render ──────────────────────────────────────────────────────────────
  const pickSegment = (i: number) => {
    setSelSegment(i);
    setSelNote(null);
    setSelBoundary(null);
    setRightTab("phrase");
  };
  const pickNote = (id: string) => {
    setSelNote(id);
    setSelBoundary(null);
    setRightTab("inspect");
  };
  const pickBoundary = (i: number) => {
    setSelBoundary(i);
    setSelNote(null);
    setRightTab("inspect");
  };

  return (
    <div className="co2">
      <Topbar active={active}>
        <button className="tool-btn" onClick={rewind} aria-label="Back to the start" title="Back to the start" disabled={!doc}>
          <SkipBack {...IC} />
        </button>
        <button className="tool-btn primary" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"} title={doc ? "Play from here, once to the end" : "No MusicIR for this piece: it cannot be played"} disabled={!doc} data-testid="co-play">
          {playing ? <Pause {...IC} /> : <Play {...IC} />}
        </button>
        <button className="tool-btn" onClick={rewind} aria-label="Stop and rewind" title="Stop" disabled={!doc}>
          <Square {...IC} />
        </button>
        <button className={`tool-btn${loop ? " on" : ""}`} onClick={() => setLoop((v) => !v)} aria-pressed={loop} aria-label="Loop" title={loop ? "Looping the played part: click for one pass" : "One pass: click to loop the played part"} disabled={!doc} data-testid="co-loop">
          <Repeat {...IC} />
          <span className="lbl">Loop</span>
        </button>
        <span className="pill" title="Tempo, quarter notes per minute">
          <Music2 {...IC} />
          <input type="range" min={50} max={240} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} aria-label="Tempo in quarter notes per minute" data-testid="co-bpm" />
          <b>{bpm}</b>
        </span>
        <span className="pill pill-opt" title="Timeline zoom">
          <ZoomIn {...IC} />
          <input type="range" min={20} max={120} value={pxPerQuarter} onChange={(e) => setPxPerQuarter(Number(e.target.value))} aria-label="Zoom" />
        </span>
        <span className="pill pill-opt muted" data-testid="co-audio">
          {!loaded ? "—" : !doc ? "analysis only" : audioMs === null ? "rendering…" : `rendered in ${audioMs} ms`}
        </span>
      </Topbar>

      {catError && (
        <div className="banner error co2-wide" role="alert">
          Could not reach the corpus service: {catError}
        </div>
      )}
      {cat && !cat.available && (
        <div className="stage-empty co2-wide" data-testid="co-unavailable">
          <div>
            <b>No corpus to show</b>
            {cat.reason}
            <br />
            <span className="muted">The corpus is research-only GPL-3.0 data. It is kept out of the repository and the app bundle, so it appears here only after you import it on this machine, and only for requests from this machine.</span>
          </div>
        </div>
      )}
      {!cat && !catError && <div className="stage-empty co2-wide">Loading…</div>}

      {cat?.available && cat.index && (
        <>
          <aside className="card co2-list" aria-label="Imported compositions">
            <div className="co2-list-head">
              <h2>
                Compositions <small>{rows.length} of {cat.index.pieces.length}</small>
              </h2>
              <span>
                <button className="icon-btn" onClick={() => setModal("overview")} title="Statistics of the whole corpus" aria-label="Whole corpus" data-testid="co-overview-open">
                  <Sigma {...IC} />
                </button>
              </span>
            </div>
            <div className="co-filters">
              <input type="search" placeholder="Search title…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search compositions" data-testid="co-search" />
              <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" data-testid="co-category">
                <option value="all">all</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <ul className="co-pieces co2-pieces" data-testid="co-pieces">
              {rows.map((p) => (
                <li key={p.id}>
                  <button className={`co-piece${p.id === pieceId ? " active" : ""}`} onClick={() => setPieceId(p.id)} data-piece={p.id}>
                    <b>{p.title}</b>
                    <span>
                      {p.category.replace("_", " ")} · {p.meter} · {p.bars} bars · {p.notes} notes
                    </span>
                    {p.ir === false && <em title="no MusicIR projection: opens for analysis, cannot be played"><TriangleAlert {...IC_SM} /> analysis only</em>}
                    {p.status !== "ok" && <em title="the import reported something worth a look"><TriangleAlert {...IC_SM} /> notes on import</em>}
                  </button>
                </li>
              ))}
            </ul>
            {cat.index.failed.length > 0 && (
              <div className="co-failed" data-testid="co-failed">
                <b>Not imported</b>
                {cat.index.failed.map((f) => (
                  <p key={f.id}>
                    {f.title}: <span className="muted">{f.reasons.join("; ")}</span>
                  </p>
                ))}
              </div>
            )}
          </aside>

          <div className="co2-main">
            <p className="banner co2-licence" role="note" data-testid="co-notice">
              <span>
                <b>Research-only data (GPL-3.0).</b> Keep it out of commercial releases.
              </span>
              <button className="btn small" onClick={() => setModal("licence")} data-testid="co-licence-open">
                Licence &amp; provenance
              </button>
            </p>
            {loadError && (
              <div className="banner error" role="alert">
                {loadError}
              </div>
            )}
            {!loaded && !loadError && <div className="stage-empty">Loading…</div>}
            {loaded && (
              <div className={`co2-loaded${stale ? " is-stale" : ""}`} aria-busy={stale} data-testid="co-loaded" data-stale={stale ? "1" : "0"}>
                {stale && (
                  <p className="banner" role="status" data-testid="co-stale">
                    Loading the next piece… what is shown below is still <b>{loaded.piece.title}</b>.
                  </p>
                )}
                {!doc && (
                  <p className="banner" role="note" data-testid="co-analysis-only">
                    <span>
                      <b>Analysis only.</b> This piece has no MusicIR projection{loaded.report?.irLoss.length ? ` (${loaded.report.irLoss.join("; ")})` : ""}, so it is shown and analysed from the notation but <b>cannot be played</b>, and it has no audio.
                    </span>
                  </p>
                )}
                <header className="co2-head">
                  <div className="co2-title">
                    <h2>{loaded.piece.title}</h2>
                    <span className="muted">
                      {loaded.piece.provenance.catalog.category?.replace("_", " ")} · {loaded.piece.measures[0]!.meter.text} · {loaded.line.bars.length} bars · {loaded.line.notes.length} notes
                    </span>
                  </div>
                  <div className="co2-head-right">
                    <span className="muted">Read as</span>
                    <Tabs label="Phrase level" value={level} onChange={setLevel} tabs={LEVELS.map((l) => ({ id: l.id, label: l.name, testId: `co-level-${l.id}` }))} />
                    <label className="co2-check">
                      <input type="checkbox" checked={showFaint} onChange={(e) => setShowFaint(e.target.checked)} data-testid="co-faint" /> weaker candidates
                    </label>
                    <span className="muted" data-testid="co-segcount">
                      {segments.length} {LEVELS.find((l) => l.id === level)!.name}
                    </span>
                    {highlight && (
                      <span className="lock-chip" data-testid="co-highlight">
                        <span>
                          Highlighting <b>{highlight.label}</b> ({highlight.ids.length} notes)
                        </span>
                        <button onClick={() => setHighlight(null)} aria-label="Clear highlight">
                          <X {...IC_SM} />
                        </button>
                      </span>
                    )}
                  </div>
                </header>

                <section className="card co2-tl">
                  <div className="ph-legend co-legend">
                    <i className="co-key short" /> short (≤ ½ beat) <i className="co-key mid" /> medium <i className="co-key long" /> sustained (≥ 1 beat) <i className="co-key rest" /> written rest <i className="co-key pad" /> suspected padding <i className="co-key hl" /> highlighted pattern
                    <span className="muted"> · darker edge = stronger metric position · click a note, a phrase header or a boundary</span>
                  </div>
                  <CorpusTimeline
                    line={loaded.line}
                    harmony={loaded.piece.harmony}
                    segments={segments}
                    boundaries={boundariesAt}
                    faint={faint}
                    selectedSegment={selSegment}
                    selectedNote={selNote}
                    selectedBoundary={selBoundary}
                    highlight={new Set(highlight?.ids ?? [])}
                    sounding={new Set(sounding)}
                    pxPerQuarter={pxPerQuarter}
                    playheadRef={playheadRef}
                    scrollRef={scrollRef}
                    onSelectNote={pickNote}
                    onSelectSegment={pickSegment}
                    onSelectBoundary={pickBoundary}
                    onSeek={seekWhole}
                  />
                </section>

                <div className="co2-bottom">
                  <section className="card co2-panel" aria-label="Analysis">
                    <div className="co2-panel-head">
                      <Tabs
                        label="Analysis"
                        value={tab}
                        onChange={setTab}
                        tabs={(["rhythm", "melody", "phrases", "harmony", "source"] as Tab[]).map((t) => ({ id: t, label: t === "source" ? "source & import" : t, testId: `co-tab-${t}` }))}
                      />
                    </div>
                    <div className="co2-panel-body">
                      {tab === "rhythm" && <RhythmTab a={loaded.analysis} onHighlight={setHighlight} notesFrom={notesFrom} line={loaded.line} />}
                      {tab === "melody" && <MelodyTab a={loaded.analysis} onHighlight={setHighlight} notesFrom={notesFrom} />}
                      {tab === "phrases" && <PhrasesTab a={loaded.analysis} level={level} segments={segments} profileOf={profileOf} selected={selSegment} onSelect={pickSegment} onBoundary={pickBoundary} />}
                      {tab === "harmony" && <HarmonyTab a={loaded.analysis} />}
                      {tab === "source" && <SourceTab loaded={loaded} />}
                    </div>
                  </section>

                  <section className="card co2-panel" aria-label="Selection">
                    <div className="co2-panel-head">
                      <Tabs
                        label="Selection"
                        value={rightTab}
                        onChange={setRightTab}
                        tabs={[
                          { id: "phrase", label: "Phrase", testId: "co-rtab-phrase" },
                          { id: "compare", label: pinned ? <>Compare <Pin {...IC_SM} /></> : "Compare", testId: "co-rtab-compare" },
                          { id: "inspect", label: "Inspect", testId: "co-rtab-inspect" },
                        ]}
                      />
                    </div>
                    <div className="co2-panel-body">
                      {rightTab === "phrase" &&
                        (segment && profile ? (
                          <div data-testid="co-phrase">
                            <h3 className="co2-h">
                              Phrase {segment.id} <small className="muted" title="Product of the strengths of its two boundaries. A heuristic score; it has not been checked against phrases marked by people, so it is not a probability.">boundary strength {Math.round(segment.confidence * 100)}% · heuristic, uncalibrated · a hypothesis, not a fact</small>
                            </h3>
                            <div className="co-phrase-grid">
                              <div>
                                <ContourSvg points={notePoints(segment)} width={240} height={70} label={`contour of ${segment.id}`} />
                                <div className="muted">contour: <b>{profile.contour.kind}</b> <code>{profile.contour.shape}</code></div>
                                <RhythmStrip {...rhythmTicks(segment)} width={240} label={`rhythm of ${segment.id}`} />
                                <div className="muted">activity: <b>{profile.activityShape}</b> (attacks per third: {profile.activityThirds.join(" · ")})</div>
                              </div>
                              <table className="co-facts">
                                <tbody>
                                  <tr><th>length</th><td>{profile.noteCount} notes · {profile.bars} bars · {profile.beats} beats · {profile.attacksPerBeat} attacks/beat</td></tr>
                                  <tr><th>register</th><td>MIDI {profile.range.lowest}–{profile.range.highest} (span {profile.range.span}), mean {profile.range.mean}</td></tr>
                                  <tr><th>opens</th><td>on a {WEIGHT_NAMES[String(profile.opening.firstWeight)]}{profile.opening.pickup ? " (pickup)" : ""}{profile.opening.afterRest ? ", after a written rest" : ""}</td></tr>
                                  <tr><th>ends</th><td>{profile.ending.finalBeats} beat(s) on a {WEIGHT_NAMES[String(profile.ending.finalWeight)]}; {profile.ending.finalInterval === null ? "no approach" : `${profile.ending.approach} by a ${profile.ending.finalIntervalClass} (${profile.ending.finalInterval} st)`}; {profile.ending.decelerates ? "decelerates" : "does not decelerate"}; {pct(profile.ending.shareOfPhrase)} of the phrase{profile.ending.followedByRest ? "; then a written rest" : ""}</td></tr>
                                </tbody>
                              </table>
                            </div>
                            <div className="co-actions">
                              <button className="btn small" onClick={() => void playPhrase(segment)} disabled={!doc} title={doc ? (loop ? "Repeat this phrase" : "Play this phrase once") : "No MusicIR for this piece"} data-testid="co-play-phrase">
                                <Play {...IC_SM} /> Play phrase{loop ? " (loop)" : ""}
                              </button>
                              {region && (
                                <button className="btn small" onClick={() => setRegion(null)} data-testid="co-region-clear" title="Go back to playing the whole piece">
                                  <X {...IC_SM} /> Whole piece
                                </button>
                              )}
                              <button className="btn small" onClick={() => seekWhole(fnum(loaded.line.notes[segment.from]!.onset))} disabled={!doc} data-testid="co-play-from" title="Only moves the playhead; press Play to hear it">Move playhead here</button>
                              <button
                                className="btn small"
                                onClick={() => {
                                  setPinned({ label: `${loaded.piece.title} · ${segment.id}`, profile });
                                  setRightTab("compare");
                                }}
                                data-testid="co-pin"
                              >
                                Pin as A to compare
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="hint">Click a phrase header on the timeline (or a row in the Phrases tab) to see its contour, rhythm, opening and ending.</p>
                        ))}
                      {rightTab === "compare" &&
                        (pinned ? (
                          <div data-testid="co-compare">
                            <h3 className="co2-h">
                              Compare two phrases <small className="muted">A is pinned; B is the phrase selected now</small>
                            </h3>
                            <p>
                              <b>A:</b> {pinned.label} <button className="btn small" onClick={() => setPinned(null)}>unpin</button>
                            </p>
                            {!comparison || !profile || !segment ? (
                              <p className="hint">Select another phrase (in this piece or another) to compare it with A.</p>
                            ) : (
                              <div className="co-compare-body">
                                <div className="co-two">
                                  <PhraseMini title={`A · ${pinned.label}`} profile={pinned.profile} />
                                  <PhraseMini title={`B · ${loaded.piece.title} · ${segment.id}`} profile={profile} />
                                </div>
                                <Bars testId="co-compare-bars" max={1} items={(Object.keys(comparison.aspects) as (keyof typeof comparison.aspects)[]).map((k) => ({ label: k, value: comparison.aspects[k], text: pct(comparison.aspects[k]) }))} />
                                <p>
                                  Overall similarity <b>{pct(comparison.overall)}</b> · relation: <b>{comparison.relation.replace(/-/g, " ")}</b>
                                </p>
                                <ul>{comparison.statements.map((s, i) => <li key={i}>{s}</li>)}</ul>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="hint">Select a phrase, press “Pin as A to compare”, then select another phrase.</p>
                        ))}
                      {rightTab === "inspect" &&
                        (selNoteObj || selBoundaryObj ? (
                          <div data-testid="co-inspect">
                            {selNoteObj && <NoteInspector line={loaded.line} id={selNoteObj.id} />}
                            {selBoundaryObj && <BoundaryInspector c={selBoundaryObj} line={loaded.line} />}
                          </div>
                        ) : (
                          <p className="hint">Click a note or a boundary line on the timeline to see its place in the bar, its harmony, or the evidence behind it.</p>
                        ))}
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <Modal open={modal === "overview"} onClose={closeModal} title="Whole corpus" size="wide" testId="co-overview-modal">
        {cat?.aggregate ? <Overview agg={cat.aggregate} /> : <p className="hint">No pooled statistics.</p>}
      </Modal>
      <Modal open={modal === "licence"} onClose={closeModal} title="Licence and provenance" testId="co-licence-modal">
        {cat?.index && (
          <>
            <p>{cat.index.notice}</p>
            <table className="co-facts">
              <tbody>
                <tr><th>corpus</th><td>{cat.index.corpus.name}</td></tr>
                <tr><th>licence</th><td>{cat.index.corpus.license}</td></tr>
                {cat.index.corpus.repository && (
                  <tr><th>source</th><td><a href={cat.index.corpus.repository} target="_blank" rel="noreferrer">{cat.index.corpus.repository}</a></td></tr>
                )}
              </tbody>
            </table>
            <p className="hint">This data is served only to this machine and is not part of the repository or the app bundle.</p>
          </>
        )}
      </Modal>
    </div>
  );
}

// ── pieces of the page ─────────────────────────────────────────────────────

function Fig({ k, v, hint }: { k: string; v: ReactNode; hint?: string }) {
  return (
    <div className="co-fig" title={hint}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

function PhraseMini({ title, profile }: { title: string; profile: corpus.PhraseProfile }) {
  // contour from the profile's own intervals; rhythm from its exact durations
  let m = 0;
  const pts = [{ x: 0, midi: 0 }];
  let t = 0;
  const durs = profile.rhythm.map((d) => {
    const [n, den] = d.split("/");
    return Number(n) / (den === undefined ? 1 : Number(den));
  });
  profile.intervals.forEach((iv, i) => {
    m += iv;
    t += durs[i]!;
    pts.push({ x: t, midi: m });
  });
  const ticks: { at: number; len: number }[] = [];
  let at = 0;
  durs.forEach((d) => {
    ticks.push({ at, len: d });
    at += d;
  });
  return (
    <div className="co-mini">
      <div className="muted">{title}</div>
      <ContourSvg points={pts} width={250} height={64} />
      <RhythmStrip ticks={ticks} total={at} width={250} />
      <div className="muted">{profile.noteCount} notes · {profile.contour.kind} · {profile.activityShape}</div>
    </div>
  );
}

function Overview({ agg }: { agg: corpus.CorpusAggregate }) {
  const p = agg.pooled;
  const dur = Object.entries(p.rhythm.durationShare).slice(0, 5);
  return (
    <div className="co-overview" data-testid="co-overview">
      <div className="co-figs">
        <Fig k="notes in runs of 8+ short notes" v={pct(p.rhythm.shortRuns.shareOfNotesInRunsOf8Plus)} />
        <Fig k="bursts ending held / on a rest" v={pct(p.melody.joint.burstThenHoldShare)} />
        <Fig k="written rests" v={`${p.rhythm.rests.durations ? Object.values(p.rhythm.rests.durations).reduce((a, b) => a + b, 0) : 0} in ${p.rhythm.rests.piecesWithRests} piece(s)`} hint="rests flagged as converter padding are excluded" />
        <Fig k="steps / skips / leaps" v={`${pct(p.melody.intervalClasses.step)} / ${pct(p.melody.intervalClasses.skip)} / ${pct(p.melody.intervalClasses.leap)}`} />
        <Fig k="phrase length" v={`${p.phrases.barsPerPhrase.median} bars median`} />
      </div>
      <Bars items={dur.map(([d, v]) => ({ label: d, value: v, text: pct(v) }))} />
    </div>
  );
}

function NoteInspector({ line, id }: { line: corpus.MelodyLine; id: string }) {
  const n = line.notes.find((x) => x.id === id)!;
  const beat = fnum(line.bars[n.bar]!.beat);
  const chord = line.chords.find((c) => fnum(c.onset) <= fnum(n.onset) + 1e-9 && fnum(n.onset) < fnum(c.end) - 1e-9);
  const rel = chord ? (((Math.round(n.midi) - chord.rootPc) % 12) + 12) % 12 : null;
  const inChord = chord && rel !== null && chord.intervals ? chord.intervals.includes(rel) : null;
  return (
    <div data-testid="co-note-inspect">
      <h2>
        Note {n.name ?? n.midi} <small>{n.id}</small>
      </h2>
      <p>
        bar {line.bars[n.bar]!.number} · onset {fstr(n.onset)} · duration {fstr(n.duration)} ({Math.round((fnum(n.duration) / beat) * 100) / 100} beat(s)) · position in bar {fstr(n.phase)} · metric weight <b>{n.weight}</b> ({WEIGHT_NAMES[String(n.weight)]})
        {n.tiedParts > 1 ? ` · ${n.tiedParts} tied notes` : ""}
        {chord ? ` · over ${chord.symbol}: ${inChord ? `a chord tone (${rel} semitones above the root)` : `not a chord tone (${rel} above the root)`}` : " · no chord written here"}
      </p>
    </div>
  );
}

function BoundaryInspector({ c, line }: { c: corpus.BoundaryHypothesis; line: corpus.MelodyLine }) {
  return (
    <div data-testid="co-boundary-inspect">
      <h2>
        Boundary after note {c.afterNote} <small>strength {Math.round(c.score * 100)}% (heuristic) · {c.level} · {c.independentKinds} kind(s) of evidence · bar {line.bars[c.bar]!.number}</small>
      </h2>
      <p className="muted">A boundary is a hypothesis: these are the cues that support it, each scored 0–1 and combined without any single one deciding.</p>
      <ul className="co-evidence">
        {c.evidence.map((e, i) => (
          <li key={i}>
            <b>{e.kind}</b> <span className="co-ev-bar"><i style={{ width: `${e.strength * 100}%` }} /></span> {Math.round(e.strength * 100)}% — {e.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

const fracGlyph = (t: string) => (t.startsWith("r") ? `rest ${t.slice(1)}` : t);

function RhythmTab({ a, onHighlight, notesFrom, line }: { a: corpus.MelodyAnalysis; onHighlight: (h: Highlight | null) => void; notesFrom: (id: string, n: number, notesOnly?: boolean) => string[]; line: corpus.MelodyLine }) {
  const r = a.rhythm;
  const j = a.melody.joint.burstThenHold;
  const runs = Object.entries(r.shortRuns.histogram).sort((x, y) => Number(x[0]) - Number(y[0]));
  return (
    <div data-testid="co-rhythm">
      <p className="muted">Rhythm is not summarised by one density number: a run of eight eighths and a burst-then-hold phrase can have the same average.</p>
      <div className="co-figs">
        <Fig k="notes" v={r.noteCount} />
        <Fig k="written rests" v={r.restCount} hint="silence the original notation writes" />
        <Fig k="suspected padding rests" v={r.suspectRests} hint="rests the converter added; excluded from every silence statistic" />
        <Fig k="longest run of short notes" v={r.shortRuns.longest} />
        <Fig k="notes in runs of 4+" v={pct(r.shortRuns.shareOfNotesInRunsOf4Plus)} />
        <Fig k="notes in runs of 8+" v={pct(r.shortRuns.shareOfNotesInRunsOf8Plus)} />
        <Fig k="bursts then hold" v={`${j.heldAfter + j.restAfter} of ${j.bursts}`} hint="runs of 3+ short notes that end on a note ≥ 1 beat or a written rest" />
        <Fig k="syncopated notes" v={pct(r.metric.syncopationShare)} />
        <Fig k="notes per bar (median)" v={r.notesPerBar.median} />
        <Fig k="bars repeating an earlier rhythm" v={pct(r.cells.repeatedBarShare)} />
      </div>
      <div className="co-cols">
        <div>
          <h3>Durations</h3>
          <Bars testId="co-durations" items={r.durations.byValue.slice(0, 8).map((d) => ({ label: `${d.duration} · ${d.beats} beat`, value: d.share, text: `${d.count} · ${pct(d.timeShare)} of time` }))} />
          <h3>Short, medium, long</h3>
          <Bars items={[{ label: "short ≤ ½ beat", value: r.sustain.short }, { label: "medium", value: r.sustain.medium }, { label: "long ≥ 1 beat", value: r.sustain.long }, { label: "held ≥ 2 beats", value: r.sustain.held }]} />
        </div>
        <div>
          <h3>Runs of short notes</h3>
          {runs.length ? <Bars items={runs.map(([k, v]) => ({ label: `${k} notes`, value: v, text: `${v}×` }))} /> : <p className="muted">none</p>}
          <h3>Where attacks fall in the bar</h3>
          <Bars items={["4", "3", "2", "1", "0"].map((w) => ({ label: WEIGHT_NAMES[w]!, value: r.metric.attacksByWeight[w] ?? 0 }))} />
        </div>
        <div>
          <h3>Attacks per beat, per bar</h3>
          <Bars items={Object.entries(r.groupings.beatPatterns).map(([k, v]) => ({ label: k, value: v, text: `${v} bar(s)` }))} />
          <p className="muted">{pct(r.groupings.unevenBeatShare)} of bars distribute attacks unevenly; {pct(r.groupings.asymmetricBarShare)} contain an unequal grouping such as 3+3+2.</p>
        </div>
      </div>
      <h3>Repeated rhythmic cells <small className="muted">click one to highlight where it occurs</small></h3>
      {r.cells.repeated.length === 0 ? (
        <p className="muted">none</p>
      ) : (
        <ul className="co-patterns" data-testid="co-cells">
          {r.cells.repeated.map((c, i) => (
            <li key={i}>
              <button
                onClick={() => onHighlight({ label: `cell ${c.tokens.map(fracGlyph).join(" ")}`, ids: c.starts.flatMap((s) => notesFrom(s, c.length, false)) })}
                title="highlight every occurrence"
              >
                {c.tokens.map(fracGlyph).join(" · ")}
              </button>{" "}
              ×{c.count} {c.uniform ? <span className="muted">(a uniform run)</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        Written rests per bar: {line.events.filter((e) => e.kind === "rest" && !e.suspect).length}. Rest durations: {Object.entries(r.rests.durations).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}.
      </p>
    </div>
  );
}

function MelodyTab({ a, onHighlight, notesFrom }: { a: corpus.MelodyAnalysis; onHighlight: (h: Highlight | null) => void; notesFrom: (id: string, n: number) => string[] }) {
  const m = a.melody;
  const ivs = Object.entries(m.intervalHistogram).sort((x, y) => Number(x[0]) - Number(y[0]));
  const ic = m.intervalClasses;
  const fmtIv = (xs: readonly number[]) => xs.map((x) => (x > 0 ? `+${x}` : String(x))).join(" ");
  return (
    <div data-testid="co-melody">
      <div className="co-figs">
        <Fig k="range" v={`${m.range.lowest}–${m.range.highest} (${m.range.span} st)`} />
        <Fig k="mean |interval|" v={`${m.meanAbsInterval} st`} />
        <Fig k="direction (up / down / level)" v={`${m.direction.up} / ${m.direction.down} / ${m.direction.level}`} />
        <Fig k="direction changes" v={`${m.direction.changes} (${pct(m.direction.changeRate)} of notes)`} />
        <Fig k="after a leap, the line reverses" v={`${pct(m.gapFill.reversalShare)} of ${m.gapFill.leaps}`} />
        <Fig k="after long notes / short notes" v={`${m.joint.meanIntervalAfterLong} / ${m.joint.meanIntervalAfterShort} st`} hint="mean size of the interval that follows" />
        <Fig k="leaps arriving on strong beats" v={pct(m.joint.leapOnStrongShare)} />
        <Fig k="whole-piece contour" v={m.contour.kind} hint="always an arch for long pieces; the phrase-level contour is the informative one" />
      </div>
      <div className="co-cols">
        <div>
          <h3>Interval classes</h3>
          <Bars testId="co-intervals" max={1} items={[{ label: "repeat (0)", value: ic.repeat, text: pct(ic.repeat) }, { label: "step (≤ 2 st)", value: ic.step, text: pct(ic.step) }, { label: "skip (3–4 st)", value: ic.skip, text: pct(ic.skip) }, { label: "leap (≥ 5 st)", value: ic.leap, text: pct(ic.leap) }]} />
        </div>
        <div>
          <h3>Interval sizes (semitones)</h3>
          <Bars items={ivs.map(([k, v]) => ({ label: Number(k) > 0 ? `+${k}` : k, value: v, text: `${v}` }))} />
        </div>
        {m.tonal && (
          <div>
            <h3>Scale degrees <small className="muted">({m.tonal.source})</small></h3>
            <Bars items={Array.from({ length: 12 }, (_, i) => ({ label: `${i}`, value: m.tonal!.degreeHistogram[String(i)] ?? 0 }))} />
            <p className="muted">{m.tonal.inScaleShare === null ? "no scale claim for this mode" : `${pct(m.tonal.inScaleShare)} of notes in the written scale`}; final note {m.tonal.finalDegree} st above the tonic.</p>
          </div>
        )}
      </div>
      <h3>Recurring motifs <small className="muted">interval patterns; click to highlight</small></h3>
      <PatternList testId="co-motifs" items={m.motifs.map((x) => ({ text: fmtIv(x.intervals), count: x.count, uniform: x.uniform, ids: x.starts.flatMap((s) => notesFrom(s, x.intervals.length + 1)) }))} onHighlight={onHighlight} />
      <h3>Motifs with the same rhythm too</h3>
      <PatternList items={m.rhythmicMotifs.map((x) => ({ text: `${fmtIv(x.intervals)}  (${x.rhythm?.join(" ")})`, count: x.count, uniform: x.uniform, ids: x.starts.flatMap((s) => notesFrom(s, x.intervals.length + 1)) }))} onHighlight={onHighlight} />
      <h3>Transposed sequences</h3>
      {m.sequences.length === 0 ? (
        <p className="muted">none</p>
      ) : (
        <ul className="co-patterns" data-testid="co-sequences">
          {m.sequences.map((s, i) => (
            <li key={i}>
              <button onClick={() => onHighlight({ label: `sequence from ${s.start}`, ids: notesFrom(s.start, s.unitLength * s.units) })}>
                {s.units} × {s.unitLength} notes, each {s.shift > 0 ? "+" : ""}{s.shift} st from the last
              </button>{" "}
              {s.rhythmMatch ? "same rhythm" : <span className="muted">rhythm differs</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PatternList({ items, onHighlight, testId }: { items: { text: string; count: number; uniform: boolean; ids: string[] }[]; onHighlight: (h: Highlight | null) => void; testId?: string }) {
  if (items.length === 0) return <p className="muted">none</p>;
  return (
    <ul className="co-patterns" data-testid={testId}>
      {items.map((it, i) => (
        <li key={i}>
          <button onClick={() => onHighlight({ label: it.text, ids: it.ids })}>{it.text}</button> ×{it.count} {it.uniform && <span className="muted">(uniform)</span>}
        </li>
      ))}
    </ul>
  );
}

function PhrasesTab({ a, level, segments, profileOf, selected, onSelect, onBoundary }: { a: corpus.MelodyAnalysis; level: Level; segments: Segment[]; profileOf: (s: Segment) => corpus.PhraseProfile | null; selected: number | null; onSelect: (i: number) => void; onBoundary: (index: number) => void }) {
  const p = a.phrases;
  const top = [...p.candidates].sort((x, y) => y.score - x.score).slice(0, 12);
  return (
    <div data-testid="co-phrases">
      <p className="muted">
        Boundaries are hypotheses. Evidence: {Object.keys(p.method.weights).join(", ")}. At the chosen level ({level}) there are <b>{segments.length}</b> units; {p.alternatives.map((x) => `${x.phraseCount} ${x.name}s`).join(" or ")} are equally defensible readings at other levels. {p.uncertainty.ambiguousBoundaries} boundaries sit within 0.08 of the threshold.
      </p>
      <table className="co-table" data-testid="co-phrase-table">
        <thead>
          <tr><th>unit</th><th>notes</th><th>bars</th><th>activity</th><th>contour</th><th>final note</th><th title="heuristic boundary strength, not a calibrated probability">boundary strength</th></tr>
        </thead>
        <tbody>
          {segments.map((s, i) => {
            const pr = profileOf(s)!;
            return (
              <tr key={s.id} className={selected === i ? "sel" : ""} onClick={() => onSelect(i)}>
                <td>{s.id}</td>
                <td>{pr.noteCount}</td>
                <td>{pr.bars}</td>
                <td>{pr.activityShape}</td>
                <td>{pr.contour.kind}</td>
                <td>{pr.ending.finalBeats} beat{pr.ending.decelerates ? <ArrowDown {...IC_SM} /> : null}</td>
                <td>{pct(s.confidence)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Strongest boundary candidates</h3>
      <ul className="co-cands" data-testid="co-candidates">
        {top.map((c) => (
          <li key={c.index}>
            <button onClick={() => onBoundary(c.index)}>
              bar {a.rhythm.bars[c.bar]!.number} · {pct(c.score)}
            </button>{" "}
            {c.selected ? <b>chosen</b> : <span className="muted">not chosen</span>} — {c.evidence.map((e) => e.kind).join(" + ")}
          </li>
        ))}
      </ul>
      {p.relations.length > 0 && (
        <>
          <h3>How the phrases relate <small className="muted">(primary reading)</small></h3>
          <p>{p.relations.filter((r) => r.kind !== "contrast").map((r) => `${r.from}→${r.to}: ${r.kind.replace(/-/g, " ")}`).join(" · ") || "no repetition between phrases; each contrasts with the next"}</p>
        </>
      )}
      {p.sections.length > 0 && (
        <p className="muted">Written sections: {p.sections.map((s) => `${s.kind.replace(/-/g, " ")} bars ${a.rhythm.bars[s.startBar]!.number}–${a.rhythm.bars[s.endBar]!.number}`).join("; ")}</p>
      )}
    </div>
  );
}

function HarmonyTab({ a }: { a: corpus.MelodyAnalysis }) {
  const h = a.harmony;
  if (!h.present) return <p data-testid="co-harmony">{h.reason}. Nothing is inferred.</p>;
  const roleName = (k: string) => (k === "nct" ? "non-chord tone" : `${k} st above root`);
  return (
    <div data-testid="co-harmony">
      <p className="muted">Notes are related only to the chord symbols the score writes, as semitones above each chord root.</p>
      <div className="co-figs">
        <Fig k="chords written" v={h.chordCount} />
        <Fig k="notes under a chord" v={pct(h.annotatedShare)} />
        <Fig k="chord tones" v={pct(h.chordToneShare)} />
        <Fig k="chord changes on a downbeat" v={pct(h.changeOnDownbeatShare)} />
        <Fig k="harmonic rhythm (beats)" v={`${h.harmonicRhythm.median} median`} />
      </div>
      <div className="co-cols">
        <div>
          <h3>Chord tones by metric strength</h3>
          <Bars max={1} items={[{ label: "strong", value: h.chordToneShareByStrength.strong, text: pct(h.chordToneShareByStrength.strong) }, { label: "beat", value: h.chordToneShareByStrength.beat, text: pct(h.chordToneShareByStrength.beat) }, { label: "weak", value: h.chordToneShareByStrength.weak, text: pct(h.chordToneShareByStrength.weak) }]} />
        </div>
        <div>
          <h3>Role of each note</h3>
          <Bars items={Object.entries(h.noteRoles).map(([k, v]) => ({ label: roleName(k), value: v }))} />
        </div>
        <div>
          <h3>Non-chord tones</h3>
          <Bars items={Object.entries(h.nonChordTones).map(([k, v]) => ({ label: k.replace(/-/g, " "), value: v }))} />
        </div>
      </div>
    </div>
  );
}

function SourceTab({ loaded }: { loaded: Loaded }) {
  const { piece, report } = loaded;
  const f = report?.fidelity;
  return (
    <div data-testid="co-source">
      <h3>Provenance</h3>
      <table className="co-facts">
        <tbody>
          <tr><th>corpus</th><td>{piece.provenance.corpus.name} — {piece.provenance.corpus.license}</td></tr>
          <tr><th>use</th><td>{piece.provenance.corpus.usage}</td></tr>
          {Object.entries(piece.provenance.catalog).filter(([k]) => ["source_annotation", "category", "meter", "key", "composer", "transcriber", "original_file", "original_X"].includes(k)).map(([k, v]) => (
            <tr key={k}><th>{k.replace(/_/g, " ")}</th><td>{v}</td></tr>
          ))}
          <tr><th>converted</th><td>{piece.provenance.conversion?.tool ?? "—"} from {piece.provenance.conversion?.from ?? "?"}; XML claims creator “{piece.provenance.xml.creatorField ?? "—"}” (a converter artefact, not used)</td></tr>
        </tbody>
      </table>
      {f && (
        <>
          <h3>Fidelity to the original notation</h3>
          {f.checked ? (
            <p data-testid="co-fidelity">
              ABC: {f.abcNotes} notes, {f.abcRests} rests · converted score: {f.xmlNotes} notes, {f.xmlRests} rests ·{" "}
              {f.lostNotes === 0 && f.extraNotes === 0 ? <b className="ok">notes match</b> : <b className="bad">{f.lostNotes} note(s) lost, {f.extraNotes} added</b>} · {f.paddingRests.length} rest(s) suspected as converter padding
            </p>
          ) : (
            <p className="muted">Not compared: {f.reason}</p>
          )}
        </>
      )}
      <h3>Import report</h3>
      {report && report.issues.length > 0 ? (
        <ul className="co-issues" data-testid="co-issues">
          {report.issues.map((i, k) => (
            <li key={k} className={i.severity}>
              <b>{i.severity}</b> {i.code}
              {i.measure ? ` (bar ${i.measure})` : ""}: {i.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">no issues</p>
      )}
      {report && report.irLoss.length > 0 && (
        <>
          <h3>What MusicIR cannot hold from this piece</h3>
          <p className="muted">Kept in the notation record, not in the MusicIR used for playback: {report.irLoss.join("; ")}.</p>
        </>
      )}
      {piece.provenance.originalNotation && (
        <details>
          <summary>Original notation ({piece.provenance.originalNotation.format.toUpperCase()}, preserved verbatim)</summary>
          <pre className="co-abc">{piece.provenance.originalNotation.text}</pre>
        </details>
      )}
    </div>
  );
}
