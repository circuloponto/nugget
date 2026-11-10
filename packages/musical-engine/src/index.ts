/**
 * @musical-lab/engine
 *
 * Two strictly separated layers:
 *  - theory/      abstract music theory (spelling, scales, triads, inversions,
 *                 diatonic cycles). No instrument knowledge.
 *  - instrument/  guitar fretboard constraints and realization of abstract
 *                 voicings. Depends on theory/, never the other way around.
 */
export { MusicTheoryError } from "./errors";

// ── theory ────────────────────────────────────────────────────────────────
export * from "./theory/pitch";
export * from "./theory/scale";
export * from "./theory/triad";
export * from "./theory/voicing";
export * from "./theory/cycles";

// ── instrument (guitar) ───────────────────────────────────────────────────
export * from "./instrument/fretboard";
export * from "./instrument/playability";
export * from "./instrument/realize";
export * from "./instrument/voiceLeading";
