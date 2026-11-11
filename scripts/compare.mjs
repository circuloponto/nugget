#!/usr/bin/env node
/**
 * Generator against corpus (Phase 3H.4).
 *
 *   npm run build:engine
 *   node scripts/compare.mjs data/corpus/incoming/nugget_folk_starter.zip [--keys C,D,Eb] [--seeds 1,2,3]
 *
 * Imports the archive (as scripts/corpus.mjs does), runs the Phase 3 generator over several keys and seeds by the same
 * path the Phrase Constructor uses, measures both sides with the same analysis, and writes
 * data/corpus/normalized/<corpus-id>/comparison.json (the 3H.4 baseline, comparison.baseline-3h4.json, is never touched; git-ignored with the rest of the corpus data; it contains
 * phrases from the corpus). Deterministic: the same archive, keys and seeds give the same file.
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
const { corpus } = await import(new URL(`file:///${distEntry.replace(/\\/g, "/")}`).href);

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const zipArg = process.argv[2];
if (!zipArg || zipArg.startsWith("--")) {
  console.error("usage: node scripts/compare.mjs <archive.zip> [--keys C,D,Eb] [--seeds 1,2,3]");
  process.exit(2);
}
const keys = arg("--keys")?.split(",");
const seeds = arg("--seeds")?.split(",").map(Number);

const contents = await corpus.readZip(new Uint8Array(readFileSync(resolve(zipArg))));
const imported = corpus.importArchive(contents);
const pieces = imported.pieces.map((p) => p.piece);
console.log(`corpus: ${pieces.length} pieces (${imported.failed.length} refused)`);

const t0 = Date.now();
const runs = corpus.sampleGenerator({ ...(keys ? { keys } : {}), ...(seeds ? { seeds } : {}) });
console.log(`generator: ${runs.length} runs, ${runs.reduce((a, r) => a + r.phrases.length, 0)} phrases in ${Math.round((Date.now() - t0) / 1000)} s`);

const result = corpus.compareGenerator({ runs, pieces, corpusName: imported.corpus.name });
const outDir = join(root, "data", "corpus", "normalized", imported.corpus.id);
const rel = relative(join(root, "data", "corpus"), outDir);
if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("refusing to write outside data/corpus");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "comparison.json"), JSON.stringify(result, null, 2) + "\n");

const fmt = (v, unit) => (v === null ? "n/a" : unit === "share" ? `${(v * 100).toFixed(1)}%` : String(Math.round(v * 100) / 100));
const sub = result.subsets;
console.log("");
console.log(`subsets (tunes / phrases / neighbouring pairs): ${Object.entries(sub).map(([k, v]) => `${k} ${v.pieces}/${v.phrases}/${v.pairs}`).join("  ")}; length match ${result.matchRange.join("–")} beats`);
console.log("");
console.log(`${"metric".padEnd(46)} ${"generator".padStart(10)} ${"corpus".padStart(9)} ${"matched".padStart(9)}   ${"verdict (all)".padEnd(13)}  stability`);
for (const r of result.rows) {
  const mark = r.verdict === null ? "n/a" : r.verdict === "within" ? "" : r.verdict === "above" ? "▲ above" : "▼ below";
  console.log(`${r.label.padEnd(46)} ${fmt(r.generator, r.unit).padStart(10)} ${fmt(r.corpus, r.unit).padStart(9)} ${fmt(r.corpusMatched, r.unit).padStart(9)}   ${mark.padEnd(13)}  ${r.stability}`);
}
const judged = result.rows.filter((r) => r.verdict !== null);
console.log("");
console.log(`outside the corpus's range: ${judged.filter((r) => r.verdict !== "within").length} of ${result.rows.length} metrics (${result.rows.length - judged.length} could not be judged)`);
const by = (k) => result.rows.filter((r) => r.stability === k).length;
console.log(`stability: stable ${by("stable")}, within everywhere ${by("stable-within")}, depends on the repertoire ${by("repertoire")}, too little data ${by("unclear")}`);
console.log("");
for (const c of result.caveats) console.log(`- ${c}`);
console.log("");
console.log(`wrote ${relative(root, join(outDir, "comparison.json"))}`);
