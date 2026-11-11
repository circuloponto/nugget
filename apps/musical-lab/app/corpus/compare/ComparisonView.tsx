"use client";

import { useEffect, useMemo, useState } from "react";
import type { corpus } from "@musical-lab/engine";

type Comparison = corpus.GeneratorComparison;
type Row = corpus.MetricRow;
type Dists = corpus.Distributions;

const COLORS = { generator: "#1f6f8b", corpus: "#b8976c", fourFour: "#6b5a3e" } as const;
const GROUPS: { id: corpus.MetricGroup | "all"; name: string }[] = [
  { id: "all", name: "all" },
  { id: "size", name: "size" },
  { id: "rhythm", name: "rhythm" },
  { id: "silence", name: "silence" },
  { id: "melody", name: "melody" },
  { id: "contour", name: "contour" },
  { id: "ending", name: "endings" },
  { id: "diversity", name: "diversity" },
];

const fmt = (v: number, unit: Row["unit"]): string => (unit === "share" ? `${Math.round(v * 1000) / 10}%` : unit === "score" ? v.toFixed(2) : String(Math.round(v * 100) / 100));

export default function ComparisonView() {
  const [state, setState] = useState<{ comparison?: Comparison | null; reason?: string; error?: string } | null>(null);
  const [group, setGroup] = useState<(typeof GROUPS)[number]["id"]>("all");
  const [onlyOutside, setOnlyOutside] = useState(false);

  useEffect(() => {
    fetch("/api/corpus?comparison=1")
      .then((r) => r.json())
      .then((d: { available: boolean; comparison?: Comparison | null; reason?: string }) => setState(d.available ? { comparison: d.comparison ?? null, reason: d.reason } : { reason: d.reason }))
      .catch((e) => setState({ error: String(e) }));
  }, []);

  const c = state?.comparison ?? null;
  const rows = useMemo(() => (c ? c.rows.filter((r) => (group === "all" || r.group === group) && (!onlyOutside || r.verdict !== "within")) : []), [c, group, onlyOutside]);
  const outside = c ? c.rows.filter((r) => r.verdict !== "within").length : 0;

  return (
    <main className="lab lab2 co">
      <header className="lab2-head">
        <div>
          <h1>
            Generator against the corpus <span>phase 3H.4</span>
          </h1>
          <p>
            Phrases written by Nugget&apos;s Phase 3 generator, measured by exactly the same analysis as the real melodies. A difference is where to look, not a verdict on quality. <a href="/corpus">← Corpus Analysis</a> · <a href="/">Musical Lab</a>
          </p>
        </div>
      </header>

      {state?.error && <div className="panel error" role="alert">{state.error}</div>}
      {state && !c && !state.error && (
        <div className="panel co-empty" data-testid="cmp-unavailable">
          <h2>No comparison to show</h2>
          <p>{state.reason ?? "Nothing to show."}</p>
        </div>
      )}
      {!state && <div className="panel muted">Loading…</div>}

      {c && (
        <>
          <section className="panel co-notice" role="note" data-testid="cmp-caveats">
            <b>Read this first.</b>
            <ul>
              {c.caveats.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </section>

          <section className="panel" data-testid="cmp-summary">
            <h2>
              What was compared <small>same analysis on both sides</small>
            </h2>
            <div className="co-figs">
              <Fig k="generated phrases" v={`${c.sample.phrases} from ${c.sample.runs} runs`} hint={`${c.sample.keys.length} keys × seeds ${c.sample.seeds.join(", ")}; every phrase in ${c.sample.meter}`} />
              <Fig k="corpus phrases" v={`${c.corpus.phrases} from ${c.corpus.pieces} tunes`} hint="the corpus's hypothesised phrases at the primary reading" />
              <Fig k="corpus 4/4 only" v={`${c.corpus.fourFourPhrases} from ${c.corpus.fourFourPieces} tunes`} hint="the generator writes only 4/4" />
              <Fig k="development / held-out" v={`${c.corpus.split.development.length} / ${c.corpus.split.heldOut.length} tunes`} hint="fixed split by category and hash, for later work" />
              <Fig k="outside the corpus's range" v={`${outside} of ${c.rows.length} metrics`} hint="generator value outside the 10th–90th percentile of individual corpus tunes" />
            </div>
            <div className="co-legend2">
              <i style={{ background: COLORS.generator }} /> generator <i style={{ background: COLORS.corpus }} /> whole corpus <i style={{ background: COLORS.fourFour }} /> corpus, 4/4 tunes only <span className="co-band-key" /> corpus spread (10th–90th percentile across tunes)
            </div>
          </section>

          <section className="panel" data-testid="cmp-metrics">
            <h2>
              Metric by metric <small>dot = generator · tick = corpus · hollow = corpus 4/4 · band = how much individual corpus tunes differ</small>
            </h2>
            <div className="co-level" role="group" aria-label="Metric group">
              {GROUPS.map((g) => (
                <button key={g.id} className={group === g.id ? "on" : ""} onClick={() => setGroup(g.id)} data-testid={`cmp-group-${g.id}`}>
                  {g.name}
                </button>
              ))}
              <label className="check">
                <input type="checkbox" checked={onlyOutside} onChange={(e) => setOnlyOutside(e.target.checked)} data-testid="cmp-outside" /> only metrics outside the corpus&apos;s range
              </label>
              <span className="muted" data-testid="cmp-rowcount">{rows.length} shown</span>
            </div>
            <div className="cmp-rows">
              {rows.map((r) => (
                <RangeRow key={r.id} row={r} />
              ))}
            </div>
          </section>

          <section className="panel" data-testid="cmp-dists">
            <h2>
              Distributions <small>the same measures, side by side</small>
            </h2>
            <div className="co-cols">
              <Grouped title="Note lengths (share of notes)" d={c.distributions} pick={(d) => d.durationClasses} testId="cmp-durations" />
              <Grouped title="Last note of the phrase" d={c.distributions} pick={(d) => d.finalBeats} testId="cmp-final" />
              <Grouped title="Phrase contour" d={c.distributions} pick={(d) => d.contour} testId="cmp-contour" />
              <Grouped title="Activity shape" d={c.distributions} pick={(d) => d.activityShape} testId="cmp-activity-shape" />
            </div>
            <Grouped title="Melodic intervals (semitones, share of intervals)" d={c.distributions} pick={(d) => d.intervals} testId="cmp-intervals" wide />
            <ActivityCurve d={c.distributions} />
          </section>

          <section className="panel" data-testid="cmp-examples">
            <h2>
              Phrases to look at <small>chosen at even intervals, not picked; drawn on the same scale rules</small>
            </h2>
            <h3 className="cmp-h3">Generator</h3>
            <div className="cmp-ex">
              {c.examples.generator.map((e) => (
                <MiniRoll key={e.id} e={e} />
              ))}
            </div>
            <h3 className="cmp-h3">Corpus</h3>
            <div className="cmp-ex">
              {c.examples.corpus.map((e) => (
                <MiniRoll key={e.id} e={e} />
              ))}
            </div>
            <p className="muted">Bar height in each drawing is the note&apos;s length class (short, medium, sustained); hatched blocks are written rests. These are pictures of rhythm and contour, not recordings: listening comes in the next stage.</p>
          </section>
        </>
      )}
    </main>
  );
}

function Fig({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="co-fig" title={hint}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

function RangeRow({ row }: { row: Row }) {
  const top = Math.max(row.unit === "share" ? 0.05 : 0.01, row.generator, row.corpus, row.corpusFourFour, row.corpusSpread[1], row.generatorSpread[1]) * 1.12;
  const p = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
  return (
    <div className={`cmp-row ${row.verdict}`} data-metric={row.id} data-verdict={row.verdict} title={row.description}>
      <div className="cmp-label">
        <b>{row.label}</b>
        <span>{row.group}</span>
      </div>
      <div className="cmp-track" role="img" aria-label={`${row.label}: generator ${fmt(row.generator, row.unit)}, corpus ${fmt(row.corpus, row.unit)}`}>
        <i className="cmp-band" style={{ left: p(row.corpusSpread[0]), width: `calc(${p(row.corpusSpread[1])} - ${p(row.corpusSpread[0])})` }} />
        <i className="cmp-gspread" style={{ left: p(row.generatorSpread[0]), width: `calc(${p(row.generatorSpread[1])} - ${p(row.generatorSpread[0])})` }} />
        <i className="cmp-tick corpus" style={{ left: p(row.corpus) }} />
        <i className="cmp-tick four" style={{ left: p(row.corpusFourFour) }} />
        <i className="cmp-dot" style={{ left: p(row.generator) }} />
      </div>
      <div className="cmp-nums">
        <span style={{ color: COLORS.generator }}>{fmt(row.generator, row.unit)}</span>
        <span style={{ color: COLORS.corpus }}>{fmt(row.corpus, row.unit)}</span>
        <span style={{ color: COLORS.fourFour }}>{fmt(row.corpusFourFour, row.unit)}</span>
      </div>
      <div className="cmp-verdict">{row.verdict === "within" ? "within" : row.verdict === "above" ? "▲ above" : "▼ below"}</div>
    </div>
  );
}

function Grouped({ title, d, pick, testId, wide }: { title: string; d: Comparison["distributions"]; pick: (x: Dists) => Readonly<Record<string, number>>; testId: string; wide?: boolean }) {
  const labels = Object.keys(pick(d.generator));
  const series = [
    { name: "generator", color: COLORS.generator, v: pick(d.generator) },
    { name: "corpus", color: COLORS.corpus, v: pick(d.corpus) },
    { name: "corpus 4/4", color: COLORS.fourFour, v: pick(d.corpusFourFour) },
  ];
  const max = Math.max(0.05, ...series.flatMap((s) => Object.values(s.v)));
  const W = wide ? 760 : 300;
  const H = 120;
  const gw = (W - 10) / labels.length;
  const bw = Math.max(2, (gw - 4) / 3);
  return (
    <div className={wide ? "cmp-wide" : ""} data-testid={testId}>
      <h3 className="cmp-h3">{title}</h3>
      <svg viewBox={`0 0 ${W} ${H + 34}`} width="100%" role="img" aria-label={title}>
        {labels.map((l, i) => (
          <g key={l}>
            {series.map((s, k) => {
              const h = ((s.v[l] ?? 0) / max) * H;
              return (
                <rect key={s.name} x={5 + i * gw + k * bw} y={H - h} width={bw - 0.5} height={h} fill={s.color} data-series={s.name} data-label={l} data-value={s.v[l] ?? 0}>
                  <title>{`${s.name}: ${Math.round((s.v[l] ?? 0) * 1000) / 10}% · ${l}`}</title>
                </rect>
              );
            })}
            <text x={5 + i * gw + gw / 2 - 2} y={H + 12} fontSize={wide ? 9 : 8.5} textAnchor="middle" fill="var(--stone)" transform={labels.length > 7 && !wide ? `rotate(35 ${5 + i * gw + gw / 2} ${H + 12})` : undefined}>
              {l.length > 14 ? l.slice(0, 13) + "…" : l}
            </text>
          </g>
        ))}
        <line x1={5} x2={W - 5} y1={H} y2={H} stroke="var(--stone-light)" />
      </svg>
    </div>
  );
}

function ActivityCurve({ d }: { d: Comparison["distributions"] }) {
  const W = 760;
  const H = 120;
  const series = [
    { name: "generator", color: COLORS.generator, v: d.generator.activityCurve },
    { name: "corpus", color: COLORS.corpus, v: d.corpus.activityCurve },
    { name: "corpus 4/4", color: COLORS.fourFour, v: d.corpusFourFour.activityCurve },
  ];
  const max = Math.max(0.05, ...series.flatMap((s) => s.v));
  const x = (i: number) => 20 + (i / (series[0]!.v.length - 1)) * (W - 40);
  const y = (v: number) => H - 8 - (v / max) * (H - 20);
  return (
    <div data-testid="cmp-curve">
      <h3 className="cmp-h3">Where the attacks fall in a phrase (share of its notes in each tenth of its time)</h3>
      <svg viewBox={`0 0 ${W} ${H + 24}`} width="100%" role="img" aria-label="activity curves over the phrase">
        {series.map((s) => (
          <g key={s.name}>
            <path d={s.v.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2.2} data-series={s.name} />
            {s.v.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={2.6} fill={s.color} />
            ))}
          </g>
        ))}
        {series[0]!.v.map((_, i) => (
          <text key={i} x={x(i)} y={H + 14} fontSize={9} textAnchor="middle" fill="var(--stone)">
            {i * 10}–{i * 10 + 10}%
          </text>
        ))}
        <line x1={10} x2={W - 10} y1={H - 4} y2={H - 4} stroke="var(--stone-light)" />
      </svg>
      <p className="muted">A phrase that arrives on a held note shows an empty last stretch (the held note takes time but is one attack).</p>
    </div>
  );
}

function MiniRoll({ e }: { e: corpus.ExamplePhrase }) {
  const W = 250;
  const H = 74;
  const span = Math.max(1e-9, e.span);
  const ms = e.notes.map((n) => n.midi);
  const lo = Math.min(...ms);
  const hi = Math.max(...ms, lo + 1);
  const x = (t: number) => 4 + (t / span) * (W - 8);
  const y = (m: number) => H - 8 - ((m - lo) / (hi - lo)) * (H - 22);
  const last = e.notes[e.notes.length - 1]!;
  return (
    <figure className="cmp-mini" data-example={e.id}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`phrase ${e.label}`}>
        {e.rests.map((r, i) => (
          <rect key={i} x={x(r.at)} y={4} width={Math.max(2, (r.len / span) * (W - 8))} height={H - 8} className="co-rest" />
        ))}
        {e.notes.map((n, i) => {
          const beats = n.len / 0.25;
          const cls = beats <= 0.5 + 1e-9 ? "co-short" : beats >= 1 - 1e-9 ? "co-long" : "co-mid";
          return <rect key={i} x={x(n.at)} y={y(n.midi) - 3} width={Math.max(2.5, (n.len / span) * (W - 8) - 1)} height={6} rx={2} className={`co-note ${cls} w${n.weight}`} />;
        })}
      </svg>
      <figcaption>
        {e.label.length > 34 ? e.label.slice(0, 33) + "…" : e.label}
        <span>
          {e.notes.length} notes · ends on {Math.round((last.len / 0.25) * 10) / 10} beat(s)
        </span>
      </figcaption>
    </figure>
  );
}
