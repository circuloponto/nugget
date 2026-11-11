/**
 * A corpus archive (manifest.json + MusicXML + original notation) → normalized corpus pieces.
 *
 * Everything inside the archive is untrusted: the manifest is validated field by field, file names are
 * resolved only inside the archive's own listing, and a piece that fails is reported with its reasons
 * while the rest still import. Nothing is repaired silently.
 */
import { applyFidelity, crossCheckAbc, fidelityIssues } from "./fidelity";
import { importMusicXml, type ImportResult } from "./musicxml";
import { corpusPieceToIR } from "./toIR";
import type { ZipContents } from "./zip";
import type { CorpusDescriptor, CorpusPiece, ImportIssue, ImportReport } from "./types";
import type { MusicIR } from "../ir/types";

/** Applied to every corpus unless its descriptor says otherwise. */
export const DEFAULT_CORPUS_USAGE =
  "Research and development only. Keep out of commercial releases, and do not reproduce its melodies in generated output, until the dataset's licence and intended uses have been reviewed.";

export interface ImportedPiece {
  readonly piece: CorpusPiece;
  readonly ir: MusicIR | null;
  readonly report: ImportReport;
}
export interface FailedPiece {
  readonly id: string;
  readonly title: string;
  readonly sourcePath: string;
  readonly report: ImportReport;
}
export interface ArchiveImport {
  readonly corpus: CorpusDescriptor;
  readonly pieces: readonly ImportedPiece[];
  readonly failed: readonly FailedPiece[];
  /** Problems with the archive itself (missing manifest, refused entries, files not in the manifest ...). */
  readonly archiveIssues: readonly ImportIssue[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const utf8 = (b: Uint8Array): string => new (globalThis as unknown as { TextDecoder: new (l: string, o?: object) => { decode(b: Uint8Array): string } }).TextDecoder("utf-8", { fatal: false }).decode(b);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

export interface ArchiveOptions {
  /** Corpus id to use if the manifest does not give one that is safe. */
  readonly corpusId?: string;
  readonly usage?: string;
}

export function importArchive(contents: ZipContents, options: ArchiveOptions = {}): ArchiveImport {
  const archiveIssues: ImportIssue[] = [];
  const note = (severity: ImportIssue["severity"], code: string, message: string) => void archiveIssues.push({ severity, code, message });
  for (const r of contents.refused) note("warning", "entry-refused", `${JSON.stringify(r.name)}: ${r.reason}`);

  const byPath = new Map(contents.entries.map((e) => [e.path, e] as const));
  const manifestPaths = [...byPath.keys()].filter((p) => p === "manifest.json" || p.endsWith("/manifest.json"));
  const empty = (corpus: CorpusDescriptor): ArchiveImport => ({ corpus, pieces: [], failed: [], archiveIssues });
  const fallback: CorpusDescriptor = { id: options.corpusId ?? "unknown", name: "unknown corpus", license: "unknown", usage: options.usage ?? DEFAULT_CORPUS_USAGE };
  if (manifestPaths.length !== 1) {
    note("error", manifestPaths.length === 0 ? "no-manifest" : "several-manifests", `expected exactly one manifest.json, found ${manifestPaths.length}`);
    return empty(fallback);
  }
  const manifestPath = manifestPaths[0]!;
  const base = manifestPath.slice(0, manifestPath.length - "manifest.json".length);
  let manifest: unknown;
  try {
    manifest = JSON.parse(utf8(byPath.get(manifestPath)!.bytes));
  } catch (e) {
    note("error", "manifest-unreadable", `manifest.json is not valid JSON: ${(e as Error).message}`);
    return empty(fallback);
  }
  if (!isObj(manifest) || !Array.isArray(manifest.pieces)) {
    note("error", "manifest-shape", "manifest.json needs a `pieces` array");
    return empty(fallback);
  }
  const corpusId = options.corpusId ?? (SAFE_ID.test(str(manifest.corpus_id) ?? "") ? str(manifest.corpus_id)! : "nottingham-folk-starter");
  const corpus: CorpusDescriptor = {
    id: corpusId,
    name: str(manifest.dataset) ?? corpusId,
    ...(str(manifest.dataset_repository) ? { repository: str(manifest.dataset_repository)! } : {}),
    license: str(manifest.dataset_license) ?? "unknown",
    ...(str(manifest.license_url) ? { licenseUrl: str(manifest.license_url)! } : {}),
    usage: options.usage ?? DEFAULT_CORPUS_USAGE,
  };
  if (corpus.license === "unknown") note("warning", "license-missing", "the manifest does not state a licence; treat the corpus as unlicensed");
  const conversion = str(manifest.conversion);

  const pieces: ImportedPiece[] = [];
  const failed: FailedPiece[] = [];
  const claimed = new Set<string>([manifestPath]);
  const seenIds = new Set<string>();

  manifest.pieces.forEach((raw, index) => {
    if (!isObj(raw)) return note("error", "manifest-piece", `pieces[${index}] is not an object`);
    const stem = str(raw.file_stem);
    if (!stem || !SAFE_ID.test(stem)) return note("error", "manifest-piece", `pieces[${index}].file_stem ${JSON.stringify(raw.file_stem)} is missing or unsafe`);
    if (seenIds.has(stem)) return note("error", "manifest-piece", `duplicate piece id ${stem}`);
    seenIds.add(stem);
    const title = str(raw.title) ?? stem;
    const xmlRel = str(raw.musicxml_file);
    const failure = (code: string, message: string) => {
      failed.push({ id: stem, title, sourcePath: xmlRel ?? "", report: { status: "failed", issues: [{ severity: "error", code, message }], unsupported: {}, counts: zeroCounts, irLoss: [] } });
    };
    if (!xmlRel) return failure("no-musicxml", "the manifest lists no MusicXML file for this piece");
    const xmlPath = resolveInside(base, xmlRel);
    const xmlEntry = xmlPath ? byPath.get(xmlPath) : undefined;
    if (!xmlPath || !xmlEntry) return failure("musicxml-missing", `${JSON.stringify(xmlRel)} is not in the archive`);
    claimed.add(xmlPath);

    const catalog: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v !== "") catalog[k] = v;
    catalog.title = title;
    const abcRel = str(raw.abc_file);
    const abcPath = abcRel ? resolveInside(base, abcRel) : undefined;
    const abcEntry = abcPath ? byPath.get(abcPath) : undefined;
    if (abcPath && abcEntry) claimed.add(abcPath);
    else if (abcRel) note("warning", "original-missing", `${stem}: original notation ${JSON.stringify(abcRel)} is not in the archive`);

    const result: ImportResult = importMusicXml(utf8(xmlEntry.bytes), {
      pieceId: stem,
      provenance: {
        corpus,
        sourcePath: xmlPath,
        format: "musicxml",
        ...(conversion ? { conversion: { from: abcEntry ? "abc" : undefined, tool: conversion } } : {}),
        ...(abcEntry && abcPath ? { originalNotation: { format: "abc", path: abcPath, text: utf8(abcEntry.bytes) } } : {}),
        catalog,
      },
    });
    if (!result.ok) {
      failed.push({ id: stem, title, sourcePath: xmlPath, report: result.report });
      return;
    }
    const fidelity = crossCheckAbc(result.piece);
    const checkedPiece = applyFidelity(result.piece, fidelity);
    const fIssues = fidelityIssues(fidelity);
    const withFidelity: ImportReport = { ...result.report, fidelity, issues: [...result.report.issues, ...fIssues], status: fIssues.some((x) => x.severity === "warning") ? "ok-with-warnings" : result.report.status };
    const projection = corpusPieceToIR(checkedPiece);
    const report: ImportReport = projection.ok
      ? { ...withFidelity, irLoss: [...new Set([...withFidelity.irLoss, ...projection.loss])] }
      : { ...withFidelity, status: "ok-with-warnings", issues: [...withFidelity.issues, ...projection.issues.map((i): ImportIssue => ({ severity: "warning", code: "ir-projection-failed", message: `${i.path}: ${i.message}` }))], irLoss: [...new Set([...withFidelity.irLoss, ...projection.loss])] };
    pieces.push({ piece: checkedPiece, ir: projection.ok ? projection.ir : null, report });
  });

  for (const p of byPath.keys()) {
    if (claimed.has(p)) continue;
    if (/\.(musicxml|xml|mxl)$/i.test(p)) note("warning", "unlisted-score", `${p} is a score the manifest does not list; it was not imported`);
  }
  return { corpus, pieces, failed, archiveIssues };
}

const zeroCounts = { measures: 0, notes: 0, rests: 0, tiedChains: 0, tupletNotes: 0, graceNotes: 0, harmonies: 0, repeats: 0, meterChanges: 0, keyChanges: 0 };

/** Resolve a manifest-relative path inside the archive; refuses anything that climbs out. */
function resolveInside(base: string, rel: string): string | undefined {
  const parts = rel.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..") || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return undefined;
  return base + parts.join("/");
}
