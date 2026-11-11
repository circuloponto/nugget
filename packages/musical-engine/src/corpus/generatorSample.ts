/**
 * A reproducible sample of what Nugget's generator produces, as MelodyLines the corpus analysis can read.
 *
 * It runs exactly the path the Phrase Constructor runs (a PhraseRequest → explorePhrases → phraseToIR) over several
 * keys and seeds, so the numbers describe the generator as a user meets it, not a special test configuration. Each run
 * (one key, one seed) returns the handful of contrasting phrases the engine selects; runs are the unit over which the
 * generator's own variability is measured.
 */
import { DEFAULT_PHRASE_REQUEST, generationSpaceFromRequest, type PhraseRequest } from "../grammar/request";
import { explorePhrases, type ExploredPhrase } from "../grammar/explore";
import { phraseToIR } from "../grammar/document";
import { melodyFromIR, type MelodyLine } from "./analysis/melody";
import type { MusicIR } from "../ir/types";

export const SAMPLE_KEYS: readonly string[] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export interface GeneratedPhrase {
  readonly line: MelodyLine;
  readonly traits: ExploredPhrase["traits"];
  readonly chips: readonly string[];
  /** The playable document the line was read from. */
  readonly ir?: MusicIR;
  /** Generator B only: what was drawn from the corpus profile for this phrase, so the draw can be checked. */
  readonly sampled?: { readonly finalBeats: number; readonly activityShape: string; readonly density: string; readonly relation: string; readonly parent: number | null };
}

export interface GeneratorRun {
  readonly key: string;
  readonly mode: "major" | "minor";
  readonly seed: number;
  /** Which generator made the run. Absent means A, the original generator. */
  readonly generator?: "A" | "B";
  readonly phrases: readonly GeneratedPhrase[];
  /** Set when the engine returned fewer than asked, or failed; the run is kept so nothing is hidden. */
  readonly note?: string;
}

export interface GeneratorSampleOptions {
  readonly keys?: readonly string[];
  readonly modes?: readonly ("major" | "minor")[];
  readonly seeds?: readonly number[];
  /** Phrases requested per run (the engine may return fewer rather than pad). */
  readonly count?: number;
  /** Start from this request instead of the default. */
  readonly base?: PhraseRequest;
}

export function sampleGenerator(options: GeneratorSampleOptions = {}): GeneratorRun[] {
  const keys = options.keys ?? SAMPLE_KEYS;
  const modes = options.modes ?? ["major"];
  const seeds = options.seeds ?? [1, 2, 3];
  const base = options.base ?? DEFAULT_PHRASE_REQUEST;
  const runs: GeneratorRun[] = [];
  for (const mode of modes) {
    for (const key of keys) {
      for (const seed of seeds) {
        const req: PhraseRequest = { ...base, tonic: key, mode, exploration: { ...base.exploration, seed, ...(options.count ? { count: options.count } : {}) } };
        const result = explorePhrases(generationSpaceFromRequest(req));
        if (!result.ok) {
          runs.push({ key, mode, seed, phrases: [], note: `engine refused: ${result.reason}` });
          continue;
        }
        const phrases = result.candidates.map((c) => {
          const ir = phraseToIR(c, c.spec, { bpm: req.bpm, bass: false });
          const line = melodyFromIR(ir, { key: { tonic: key, mode: mode === "major" ? "major" : "minor" }, origin: "generated" });
          return { line: { ...line, id: `${key}-${mode}-s${seed}-${c.id}` }, traits: c.traits, chips: c.chips, ir };
        });
        runs.push({ key, mode, seed, phrases, ...(result.stats.note ? { note: result.stats.note } : {}) });
      }
    }
  }
  return runs;
}
