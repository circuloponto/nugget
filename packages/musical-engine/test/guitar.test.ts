import { describe, expect, it } from "vitest";
import {
  buildScale,
  closeVoicing,
  DROP_D_TUNING,
  diatonicTriads,
  findTriadVoicings,
  fingersRequired,
  formatNote,
  formatPitch,
  guitarStringNumber,
  makeFretboard,
  midi,
  midiAt,
  MusicTheoryError,
  parsePitch,
  pitchClass,
  pitchRange,
  positionsForMidi,
  realizePitches,
  realizeVoicing,
  STANDARD_TUNING,
  validateVoicing,
  withDefaults,
  type GuitarNote,
  type Inversion,
  type PlayabilityConstraints,
  type ViolationCode,
} from "../src";
import { ALL_SCALES, label } from "./helpers";

const fb = makeFretboard(STANDARD_TUNING, 22);
const C = withDefaults();
const dummy = parsePitch("C4");

/** Build GuitarNotes from [string, fret] pairs on the standard fretboard. */
const notes = (...pairs: [number, number][]): GuitarNote[] =>
  pairs.map(([string, fret]) => ({ string, fret, midi: midiAt(fb, string, fret), pitch: dummy }));

const codes = (n: GuitarNote[], c: Partial<PlayabilityConstraints> = {}): ViolationCode[] =>
  validateVoicing(n, fb, withDefaults(c)).map((v) => v.code);

describe("fretboard geometry and pitch mapping", () => {
  it("standard tuning is E2 A2 D3 G3 B3 E4, lowest string first", () => {
    expect(STANDARD_TUNING.strings.map(formatPitch)).toEqual(["E2", "A2", "D3", "G3", "B3", "E4"]);
    expect(STANDARD_TUNING.strings.map(midi)).toEqual([40, 45, 50, 55, 59, 64]);
  });

  it("uses one string convention: index 0 is the lowest string, guitar number 6", () => {
    expect(guitarStringNumber(fb, 0)).toBe(6);
    expect(guitarStringNumber(fb, 5)).toBe(1);
    expect(midiAt(fb, 0, 0)).toBe(40); // low E
    expect(midiAt(fb, 5, 0)).toBe(64); // high E
  });

  it("maps string/fret to MIDI and back", () => {
    expect(midiAt(fb, 1, 3)).toBe(48); // C3 on the A string
    expect(positionsForMidi(fb, 45)).toEqual([
      { string: 0, fret: 5 },
      { string: 1, fret: 0 },
    ]);
    // every position returned really sounds that pitch
    for (let m = 40; m <= 86; m++) {
      for (const p of positionsForMidi(fb, m)) expect(midiAt(fb, p.string, p.fret)).toBe(m);
    }
  });

  it("respects fret bounds and instrument range", () => {
    expect(positionsForMidi(fb, 39)).toEqual([]); // below low E
    expect(positionsForMidi(fb, 87)).toEqual([]); // above fret 22 on the high E
    expect(positionsForMidi(fb, 45, 1, 12)).toEqual([{ string: 0, fret: 5 }]);
    expect(pitchRange(fb)).toEqual({ lowest: 40, highest: 86 });
    expect(() => midiAt(fb, 0, 23)).toThrow(MusicTheoryError);
    expect(() => midiAt(fb, 6, 0)).toThrow(MusicTheoryError);
  });

  it("supports alternate tunings", () => {
    const dropD = makeFretboard(DROP_D_TUNING);
    expect(midiAt(dropD, 0, 0)).toBe(38);
    expect(positionsForMidi(dropD, 38)).toEqual([{ string: 0, fret: 0 }]);
  });
});

describe("physical playability rules", () => {
  it("accepts open-position C major (A string 3, D string 2, G string open)", () => {
    expect(codes(notes([1, 3], [2, 2], [3, 0]))).toEqual([]);
  });

  it.each<[string, GuitarNote[], Partial<PlayabilityConstraints>, ViolationCode]>([
    ["two voices on one string", notes([1, 3], [1, 5]), {}, "StringReused"],
    ["a skipped string", notes([0, 3], [2, 2]), {}, "NonContiguousStrings"],
    ["voices not ascending with strings", notes([2, 2], [1, 3]), {}, "StringOrder"],
    ["a stretch wider than the limit", notes([0, 1], [1, 6]), {}, "FretSpanTooWide"],
    ["a fret above maxFret", notes([0, 3], [1, 18]), {}, "FretOutOfRange"],
    ["an open string when disallowed", notes([1, 3], [2, 2], [3, 0]), { allowOpenStrings: false }, "OpenStringNotAllowed"],
    ["more fingers than available", notes([0, 1], [1, 2], [2, 3], [3, 4], [4, 5]), {}, "TooManyFingers"],
  ])("rejects %s", (_name, n, c, code) => {
    expect(codes(n, c)).toContain(code);
  });

  it("rejects non-existent strings and empty voicings", () => {
    const bad: GuitarNote[] = [{ string: 9, fret: 0, midi: 40, pitch: dummy }];
    expect(validateVoicing(bad, fb, C).map((v) => v.code)).toEqual(["StringOutOfRange"]);
    expect(validateVoicing([], fb, C).map((v) => v.code)).toEqual(["NoNotes"]);
  });

  it("detects a note whose MIDI does not match its string/fret, or the expected pitch", () => {
    const wrong: GuitarNote[] = [{ string: 1, fret: 3, midi: 49, pitch: dummy }];
    expect(validateVoicing(wrong, fb, C).map((v) => v.code)).toContain("PitchMismatch");
    const right = notes([1, 3]);
    expect(validateVoicing(right, fb, C, [parsePitch("C3")])).toEqual([]);
    expect(validateVoicing(right, fb, C, [parsePitch("D3")]).map((v) => v.code)).toContain("PitchMismatch");
  });

  it("does not count open strings toward the stretch", () => {
    // fretted notes at 5 and 7 (span 2) plus an open string: valid.
    expect(codes(notes([1, 0], [2, 7], [3, 7]), { maxFretSpan: 2 })).toEqual([]);
  });

  it("stretch limit is configurable: span 3 is accepted at limit 3 and rejected at limit 2", () => {
    const n = notes([0, 5], [1, 8]);
    expect(codes(n, { maxFretSpan: 3 })).toEqual([]);
    expect(codes(n, { maxFretSpan: 2 })).toContain("FretSpanTooWide");
  });

  it("counts a barre as one finger unless an open string blocks it", () => {
    expect(fingersRequired([{ string: 0, fret: 3 }, { string: 1, fret: 3 }, { string: 2, fret: 3 }])).toBe(1);
    expect(fingersRequired([{ string: 0, fret: 3 }, { string: 1, fret: 5 }, { string: 2, fret: 3 }])).toBe(2);
    expect(fingersRequired([{ string: 0, fret: 3 }, { string: 1, fret: 0 }, { string: 2, fret: 3 }])).toBe(2);
    expect(fingersRequired([{ string: 0, fret: 0 }, { string: 1, fret: 0 }])).toBe(0);
  });
});

describe("realizing abstract voicings on the fretboard", () => {
  it("finds the open C major triad as a realization of C3 E3 G3", () => {
    const v = closeVoicing(buildScale("C", "major"), 1, 0, 3);
    const found = realizeVoicing(v, fb).map((g) => g.notes.map((n) => `${n.string}:${n.fret}`).join(" "));
    expect(found).toContain("1:3 2:2 3:0");
  });

  it("is complete: matches an independent brute-force enumeration of every string/fret combination", () => {
    const pitches = closeVoicing(buildScale("C", "major"), 1, 0, 3).pitches;
    const constraints = withDefaults();
    const expected = new Set<string>();
    const strings = [0, 1, 2, 3, 4, 5];
    for (const a of strings) for (const b of strings) for (const c of strings) {
      for (let fa = 0; fa <= 17; fa++) for (let fbb = 0; fbb <= 17; fbb++) for (let fc = 0; fc <= 17; fc++) {
        const n = [
          { string: a, fret: fa }, { string: b, fret: fbb }, { string: c, fret: fc },
        ].map((p, i) => ({ ...p, midi: midiAt(fb, p.string, p.fret), pitch: pitches[i]! }));
        if (n.some((x, i) => x.midi !== midi(pitches[i]!))) continue;
        if (validateVoicing(n, fb, constraints, pitches).length === 0) {
          expected.add(n.map((x) => `${x.string}:${x.fret}`).join(" "));
        }
      }
    }
    const actual = new Set(realizePitches(pitches, fb).map((g) => g.notes.map((n) => `${n.string}:${n.fret}`).join(" ")));
    expect(actual).toEqual(expected);
    expect(actual.size).toBeGreaterThan(0);
  });

  it("every realization of every diatonic triad in every key is physically valid, exact and correctly inverted", () => {
    const inversions: Inversion[] = [0, 1, 2];
    let checked = 0;
    for (const scale of ALL_SCALES) {
      for (const triad of diatonicTriads(scale)) {
        for (const inv of inversions) {
          const names = triad.notes.map(formatNote);
          const expectedBassPc = pitchClass([triad.root, triad.third, triad.fifth][inv]!);
          for (const { voicing, guitar } of findTriadVoicings(scale, triad.degree, inv, fb)) {
            const ctx = `${label(scale)} ${triad.symbol} inv${inv}`;
            // 1. physically valid under the default constraints, with exact pitches
            expect(validateVoicing(guitar.notes, fb, C, voicing.pitches), ctx).toEqual([]);
            // 2. the lowest *sounding* note is the correct chord tone for the inversion
            const lowest = guitar.notes.reduce((a, b) => (a.midi <= b.midi ? a : b));
            expect(pitchClass(lowest.pitch), ctx).toBe(expectedBassPc);
            expect(lowest.midi).toBe(Math.min(...guitar.notes.map((n) => n.midi)));
            // 3. the spelling of the scale survives the trip to the fretboard (Gb stays Gb)
            for (const n of guitar.notes) expect(names, ctx).toContain(formatNote(n.pitch));
            // 4. three distinct strings, adjacent, bass on the lowest
            expect(new Set(guitar.strings).size).toBe(3);
            expect(guitar.strings[2]! - guitar.strings[0]!).toBe(2);
            expect(guitar.notes.map((n) => n.string)).toEqual([...guitar.strings]);
            // 5. within the stretch and fret limits
            expect(guitar.span).toBeLessThanOrEqual(C.maxFretSpan);
            expect(guitar.highestFret).toBeLessThanOrEqual(C.maxFret);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("returns nothing for pitches the instrument cannot sound", () => {
    expect(realizePitches([parsePitch("C1"), parsePitch("E1"), parsePitch("G1")], fb)).toEqual([]);
    expect(realizePitches([parsePitch("C8"), parsePitch("E8"), parsePitch("G8")], fb)).toEqual([]);
    expect(realizePitches([], fb)).toEqual([]);
  });

  it("D2 is unplayable in standard tuning but playable in Drop D", () => {
    // D2 A2 D3: an open-fifth voicing. (A *close* D2 F#2 A2 is never playable: F#2
    // only exists on the lowest string, which D2 already occupies.)
    const pitches = [parsePitch("D2"), parsePitch("A2"), parsePitch("D3")];
    expect(realizePitches(pitches, fb)).toEqual([]);
    const found = realizePitches(pitches, makeFretboard(DROP_D_TUNING));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.notes.map((n) => `${n.string}:${n.fret}`)).toEqual(["0:0", "1:0", "2:0"]);

    const closeDMajor = closeVoicing(buildScale("D", "major"), 1, 0, 2);
    expect(realizeVoicing(closeDMajor, makeFretboard(DROP_D_TUNING))).toEqual([]);
  });

  it("tightening constraints only ever removes options", () => {
    const pitches = closeVoicing(buildScale("E", "major"), 1, 0, 3).pitches;
    const key = (g: ReturnType<typeof realizePitches>[number]) => g.notes.map((n) => `${n.string}:${n.fret}`).join(" ");
    const loose = new Set(realizePitches(pitches, fb, { maxFretSpan: 5 }).map(key));
    const mid = new Set(realizePitches(pitches, fb, { maxFretSpan: 4 }).map(key));
    const tight = new Set(realizePitches(pitches, fb, { maxFretSpan: 2 }).map(key));
    for (const k of tight) expect(mid.has(k)).toBe(true);
    for (const k of mid) expect(loose.has(k)).toBe(true);
    expect(tight.size).toBeLessThanOrEqual(mid.size);
    expect(mid.size).toBeLessThanOrEqual(loose.size);
    // no open strings means no fret 0
    for (const g of realizePitches(pitches, fb, { allowOpenStrings: false })) {
      for (const n of g.notes) expect(n.fret).toBeGreaterThan(0);
    }
    // relaxing string order / contiguity can only add options
    const relaxed = new Set(
      realizePitches(pitches, fb, { requireAscendingStrings: false, requireContiguousStrings: false }).map(key),
    );
    for (const k of mid) expect(relaxed.has(k)).toBe(true);
  });

  it("is deterministic and sorted lowest-position first", () => {
    const pitches = closeVoicing(buildScale("G", "major"), 1, 1, 3).pitches;
    const a = realizePitches(pitches, fb);
    expect(a).toEqual(realizePitches(pitches, fb));
    const sets = a.map((g) => g.strings.join(","));
    expect(sets).toEqual([...sets].sort());
  });

  it("describes voicings: open strings are ignored for center and span", () => {
    const g = realizePitches(closeVoicing(buildScale("C", "major"), 1, 0, 3).pitches, fb).find(
      (x) => x.notes.map((n) => n.fret).join() === "3,2,0",
    )!;
    expect(g.center).toBe(2.5);
    expect(g.span).toBe(1);
    expect(g.lowestFret).toBe(0);
    expect(g.highestFret).toBe(3);
    expect(g.fingers).toBe(2);
  });
});
