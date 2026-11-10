import { describe, expect, it } from "vitest";
import {
  addInterval,
  formatNote,
  formatPitch,
  intervalBetween,
  isEnharmonic,
  isSameNote,
  midi,
  MusicTheoryError,
  parseNote,
  parsePitch,
  pitchClass,
  pitchFromMidi,
} from "../src";

describe("note and pitch parsing", () => {
  it("parses naturals, sharps, flats and double accidentals", () => {
    expect(parseNote("C")).toEqual({ letter: "C", accidental: 0 });
    expect(parseNote("F#")).toEqual({ letter: "F", accidental: 1 });
    expect(parseNote("Bb")).toEqual({ letter: "B", accidental: -1 });
    expect(parseNote("C##")).toEqual({ letter: "C", accidental: 2 });
    expect(parseNote("Ebb")).toEqual({ letter: "E", accidental: -2 });
    expect(parseNote("F♯")).toEqual({ letter: "F", accidental: 1 });
    expect(parseNote("B♭")).toEqual({ letter: "B", accidental: -1 });
  });

  it("round-trips formatting", () => {
    for (const n of ["C", "F#", "Bb", "C##", "Ebb", "G#"]) expect(formatNote(parseNote(n))).toBe(n);
    for (const p of ["C4", "F#3", "Bb2", "B#3", "Cb5", "E2"]) expect(formatPitch(parsePitch(p))).toBe(p);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "H", "c", "C#b", "#C", "Cbx1"]) expect(() => parseNote(bad)).toThrow(MusicTheoryError);
    for (const bad of ["C", "4C", "C#", "H4"]) expect(() => parsePitch(bad)).toThrow(MusicTheoryError);
  });
});

describe("MIDI and octave semantics", () => {
  it("matches scientific pitch notation (C4 = 60, A4 = 69, E2 = 40)", () => {
    expect(midi(parsePitch("C4"))).toBe(60);
    expect(midi(parsePitch("A4"))).toBe(69);
    expect(midi(parsePitch("E2"))).toBe(40);
  });

  it("assigns octave by letter, so B#3 is MIDI 60 and Cb4 is MIDI 59", () => {
    expect(midi(parsePitch("B#3"))).toBe(60);
    expect(midi(parsePitch("Cb4"))).toBe(59);
  });

  it("distinguishes enharmonic spellings without conflating them", () => {
    const cs = parseNote("C#");
    const db = parseNote("Db");
    expect(isEnharmonic(cs, db)).toBe(true);
    expect(isSameNote(cs, db)).toBe(false);
    expect(pitchClass(parseNote("B#"))).toBe(0);
    expect(pitchClass(parseNote("Cb"))).toBe(11);
  });

  it("re-spells a MIDI number as a requested note", () => {
    expect(formatPitch(pitchFromMidi(61, parseNote("Db")))).toBe("Db4");
    expect(formatPitch(pitchFromMidi(61, parseNote("C#")))).toBe("C#4");
    expect(formatPitch(pitchFromMidi(60, parseNote("B#")))).toBe("B#3");
    expect(() => pitchFromMidi(62, parseNote("Db"))).toThrow(MusicTheoryError);
  });
});

describe("interval arithmetic keeps correct spelling", () => {
  const M3 = { steps: 2, semitones: 4 };
  const m3 = { steps: 2, semitones: 3 };
  it("adds thirds with letter-correct names", () => {
    expect(formatPitch(addInterval(parsePitch("C4"), M3))).toBe("E4");
    expect(formatPitch(addInterval(parsePitch("C4"), m3))).toBe("Eb4");
    expect(formatPitch(addInterval(parsePitch("F#4"), M3))).toBe("A#4");
    expect(formatPitch(addInterval(parsePitch("G#4"), M3))).toBe("B#4");
    expect(formatPitch(addInterval(parsePitch("C#4"), { steps: 4, semitones: 7 }))).toBe("G#4");
  });
  it("supports compound and negative intervals", () => {
    expect(formatPitch(addInterval(parsePitch("C4"), { steps: 9, semitones: 16 }))).toBe("E5");
    expect(formatPitch(addInterval(parsePitch("C4"), { steps: -1, semitones: -1 }))).toBe("B3");
    expect(formatPitch(addInterval(parsePitch("A4"), { steps: -2, semitones: -3 }))).toBe("F#4");
  });
  it("intervalBetween inverts addInterval", () => {
    const a = parsePitch("Eb3");
    const b = parsePitch("G#4");
    expect(addInterval(a, intervalBetween(a, b))).toEqual(b);
  });
});
