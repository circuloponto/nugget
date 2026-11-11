/**
 * Server-side access to the imported corpus (data/corpus/normalized/<corpus-id>/).
 *
 * The corpus is GPL-3.0 research data that is deliberately not part of the app bundle or the repository, so it is
 * read from disk at request time, and only for requests that come from this machine. A deployed copy of the app
 * therefore cannot serve it. File names come only from the validated catalogue, never from the request.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

/** Find <repo>/data/corpus/normalized by walking up from the working directory. */
export function corpusRoot(): string | null {
  let dir = resolve(/*turbopackIgnore: true*/ process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "data", "corpus", "normalized");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True only when the request's own Host header names this machine. */
export function isLocalRequest(request: Request): boolean {
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return LOCAL_HOSTS.has(name);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface CorpusListing {
  readonly corpusId: string;
  readonly index: unknown;
  readonly aggregate: unknown;
  readonly report: unknown;
}

/** The first imported corpus (the app shows one corpus at a time for now). */
export function listCorpus(): CorpusListing | null {
  const root = corpusRoot();
  if (!root) return null;
  const ids = readdirSync(root).filter((d) => SAFE_ID.test(d) && existsSync(join(root, d, "index.json"))).sort();
  const id = ids[0];
  if (!id) return null;
  const base = join(/*turbopackIgnore: true*/ root, id);
  return { corpusId: id, index: readJson(join(base, "index.json")), aggregate: existsSync(join(base, "aggregate.json")) ? readJson(join(base, "aggregate.json")) : null, report: existsSync(join(base, "import-report.json")) ? readJson(join(base, "import-report.json")) : null };
}

/** One piece with its notation record, MusicIR and analysis. Returns null for anything not in the catalogue. */
export function loadPiece(corpusId: string, pieceId: string): { piece: unknown; ir: unknown; analysis: unknown } | null {
  if (!SAFE_ID.test(corpusId) || !SAFE_ID.test(pieceId)) return null;
  const root = corpusRoot();
  if (!root) return null;
  const base = join(/*turbopackIgnore: true*/ root, corpusId);
  const index = existsSync(join(base, "index.json")) ? (readJson(join(base, "index.json")) as { pieces?: { id: string }[] }) : null;
  if (!index?.pieces?.some((p) => p.id === pieceId)) return null;
  const read = (sub: string) => {
    const p = join(base, sub, `${pieceId}.json`);
    return existsSync(p) ? readJson(p) : null;
  };
  return { piece: read("pieces"), ir: read("ir"), analysis: read("analysis") };
}

/** The generator-against-corpus comparison written by scripts/compare.mjs, or null if it has not been run. */
export function loadComparison(corpusId: string): unknown | null {
  if (!SAFE_ID.test(corpusId)) return null;
  const root = corpusRoot();
  if (!root) return null;
  const p = join(/*turbopackIgnore: true*/ root, corpusId, "comparison.json");
  return existsSync(p) ? readJson(p) : null;
}
