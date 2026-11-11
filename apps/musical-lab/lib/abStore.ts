/**
 * Server-side storage for the blind A/B listening study (data/ab/<study-id>/, written by scripts/ab.mjs).
 *
 * The listening view gets only study.json (phrases labelled X and Y, nothing naming the maker). key.json, which says
 * which of X and Y is Generator A, is read only by `reveal`, and only once every pair has been judged on every
 * question; after that the ratings are locked. File names come from a validated study id and pair/question ids,
 * never from free text.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { corpus } from "@musical-lab/engine";

const STUDY_ID = /^ab-[0-9a-f]{10}$/;
const PAIR_ID = /^p\d{2}$/;
const CHOICES = ["X", "Y", "same"] as const;
type Choice = (typeof CHOICES)[number];

function abRoot(): string | null {
  let dir = resolve(/*turbopackIgnore: true*/ process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "data", "ab");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

interface RatingsFile {
  schema: "nugget-ab-ratings";
  studyId: string;
  ratings: Record<string, Record<string, Choice>>;
  notes?: Record<string, string>;
  revealed: boolean;
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const dirOf = (id: string): string | null => {
  const root = abRoot();
  if (!root || !STUDY_ID.test(id)) return null;
  const d = join(/*turbopackIgnore: true*/ root, id);
  return existsSync(join(d, "study.json")) ? d : null;
};
const ratingsOf = (d: string, id: string): RatingsFile => (existsSync(join(d, "ratings.json")) ? read<RatingsFile>(join(d, "ratings.json")) : { schema: "nugget-ab-ratings", studyId: id, ratings: {}, revealed: false });

const progress = (study: corpus.AbStudy, r: RatingsFile) => {
  const total = study.pairs.length * corpus.AB_QUESTIONS.length;
  const done = study.pairs.reduce((a, p) => a + corpus.AB_QUESTIONS.filter((q) => r.ratings[p.id]?.[q.id] !== undefined).length, 0);
  return { done, total };
};

export function listStudies(): { id: string; pairs: number; done: number; total: number; revealed: boolean }[] {
  const root = abRoot();
  if (!root) return [];
  return readdirSync(root)
    .filter((id) => STUDY_ID.test(id) && existsSync(join(/*turbopackIgnore: true*/ root, id, "study.json")))
    .sort()
    .map((id) => {
      const d = join(/*turbopackIgnore: true*/ root, id);
      const study = read<corpus.AbStudy>(join(d, "study.json"));
      const r = ratingsOf(d, id);
      return { id, pairs: study.pairs.length, ...progress(study, r), revealed: r.revealed };
    });
}

export function loadStudy(id: string): { study: corpus.AbStudy; ratings: RatingsFile["ratings"]; notes: Record<string, string>; revealed: boolean } | null {
  const d = dirOf(id);
  if (!d) return null;
  const r = ratingsOf(d, id);
  return { study: read<corpus.AbStudy>(join(d, "study.json")), ratings: r.ratings, notes: r.notes ?? {}, revealed: r.revealed };
}

export type RateResult = { ok: true; done: number; total: number } | { ok: false; status: number; error: string };

export function saveRating(id: string, pairId: string, questionId: string, choice: string, note?: string): RateResult {
  const d = dirOf(id);
  if (!d) return { ok: false, status: 404, error: "No such study." };
  const study = read<corpus.AbStudy>(join(d, "study.json"));
  if (!PAIR_ID.test(pairId) || !study.pairs.some((p) => p.id === pairId)) return { ok: false, status: 400, error: "Unknown pair." };
  if (!corpus.AB_QUESTIONS.some((q) => q.id === questionId)) return { ok: false, status: 400, error: "Unknown question." };
  if (!(CHOICES as readonly string[]).includes(choice)) return { ok: false, status: 400, error: "The choice must be X, Y or same." };
  const r = ratingsOf(d, id);
  if (r.revealed) return { ok: false, status: 409, error: "The study has been revealed; its ratings are locked." };
  r.ratings[pairId] = { ...(r.ratings[pairId] ?? {}), [questionId]: choice as Choice };
  if (note !== undefined) r.notes = { ...(r.notes ?? {}), [pairId]: note.slice(0, 500) };
  writeFileSync(join(d, "ratings.json"), JSON.stringify(r, null, 2) + "\n");
  return { ok: true, ...progress(study, r) };
}

export type RevealResult = { ok: true; tally: corpus.AbTally[]; key: corpus.AbKey["pairs"] } | { ok: false; status: number; error: string };

/** The key, only when every pair has been judged on every question. Locks the ratings. */
export function reveal(id: string): RevealResult {
  const d = dirOf(id);
  if (!d || !existsSync(join(d, "key.json"))) return { ok: false, status: 404, error: "No such study." };
  const study = read<corpus.AbStudy>(join(d, "study.json"));
  const r = ratingsOf(d, id);
  const { done, total } = progress(study, r);
  if (done < total) return { ok: false, status: 409, error: `Judge every pair first (${done} of ${total} done); the answer stays sealed until then.` };
  const key = read<corpus.AbKey>(join(d, "key.json"));
  if (!r.revealed) writeFileSync(join(d, "ratings.json"), JSON.stringify({ ...r, revealed: true }, null, 2) + "\n");
  return { ok: true, tally: corpus.tallyAb(key, r.ratings), key: key.pairs };
}
