import { corpusAccess } from "../../../lib/corpusStore";
import { listStudies, loadStudy, reveal, saveRating } from "../../../lib/abStore";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * GET  /api/ab                       the studies and how far each has been judged
 * GET  /api/ab?study=<id>            the blinded pairs (X and Y only) and the ratings so far
 * GET  /api/ab?study=<id>&reveal=1   which generator was which: only after every pair is judged, and it locks the ratings
 * POST /api/ab                       { study, pair, question, choice: "X" | "Y" | "same", note? }
 *
 * A research tool: it has the same access rules as the corpus (off in production builds, this machine only).
 */
export function GET(request: Request) {
  const access = corpusAccess(request);
  if (!access.ok) return json({ available: false, reason: access.reason }, access.status);
  const params = new URL(request.url).searchParams;
  const id = params.get("study");
  if (id === null) return json({ available: true, studies: listStudies() });
  if (params.get("reveal") !== null) {
    const r = reveal(id);
    return r.ok ? json({ available: true, tally: r.tally, key: r.key }) : json({ available: true, error: r.error }, r.status);
  }
  const s = loadStudy(id);
  return s ? json({ available: true, ...s }) : json({ available: true, error: "No such study." }, 404);
}

export async function POST(request: Request) {
  const access = corpusAccess(request);
  if (!access.ok) return json({ available: false, reason: access.reason }, access.status);
  let body: { study?: unknown; pair?: unknown; question?: unknown; choice?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "The body must be JSON." }, 400);
  }
  const { study, pair, question, choice, note } = body;
  if (typeof study !== "string" || typeof pair !== "string" || typeof question !== "string" || typeof choice !== "string" || (note !== undefined && typeof note !== "string")) {
    return json({ error: "study, pair, question and choice must be strings." }, 400);
  }
  const r = saveRating(study, pair, question, choice, note as string | undefined);
  return r.ok ? json({ ok: true, done: r.done, total: r.total }) : json({ error: r.error }, r.status);
}
