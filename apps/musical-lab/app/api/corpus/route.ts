import { corpusAccess, listCorpus, loadComparison, loadPiece } from "../../../lib/corpusStore";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * GET /api/corpus                  catalogue, pooled statistics, import report
 * GET /api/corpus?piece=<id>       one piece: notation record, MusicIR, analysis
 * GET /api/corpus?comparison=1     the generator-against-corpus comparison (npm run compare)
 *
 * Development and this machine only: the corpus is GPL-3.0 research data that is not shipped with the app. Disabled in
 * production builds unless NUGGET_ALLOW_CORPUS=1 (see corpusAccess).
 */
export function GET(request: Request) {
  const access = corpusAccess(request);
  if (!access.ok) return json({ available: false, reason: access.reason }, access.status);
  const listing = listCorpus();
  if (!listing) {
    return json({ available: false, reason: "No corpus has been imported yet. Run: npm run corpus -- data/corpus/incoming/nugget_folk_starter.zip" });
  }
  const params = new URL(request.url).searchParams;
  if (params.get("comparison") !== null) {
    const comparison = loadComparison(listing.corpusId);
    return comparison ? json({ available: true, corpusId: listing.corpusId, comparison }) : json({ available: true, comparison: null, reason: "The comparison has not been run yet. Run: npm run compare -- data/corpus/incoming/nugget_folk_starter.zip" });
  }
  const pieceId = params.get("piece");
  if (pieceId === null) return json({ available: true, ...listing });
  const piece = loadPiece(listing.corpusId, pieceId);
  if (!piece || !piece.piece || !piece.analysis) return json({ available: true, error: `No piece "${pieceId}" in this corpus.` }, 404);
  return json({ available: true, corpusId: listing.corpusId, ...piece });
}
