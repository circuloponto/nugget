/**
 * Server-side access to the imported corpus (data/corpus/normalized/<corpus-id>/).
 *
 * The corpus is GPL-3.0 research data that is deliberately not part of the app bundle or the repository, so it is
 * read from disk at request time. It is served only in development (or when NUGGET_ALLOW_CORPUS=1 is set), only to
 * this machine, and the dev and start scripts bind to 127.0.0.1. A deployed copy of the app therefore cannot serve it. File names come only from the validated catalogue, never from the request.
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

/**
 * Next adds its own x-forwarded-* headers to every request (x-forwarded-for carries the socket's address), so their
 * mere presence proves nothing. What does show a proxy or tunnel: a Forwarded / X-Real-IP header, a forwarded host
 * that differs from Host, or any non-loopback address in x-forwarded-for (a proxy's entry comes first).
 */
const LOOPBACK_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|\[::1\])$/i;
function passedThroughProxy(request: Request, host: string): boolean {
  const h = request.headers;
  if (h.has("forwarded") || h.has("x-real-ip")) return true;
  const fwdHost = h.get("x-forwarded-host");
  if (fwdHost && fwdHost.toLowerCase() !== host.toLowerCase()) return true;
  const fwdFor = h.get("x-forwarded-for");
  if (fwdFor && fwdFor.split(",").some((a) => !LOOPBACK_ADDR.test(a.trim()))) return true;
  return false;
}

export type CorpusAccess = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly reason: string };

/**
 * Whether this request may read the research corpus. Three independent conditions, all required:
 *
 *  1. Production builds never serve it unless NUGGET_ALLOW_CORPUS=1 is set explicitly. A deployed or commercial copy
 *     of the app therefore has no corpus endpoint at all by default.
 *  2. The request must not have passed through a proxy or tunnel (forwarding headers), and its Host (and Origin, if
 *     any) must name this machine.
 *  3. The real boundary is the server's network binding: `npm run dev` and `npm start` listen on 127.0.0.1 only
 *     (see package.json). The Host header is client-supplied, so check 2 is a second layer, not the boundary.
 */
export function corpusAccess(request: Request): CorpusAccess {
  if (process.env.NODE_ENV === "production" && process.env.NUGGET_ALLOW_CORPUS !== "1") {
    return { ok: false, status: 403, reason: "The corpus is disabled in production builds (it is research-only GPL-3.0 data). Set NUGGET_ALLOW_CORPUS=1 to enable it on a private machine." };
  }
  const nameOf = (hostPort: string): string => {
    const h = hostPort.toLowerCase();
    return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]!;
  };
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (passedThroughProxy(request, host)) return { ok: false, status: 403, reason: "The corpus is not served through a proxy or tunnel." };
  if (!LOCAL_HOSTS.has(nameOf(host))) return { ok: false, status: 403, reason: "The corpus is served only to this machine." };
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* an unparsable Origin is refused below */
    }
    if (!LOCAL_HOSTS.has(nameOf(originHost))) return { ok: false, status: 403, reason: "The corpus is served only to pages on this machine." };
  }
  return { ok: true };
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
