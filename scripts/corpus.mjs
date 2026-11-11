#!/usr/bin/env node
/**
 * Corpus import + analysis (Phase 3H.1 / 3H.2).
 *
 *   npm run build:engine
 *   node scripts/corpus.mjs data/corpus/incoming/nugget_folk_starter.zip
 *
 * Reads the archive (untrusted), imports every listed MusicXML piece, analyses each with the same code used for
 * generated phrases, and writes under data/corpus/normalized/<corpus-id>/ :
 *   pieces/<id>.json        normalized corpus piece (notation-faithful, with provenance and licence)
 *   ir/<id>.json            its MusicIR projection
 *   analysis/<id>.json      per-piece analysis
 *   aggregate.json          pooled statistics, naming the pieces behind them
 *   import-report.json      every issue, unsupported element and failure
 *   index.json              catalogue for the explorer, with the licence notice
 * It refuses to write anywhere outside data/corpus/. Nothing is committed or pushed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "packages/musical-engine/dist/index.js");
if (!existsSync(distEntry)) {
  console.error("The engine is not built. Run: npm run build:engine");
  process.exit(2);
}
const { corpus } = await import(pathToUrl(distEntry));

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}

const zipArg = process.argv[2];
if (!zipArg) {
  console.error("usage: node scripts/corpus.mjs <archive.zip> [--out <dir under data/corpus>]");
  process.exit(2);
}
const outIdx = process.argv.indexOf("--out");
const corpusRoot = join(root, "data", "corpus");
const outBase = outIdx > 0 ? resolve(process.argv[outIdx + 1]) : join(corpusRoot, "normalized");
const rel = relative(corpusRoot, outBase);
if (rel.startsWith("..") || isAbsolute(rel)) {
  console.error(`Refusing to write outside ${corpusRoot}`);
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(resolve(zipArg)));
const contents = await corpus.readZip(bytes);
const result = corpus.importArchive(contents);
const outDir = join(outBase, result.corpus.id);
rmSync(outDir, { recursive: true, force: true });
for (const d of ["pieces", "ir", "analysis"]) mkdirSync(join(outDir, d), { recursive: true });
const write = (name, data) => writeFileSync(join(outDir, name), JSON.stringify(data, null, 2) + "\n");

const analyses = [];
for (const p of result.pieces) {
  write(`pieces/${p.piece.id}.json`, { piece: p.piece, report: p.report });
  if (p.ir) write(`ir/${p.piece.id}.json`, p.ir);
  const a = corpus.analyzeCorpusPiece(p.piece);
  analyses.push(a);
  write(`analysis/${p.piece.id}.json`, a);
}
const aggregate = corpus.aggregateAnalyses(analyses);
write("aggregate.json", aggregate);
write("import-report.json", {
  corpus: result.corpus,
  archiveIssues: result.archiveIssues,
  imported: result.pieces.map((p) => ({ id: p.piece.id, status: p.report.status, counts: p.report.counts, issues: p.report.issues, unsupported: p.report.unsupported, irLoss: p.report.irLoss, ir: p.ir !== null })),
  failed: result.failed,
});
write("index.json", {
  notice: `${result.corpus.name}: ${result.corpus.license}. ${result.corpus.usage}`,
  corpus: result.corpus,
  pieces: result.pieces.map((p) => ({ id: p.piece.id, title: p.piece.title, category: p.piece.provenance.catalog.category ?? "", meter: p.piece.measures[0].meter.text, bars: p.piece.measures.length, notes: p.report.counts.notes, status: p.report.status })),
  failed: result.failed.map((f) => ({ id: f.id, title: f.title, reasons: f.report.issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`) })),
});

console.log(`${result.corpus.name} (${result.corpus.license})`);
console.log(`  imported ${result.pieces.length}, failed ${result.failed.length}, archive issues ${result.archiveIssues.length}`);
for (const f of result.failed) console.log(`  FAILED ${f.id}: ${f.report.issues.filter((i) => i.severity === "error").map((i) => i.code).join(", ")}`);
console.log(`  MusicIR projections: ${result.pieces.filter((p) => p.ir).length}/${result.pieces.length}`);
console.log(`  wrote ${relative(root, outDir)}`);
