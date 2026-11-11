import { isLocalRequest, listCorpus, loadPiece } from "../../../lib/corpusStore";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * GET /api/corpus                  catalogue, pooled statistics, import report
 * GET /api/corpus?piece=<id>       one piece: notation record, MusicIR, analysis
 *
 * Local only: the corpus is GPL-3.0 research data that is not shipped with the app.
 */
export function GET(request: Request) {
  if (!isLocalRequest(request)) return json({ available: false, reason: "The corpus is served only to this machine (it is research-only GPL-3.0 data)." }, 403);
  const listing = listCorpus();
  if (!listing) {
    return json({ available: false, reason: "No corpus has been imported yet. Run: npm run corpus -- data/corpus/incoming/nugget_folk_starter.zip" });
  }
  const pieceId = new URL(request.url).searchParams.get("piece");
  if (pieceId === null) return json({ available: true, ...listing });
  const piece = loadPiece(listing.corpusId, pieceId);
  if (!piece || !piece.piece || !piece.analysis) return json({ available: true, error: `No piece "${pieceId}" in this corpus.` }, 404);
  return json({ available: true, corpusId: listing.corpusId, ...piece });
}
