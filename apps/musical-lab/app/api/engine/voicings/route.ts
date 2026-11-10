import { respond, voicingsResponse } from "../../../../lib/engineApi";

/**
 * GET /api/engine/voicings?tonic=C&scale=major&degree=1&inversion=0
 * Optional: fretCount, maxFretSpan, maxFret.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return respond(() => voicingsResponse(params));
}
