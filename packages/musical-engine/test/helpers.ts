import { buildScale, formatNote, LETTERS, SCALE_TYPES, type Scale, type ScaleType } from "../src";

/** All 21 tonics C…B with natural, sharp and flat. */
export const ALL_TONICS: string[] = LETTERS.flatMap((l) => [l, `${l}#`, `${l}b`]);

export const ALL_SCALES: Scale[] = ALL_TONICS.flatMap((t) => SCALE_TYPES.map((type) => buildScale(t, type)));

export const scaleNames = (tonic: string, type: ScaleType): string[] =>
  buildScale(tonic, type).notes.map(formatNote);

export const label = (s: Scale): string => `${formatNote(s.tonic)} ${s.type}`;
