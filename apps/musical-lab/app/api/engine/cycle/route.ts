import { cycleResponse, respond } from "../../../../lib/engineApi";

/**
 * GET /api/engine/cycle?tonic=C&scale=major&cycle=5&startDegree=1&inversion=0&length=7
 * Optional: anchorFret (where the first chord should sit), fretCount, maxFretSpan, maxFret.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return respond(() => cycleResponse(params));
}
