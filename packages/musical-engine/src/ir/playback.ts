/**
 * A MusicIR document as audio: schedule it onto sample frames, then render those frames.
 * Pure: no Web Audio. The app hands the samples to the browser.
 */
import { renderEvents, type RenderOptions } from "../audio/render";
import { scheduleFrames, type FrameSchedule, type FrameTempo } from "./frames";
import type { MusicIR } from "./types";

export interface PlaybackOptions extends Pick<RenderOptions, "tone" | "releaseSeconds" | "wrapTail" | "maxNoteSeconds" | "headroom"> {
  /** Use the sample rate of the audio context that will play it, so nothing is resampled. */
  sampleRate: number;
  /** Overrides the document's tempo. */
  tempo?: FrameTempo;
}

export interface RenderedDocument {
  readonly samples: Float32Array;
  readonly schedule: FrameSchedule;
  readonly peak: number;
  readonly gain: number;
}

export function renderDocument(ir: MusicIR, options: PlaybackOptions): RenderedDocument {
  const schedule = scheduleFrames(ir, options.sampleRate, options.tempo);
  const { samples, peak, gain } = renderEvents(schedule.events, {
    sampleRate: options.sampleRate,
    totalFrames: schedule.totalFrames,
    tone: options.tone,
    releaseSeconds: options.releaseSeconds,
    wrapTail: options.wrapTail,
    maxNoteSeconds: options.maxNoteSeconds,
    headroom: options.headroom,
  });
  return { samples, schedule, peak, gain };
}
