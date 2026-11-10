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

// ── temporal engine ───────────────────────────────────────────────────────
export * from "./time/rational";
export * from "./time/tempo";
export * from "./time/meter";
export * from "./time/rhythm";

// ── MusicIR v1 ────────────────────────────────────────────────────────────
export * from "./ir/types";
export * from "./ir/validate";
export * from "./ir/semantic";
export * from "./ir/adapters";
export * from "./ir/schedule";

// ── audio synthesis (pure, no Web Audio) ──────────────────────────────────
export * from "./audio/pluck";
export * from "./time/steps";
export * from "./ir/rhythmize";
export * from "./ir/frames";
export * from "./ir/playback";
export * from "./ir/progression";
export * from "./audio/render";
export * from "./ir/view";

// ── musical grammar (Phase 3) ─────────────────────────────────────────────
export * from "./grammar";
