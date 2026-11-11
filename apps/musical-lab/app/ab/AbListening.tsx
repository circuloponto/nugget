"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, Pause, Play } from "lucide-react";
import { corpus, PLUCK_TONES, renderDocument, type MusicIR } from "@musical-lab/engine";
import { LabPlayer } from "../lab/player";
import { IC, IC_SM } from "../ui/icons";

type Choice = "X" | "Y" | "same";
type Ratings = Record<string, Record<string, Choice>>;
interface StudyRow {
  id: string;
  pairs: number;
  done: number;
  total: number;
  revealed: boolean;
}
interface Loaded {
  study: corpus.AbStudy;
  ratings: Ratings;
  notes: Record<string, string>;
  revealed: boolean;
}
interface Revealed {
  tally: corpus.AbTally[];
  key: Record<string, { X: "A" | "B"; Y: "A" | "B" }>;
}

const SAMPLE_RATE_HINT = 44100;

/**
 * Blind A/B listening. Each pair is two phrases over the same harmony, labelled only X and Y. Nothing on this screen
 * says which generator made which; the answer is kept on the server until every pair has been judged on both questions.
 */
export default function AbListening({ active = true }: { active?: boolean }) {
  const playerRef = useRef<LabPlayer | null>(null);
  const [studies, setStudies] = useState<StudyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState<"x" | "y" | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = (await (await fetch("/api/ab")).json()) as { available: boolean; reason?: string; studies?: StudyRow[] };
      if (!r.available) return setError(r.reason ?? "Not available.");
      setStudies(r.studies ?? []);
      const first = r.studies?.[0];
      if (first) {
        const s = (await (await fetch(`/api/ab?study=${first.id}`)).json()) as Loaded & { error?: string };
        if (s.error) setError(s.error);
        else {
          setLoaded(s);
          if (s.revealed) {
            const rv = (await (await fetch(`/api/ab?study=${first.id}&reveal=1`)).json()) as Revealed & { error?: string };
            if (!rv.error) setRevealed(rv);
          }
        }
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const p = new LabPlayer();
    playerRef.current = p;
    const timer = setInterval(() => {
      // reading the position also lets a one-shot notice that it has finished
      p.position();
      if (!p.isPlaying) setPlaying(null);
    }, 150);
    return () => {
      clearInterval(timer);
      p.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active) {
      playerRef.current?.pause();
      setPlaying(null);
    }
  }, [active]);

  const pair = loaded?.study.pairs[index] ?? null;
  const rendered = useRef(new Map<string, Float32Array>());

  const play = useCallback(async (slot: "x" | "y", ir: MusicIR) => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying) {
      p.pause();
      if (playing === slot) return setPlaying(null);
    }
    const id = `${ir.id}@${p.sampleRate}`;
    let samples = rendered.current.get(id);
    if (!samples) {
      samples = renderDocument(ir, { sampleRate: p.sampleRate || SAMPLE_RATE_HINT, tone: PLUCK_TONES.sine }).samples;
      rendered.current.set(id, samples);
    }
    p.load(samples, 0);
    p.setMode(false, null); // one pass: the phrase plays once and stops
    p.seek(0);
    await p.play();
    setPlaying(slot);
  }, [playing]);

  const rate = useCallback(
    async (pairId: string, question: string, choice: Choice) => {
      if (!loaded || loaded.revealed) return;
      setLoaded({ ...loaded, ratings: { ...loaded.ratings, [pairId]: { ...(loaded.ratings[pairId] ?? {}), [question]: choice } } });
      const r = await fetch("/api/ab", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ study: loaded.study.id, pair: pairId, question, choice }) });
      if (!r.ok) setError(((await r.json()) as { error?: string }).error ?? "Could not save that judgement.");
    },
    [loaded],
  );

  const progress = useMemo(() => {
    if (!loaded) return { done: 0, total: 0 };
    const total = loaded.study.pairs.length * loaded.study.questions.length;
    const done = loaded.study.pairs.reduce((a, p) => a + loaded.study.questions.filter((q) => loaded.ratings[p.id]?.[q.id] !== undefined).length, 0);
    return { done, total };
  }, [loaded]);

  const doReveal = async () => {
    if (!loaded) return;
    playerRef.current?.pause();
    const r = (await (await fetch(`/api/ab?study=${loaded.study.id}&reveal=1`)).json()) as Revealed & { error?: string };
    if (r.error) return setError(r.error);
    setRevealed(r);
    setLoaded({ ...loaded, revealed: true });
  };

  return (
    <div className="ab2" data-testid="ab-view">
      {error && (
        <div className="banner error" role="alert" data-testid="ab-error">
          {error}
        </div>
      )}
      {studies && studies.length === 0 && (
        <div className="stage-empty" data-testid="ab-empty">
          <div>
            <b>No listening study yet</b>
            Build one with: npm run ab -- data/corpus/incoming/nugget_folk_starter.zip
          </div>
        </div>
      )}
      {!studies && !error && <div className="stage-empty">Loading…</div>}

      {loaded && pair && !revealed && (
        <section className="card ab2-card" aria-label="Listening">
          <header className="ab2-head">
            <h2>
              Pair {index + 1} of {loaded.study.pairs.length}
            </h2>
            <span className="muted" data-testid="ab-progress">
              {progress.done} of {progress.total} judgements
            </span>
          </header>
          <p className="muted">
            Two phrases over the same chords. Listen to each as often as you like; the order is random and nothing here says how they were made. Only the label is hidden: if one sounds different in some plain way, that is a fair thing to judge.
          </p>
          <div className="ab2-pair">
            {(["x", "y"] as const).map((slot) => (
              <div key={slot} className="ab2-side">
                <b className="ab2-label">{slot.toUpperCase()}</b>
                <button className="btn primary" onClick={() => void play(slot, pair[slot].ir)} data-testid={`ab-play-${slot}`}>
                  {playing === slot ? <Pause {...IC} /> : <Play {...IC} />} {playing === slot ? "Stop" : "Play"} {slot.toUpperCase()}
                </button>
              </div>
            ))}
          </div>
          {loaded.study.questions.map((q) => (
            <fieldset key={q.id} className="ab2-q" disabled={loaded.revealed}>
              <legend>{q.text}</legend>
              {(["X", "Y", "same"] as const).map((c) => (
                <label key={c} className={loaded.ratings[pair.id]?.[q.id] === c ? "on" : ""}>
                  <input type="radio" name={`${pair.id}-${q.id}`} checked={loaded.ratings[pair.id]?.[q.id] === c} onChange={() => void rate(pair.id, q.id, c)} data-testid={`ab-${q.id}-${c}`} />
                  {c === "same" ? "No clear difference" : c}
                </label>
              ))}
            </fieldset>
          ))}
          <footer className="ab2-nav">
            <button className="btn" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} data-testid="ab-prev">
              <ArrowLeft {...IC_SM} /> Previous
            </button>
            <button className="btn" onClick={() => setIndex((i) => Math.min(loaded.study.pairs.length - 1, i + 1))} disabled={index === loaded.study.pairs.length - 1} data-testid="ab-next">
              Next <ArrowRight {...IC_SM} />
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={() => void doReveal()} disabled={progress.done < progress.total} title={progress.done < progress.total ? "Judge every pair on both questions first" : "Show which generator was which"} data-testid="ab-reveal">
              <Eye {...IC_SM} /> Reveal
            </button>
          </footer>
        </section>
      )}

      {revealed && loaded && (
        <section className="card ab2-card" data-testid="ab-result" aria-label="Result">
          <h2>Result</h2>
          <table className="ab2-table">
            <thead>
              <tr>
                <th>question</th>
                <th>Generator A preferred</th>
                <th>Generator B preferred</th>
                <th>no clear difference</th>
              </tr>
            </thead>
            <tbody>
              {revealed.tally.map((t) => (
                <tr key={t.question}>
                  <td>{loaded.study.questions.find((q) => q.id === t.question)?.text}</td>
                  <td>{t.A}</td>
                  <td>{t.B}</td>
                  <td>{t.noDifference}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            {loaded.study.pairs.length} pairs, one listener. That is a first impression, not a measurement: it is too few to call a winner, the pairs come from a few keys and seeds, and the phrases were chosen to be similar in length, not at random. The judgements are stored in data/ab/{loaded.study.id}/ratings.json for later review.
          </p>
        </section>
      )}
    </div>
  );
}
