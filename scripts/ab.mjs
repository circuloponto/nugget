#!/usr/bin/env node
/**
 * Generator A against Generator B (Phase 3H.5 / 3H.6 prototype).
 *
 *   npm run build:engine
 *   node scripts/ab.mjs data/corpus/incoming/nugget_folk_starter.zip [--keys C,D,Eb,F,G,A] [--seeds 1,2,3] [--phrases 4] [--pairs 12] [--seed 1]
 *
 * Builds one matched set per generator: the same keys, modes, seeds, request (so the same harmony, register, leap and
 * fret limits and density settings) and at most the same number of phrases per run. Generator B is steered by a profile
 * derived only from the development half of the corpus; Generator A is the original generator, untouched.
 *
 * Writes data/ab/<study-id>/:
 *   study.json    what the listening view shows: pairs of phrases labelled only X and Y, with nothing naming the maker
 *   key.json      which of X and Y is A in each pair; the listening view does not read it until every pair is judged
 *   report.json   how the two sets measure against the corpus, with the profile and the set sizes
 *   ratings.json  the judgements, filled in by the listening view
 * Deterministic: the same archive and options give the same study id. Existing ratings are never overwritten.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "packages/musical-engine/dist/index.js");
if (!existsSync(distEntry)) {
  console.error("The engine is not built. Run: npm run build:engine");
  process.exit(2);
}
const { corpus, DEFAULT_PHRASE_REQUEST } = await import(new URL(`file:///${distEntry.replace(/\\/g, "/")}`).href);

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const zipArg = process.argv[2];
if (!zipArg || zipArg.startsWith("--")) {
  console.error("usage: node scripts/ab.mjs <archive.zip> [--keys C,D] [--seeds 1,2,3] [--phrases 4] [--pairs 12] [--seed 1]");
  process.exit(2);
}
const keys = arg("--keys")?.split(",") ?? ["C", "D", "Eb", "F", "G", "A"];
const seeds = arg("--seeds")?.split(",").map(Number) ?? [1, 2, 3];
const phrasesPerRun = Number(arg("--phrases") ?? 4);
const pairsWanted = Number(arg("--pairs") ?? 12);
const coinSeed = Number(arg("--seed") ?? 1);

const imported = corpus.importArchive(await corpus.readZip(new Uint8Array(readFileSync(resolve(zipArg)))));
const pieces = imported.pieces.map((p) => p.piece);
const split = corpus.splitCorpus(pieces.map((p) => ({ id: p.id, category: p.provenance.catalog.category ?? "" })));
const profile = corpus.deriveCorpusProfile(pieces, split, imported.corpus.name);
console.log(`corpus: ${pieces.length} pieces; profile from ${profile.source.pieceIds.length} development pieces (${profile.source.phrases} phrases, ${profile.source.pairs} neighbouring pairs); ${split.heldOut.length} held out`);

const t0 = Date.now();
const runsA = corpus.sampleGenerator({ keys, seeds, count: phrasesPerRun, base: DEFAULT_PHRASE_REQUEST });
const runsB = corpus.sampleGeneratorB(profile, { keys, seeds, phrasesPerRun, base: DEFAULT_PHRASE_REQUEST });
const count = (runs) => runs.reduce((a, r) => a + r.phrases.length, 0);
console.log(`A: ${runsA.length} runs, ${count(runsA)} phrases;  B: ${runsB.length} runs, ${count(runsB)} phrases  (${Math.round((Date.now() - t0) / 1000)} s)`);

const cmpA = corpus.compareGenerator({ runs: runsA, pieces, split, corpusName: imported.corpus.name });
const cmpB = corpus.compareGenerator({ runs: runsB, pieces, split, corpusName: imported.corpus.name });
const { study, key } = corpus.buildAbStudy(runsA, runsB, { pairs: pairsWanted, seed: coinSeed, keys, seeds, phrasesPerRun });

const rows = cmpA.rows.map((a) => {
  const b = cmpB.rows.find((r) => r.id === a.id);
  return {
    id: a.id,
    label: a.label,
    group: a.group,
    unit: a.unit,
    A: a.generator,
    B: b.generator,
    corpus: a.corpus,
    corpusMatched: a.corpusMatched,
    corpusDevelopment: a.corpusDevelopment,
    corpusHeldOut: a.corpusHeldOut,
    verdictA: a.verdicts,
    verdictB: b.verdicts,
    stabilityA: a.stability,
    stabilityB: b.stability,
  };
});
const report = {
  schema: "nugget-ab-report",
  version: 1,
  studyId: study.id,
  config: { ...study.config, request: "DEFAULT_PHRASE_REQUEST, identical for both generators" },
  profile,
  sets: {
    A: { runs: runsA.length, phrases: count(runsA), medianBars: cmpA.sample.medianBars, medianBeats: cmpA.sample.medianBeats },
    B: { runs: runsB.length, phrases: count(runsB), medianBars: cmpB.sample.medianBars, medianBeats: cmpB.sample.medianBeats },
  },
  corpus: { name: imported.corpus.name, pieces: pieces.length, subsets: cmpA.subsets, matchRangeA: cmpA.matchRange, matchRangeB: cmpB.matchRange },
  rows,
  caveats: [
    "Statistical closeness to a folk corpus is not musical quality, and a difference from it is not poor quality. Nothing here says B is better; the listening judgements do.",
    "Generator A returns contrasting alternatives; Generator B returns a sequence in which phrases can develop one another. The development metrics of A therefore describe unrelated phrases placed side by side.",
    "B is steered by the development half of the corpus; the held-out columns show whether it generalises. Both sets are small.",
    ...cmpA.caveats,
  ],
};

const outDir = join(root, "data", "ab", study.id);
const rel = relative(join(root, "data"), outDir);
if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("refusing to write outside data/");
mkdirSync(outDir, { recursive: true });
const put = (name, data) => writeFileSync(join(outDir, name), JSON.stringify(data, null, 2) + "\n");
put("study.json", study);
put("key.json", key);
put("report.json", report);
if (!existsSync(join(outDir, "ratings.json"))) put("ratings.json", { schema: "nugget-ab-ratings", studyId: study.id, ratings: {}, revealed: false });

const fmt = (v, unit) => (v === null ? "n/a" : unit === "share" ? `${(v * 100).toFixed(0)}%` : String(Math.round(v * 100) / 100));
const show = ["finalBeatsMedian", "heldShare", "finalDecelerates", "notesPerPhrase", "attacksPerBeat", "shortShare", "longShare", "repeatedCellShare", "meanPairDistance", "longestStreakNotes", "adjSimilarity", "adjMelodyKept", "adjRhythmKept", "adjMotifShared", "adjMotifCarried"];
console.log(`\n${"metric".padEnd(46)} ${"A".padStart(8)} ${"B".padStart(8)} ${"corpus".padStart(8)} ${"matched".padStart(8)} ${"held-out".padStart(8)}`);
for (const id of show) {
  const r = rows.find((x) => x.id === id);
  if (r) console.log(`${r.label.padEnd(46)} ${fmt(r.A, r.unit).padStart(8)} ${fmt(r.B, r.unit).padStart(8)} ${fmt(r.corpus, r.unit).padStart(8)} ${fmt(r.corpusMatched, r.unit).padStart(8)} ${fmt(r.corpusHeldOut, r.unit).padStart(8)}`);
}
const outside = (k) => rows.filter((r) => r[k].all !== null && r[k].all !== "within").length;
console.log(`\noutside the corpus's range (whole corpus): A ${outside("verdictA")} of ${rows.length}, B ${outside("verdictB")} of ${rows.length}`);
console.log(`study ${study.id}: ${study.pairs.length} pairs; wrote ${relative(root, outDir)}/ (study.json, key.json, report.json, ratings.json)`);
