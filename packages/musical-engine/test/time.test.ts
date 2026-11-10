import { describe, expect, it } from "vitest";
import {
  absoluteEvents,
  accentProfile,
  accentsFromGroups,
  barLength,
  concatCells,
  fadd,
  fcmp,
  fdiv,
  feq,
  ffloor,
  fmod,
  fmul,
  fnum,
  frac,
  fstr,
  fsub,
  fsum,
  groupStarts,
  lcmFractions,
  makeCell,
  makeMeter,
  metricModulation,
  MusicTheoryError,
  nestedSubdivision,
  parseFraction,
  parseMeter,
  polymeterRealignment,
  polyrhythm,
  pulsePositions,
  repeatCell,
  rotate,
  scaleCell,
  soundingTime,
  subdivide,
  subdivideEvent,
  subdivisionCell,
  toSeconds,
  tupletCell,
  tupletDuration,
  validateCell,
  ZERO,
  type Fraction,
  type RhythmCell,
} from "../src";

const f = (s: string): Fraction => parseFraction(s);
const total = (c: RhythmCell) => fsum(c.events.map((e) => e.duration));

/** Deterministic pseudo-random small fractions for property tests. */
function* randomFractions(count: number, seed = 12345): Generator<Fraction> {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < count; i++) yield frac((next() % 41) - 20, (next() % 24) + 1);
}

describe("exact rational time", () => {
  it("normalizes: lowest terms, positive denominator, no negative zero", () => {
    expect(frac(2, 4)).toEqual({ num: 1, den: 2 });
    expect(frac(1, -2)).toEqual({ num: -1, den: 2 });
    expect(frac(-3, -6)).toEqual({ num: 1, den: 2 });
    expect(frac(0, 7)).toEqual({ num: 0, den: 1 });
    expect(Object.is(frac(0, -5).num, -0)).toBe(false);
  });

  it("rejects non-integers and a zero denominator", () => {
    expect(() => frac(1, 0)).toThrow(MusicTheoryError);
    expect(() => frac(0.5, 2)).toThrow(MusicTheoryError);
    expect(() => frac(1, 2.5)).toThrow(MusicTheoryError);
  });

  it("is exact where floats are not: thirds add up to exactly one", () => {
    const third = frac(1, 3);
    expect(feq(fadd(fadd(third, third), third), frac(1))).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false); // the float problem this avoids
    expect(feq(fadd(f("1/10"), f("2/10")), f("3/10"))).toBe(true);
  });

  it("obeys the field laws on random fractions", () => {
    const xs = [...randomFractions(60)];
    for (let i = 0; i + 2 < xs.length; i++) {
      const [a, b, c] = [xs[i]!, xs[i + 1]!, xs[i + 2]!];
      expect(fadd(a, b)).toEqual(fadd(b, a));
      expect(fmul(a, b)).toEqual(fmul(b, a));
      expect(fadd(fadd(a, b), c)).toEqual(fadd(a, fadd(b, c)));
      expect(fmul(a, fadd(b, c))).toEqual(fadd(fmul(a, b), fmul(a, c)));
      expect(fsub(fadd(a, b), b)).toEqual(a);
      if (b.num !== 0) expect(fmul(fdiv(a, b), b)).toEqual(a);
      expect(fcmp(a, b)).toBe(Math.sign(fnum(a) - fnum(b)));
    }
  });

  it("floor and modulo handle negatives and exact boundaries", () => {
    expect(ffloor(f("7/2"))).toBe(3);
    expect(ffloor(f("-7/2"))).toBe(-4);
    expect(ffloor(f("-4"))).toBe(-4);
    expect(fmod(f("7/4"), f("1"))).toEqual(f("3/4"));
    expect(fmod(f("-1/4"), f("1"))).toEqual(f("3/4"));
    expect(fmod(f("2"), f("1"))).toEqual(ZERO);
    expect(() => fmod(f("1"), ZERO)).toThrow(MusicTheoryError);
  });

  it("parses and prints round-trip", () => {
    for (const x of randomFractions(40)) expect(parseFraction(fstr(x))).toEqual(x);
    expect(fstr(frac(4, 2))).toBe("2");
    expect(() => parseFraction("1/")).toThrow(MusicTheoryError);
    expect(() => parseFraction("0.5")).toThrow(MusicTheoryError);
  });

  it("refuses to silently overflow", () => {
    const big = frac(Number.MAX_SAFE_INTEGER, 3);
    expect(() => fmul(big, big)).toThrow(MusicTheoryError);
    expect(() => fdiv(frac(1), ZERO)).toThrow(MusicTheoryError);
  });

  it("lcm of fractions is the first moment they all line up", () => {
    expect(lcmFractions([f("3/4"), f("1")])).toEqual(f("3"));
    expect(lcmFractions([f("1/2"), f("1/3")])).toEqual(f("1"));
    expect(() => lcmFractions([])).toThrow(MusicTheoryError);
    expect(() => lcmFractions([f("-1/2")])).toThrow(MusicTheoryError);
  });
});

describe("subdivisions and tuplets", () => {
  it("a triplet is exactly a third of its span", () => {
    const c = subdivisionCell(f("1/4"), 3);
    expect(c.events.map((e) => fstr(e.duration))).toEqual(["1/12", "1/12", "1/12"]);
    expect(c.events.map((e) => fstr(e.onset))).toEqual(["0", "1/12", "1/6"]);
    expect(total(c)).toEqual(f("1/4"));
    expect(validateCell(c)).toEqual([]);
  });

  it("tuplet durations: triplet eighth, quintuplet sixteenth, septuplet 7:4", () => {
    expect(tupletDuration(f("1/8"), 3, 2)).toEqual(f("1/12")); // 3 in the time of 2 eighths
    expect(tupletDuration(f("1/16"), 5, 4)).toEqual(f("1/20")); // 5 in the time of 4 sixteenths
    expect(tupletDuration(f("1/8"), 7, 4)).toEqual(f("1/14")); // 7 in the time of 4 eighths
    expect(() => tupletDuration(f("1/8"), 0, 2)).toThrow(MusicTheoryError);
  });

  it("tuplet cells fill exactly the time of the notes they replace", () => {
    for (const [normal, count, inTime] of [["1/8", 3, 2], ["1/16", 5, 4], ["1/8", 7, 4], ["1/4", 3, 2], ["1/16", 6, 4]] as const) {
      const c = tupletCell(f(normal), count, inTime);
      expect(c.events).toHaveLength(count);
      expect(c.length).toEqual(fmul(f(normal), frac(inTime)));
      expect(total(c)).toEqual(c.length);
    }
  });

  it("nests tuplets exactly: [3, 2] gives six equal notes; a quintuplet inside one note of a triplet", () => {
    const six = nestedSubdivision(f("1/4"), [3, 2]);
    expect(six.events).toHaveLength(6);
    expect(new Set(six.events.map((e) => fstr(e.duration)))).toEqual(new Set(["1/24"]));
    expect(total(six)).toEqual(f("1/4"));

    const triplet = subdivisionCell(f("1/4"), 3);
    const nested = subdivideEvent(triplet, 1, 5); // second triplet note becomes a quintuplet
    expect(nested.events).toHaveLength(3 - 1 + 5);
    expect(total(nested)).toEqual(f("1/4"));
    expect(validateCell(nested)).toEqual([]);
    expect(fstr(nested.events[1]!.duration)).toBe("1/60"); // 1/12 ÷ 5
    // outside the nested note nothing moved
    expect(nested.events[0]).toEqual(triplet.events[0]);
    expect(nested.events[nested.events.length - 1]!.onset).toEqual(triplet.events[2]!.onset);
  });

  it("deeply nested subdivisions stay exact", () => {
    const c = nestedSubdivision(f("1"), [3, 5, 7]);
    expect(c.events).toHaveLength(105);
    expect(total(c)).toEqual(f("1"));
    expect(validateCell(c)).toEqual([]);
  });

  it("validateCell finds overlap, disorder, overrun and bad durations", () => {
    const L = f("1");
    const ev = (o: string, d: string) => ({ onset: f(o), duration: f(d) });
    expect(validateCell({ length: L, events: [ev("0", "1/2"), ev("1/4", "1/2")] }).join()).toMatch(/overlaps/);
    expect(validateCell({ length: L, events: [ev("1/2", "1/4"), ev("0", "1/4")] }).join()).toMatch(/out of order/);
    expect(validateCell({ length: L, events: [ev("3/4", "1/2")] }).join()).toMatch(/past the end/);
    expect(validateCell({ length: L, events: [ev("0", "0")] }).join()).toMatch(/positive/);
    expect(validateCell({ length: L, events: [ev("-1/4", "1/4")] }).join()).toMatch(/negative/);
    expect(() => makeCell(L, [ev("0", "2")])).toThrow(MusicTheoryError);
    expect(validateCell({ length: L, events: [ev("0", "1/2"), ev("1/2", "1/2")] })).toEqual([]);
  });
});

describe("polyrhythm", () => {
  it("3 against 2: three equal attack spacings and two equal attack spacings across the same interval", () => {
    const span = f("1/2");
    const { layers, merged } = polyrhythm(span, [3, 2]);
    expect(layers[0]!.onsets.map(fstr)).toEqual(["0", "1/6", "1/3"]);
    expect(layers[1]!.onsets.map(fstr)).toEqual(["0", "1/4"]);
    // they only meet at the start
    expect(merged.filter((m) => m.ratios.length > 1).map((m) => fstr(m.onset))).toEqual(["0"]);
    expect(merged.map((m) => fstr(m.onset))).toEqual(["0", "1/6", "1/4", "1/3"]);
  });

  it("the number of shared attacks equals gcd of the ratios", () => {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    for (const [a, b] of [[3, 2], [4, 6], [5, 3], [4, 8], [7, 5], [6, 9]] as const) {
      const shared = polyrhythm(f("1"), [a, b]).merged.filter((m) => m.ratios.length === 2);
      expect(shared).toHaveLength(gcd(a, b));
    }
  });

  it("merged attacks are strictly ascending and unique", () => {
    const { merged } = polyrhythm(f("1"), [3, 4, 5]);
    for (let i = 1; i < merged.length; i++) expect(fcmp(merged[i - 1]!.onset, merged[i]!.onset)).toBe(-1);
    expect(merged).toHaveLength(1 + 2 + 3 + 4); // 0 shared by all; the rest distinct
  });
});

describe("meters, polymeter and accents", () => {
  it("parses meters and groupings", () => {
    expect(parseMeter("4/4").groups).toEqual([1, 1, 1, 1]);
    expect(parseMeter("6/8").groups).toEqual([3, 3]);
    expect(parseMeter("9/8").groups).toEqual([3, 3, 3]);
    expect(parseMeter("7/8", [2, 2, 3]).groups).toEqual([2, 2, 3]);
    expect(() => parseMeter("7/8", [2, 2, 2])).toThrow(MusicTheoryError);
    expect(() => parseMeter("x/4")).toThrow(MusicTheoryError);
    expect(() => makeMeter([], f("1/4"))).toThrow(MusicTheoryError);
  });

  it("bar length, pulses and group starts are exact", () => {
    const m = parseMeter("7/8", [2, 2, 3]);
    expect(barLength(m)).toEqual(f("7/8"));
    expect(pulsePositions(m).map(fstr)).toEqual(["0", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4"]);
    expect(groupStarts(m).map(fstr)).toEqual(["0", "1/4", "1/2"]);
  });

  it("accent hierarchy: downbeat > group start > other pulses", () => {
    expect(accentProfile(parseMeter("7/8", [2, 2, 3]))).toEqual([3, 1, 2, 1, 2, 1, 1]);
    expect(accentProfile(parseMeter("6/8"))).toEqual([3, 1, 1, 2, 1, 1]);
    expect(accentProfile(parseMeter("4/4"))).toEqual([3, 1, 1, 1].map((x, i) => (i === 0 ? 3 : 2)));
  });

  it("3/4 against 4/4 on a shared quarter-note pulse reunite after 12 beats", () => {
    const re = polymeterRealignment([barLength(parseMeter("3/4")), barLength(parseMeter("4/4"))]);
    expect(re).toEqual(f("3")); // 3 whole notes
    expect(fdiv(re, f("1/4"))).toEqual(f("12")); // = 12 quarter-note beats
    // and 12 beats is the FIRST time both downbeat cycles coincide
    const downbeats34 = new Set([0, 3, 6, 9, 12]);
    const firstShared = [4, 8, 12].find((b) => downbeats34.has(b));
    expect(firstShared).toBe(12);
  });

  it("other polymeters realign exactly", () => {
    expect(polymeterRealignment([f("7/8"), f("1")])).toEqual(f("7")); // 7/8 vs 4/4: 7 bars of 4/4
    const five4 = barLength(parseMeter("5/4"));
    const seven8 = barLength(parseMeter("7/8"));
    const re = polymeterRealignment([five4, seven8]);
    expect(re).toEqual(f("35/4"));
    expect(fdiv(re, five4)).toEqual(f("7")); // 7 bars of 5/4 …
    expect(fdiv(re, seven8)).toEqual(f("10")); // … = 10 bars of 7/8
  });
});

describe("phase, rotation and transformation of cells", () => {
  const tresillo = (): RhythmCell =>
    makeCell(f("1"), [
      { onset: f("0"), duration: f("3/8") },
      { onset: f("3/8"), duration: f("3/8") },
      { onset: f("3/4"), duration: f("1/4") },
    ]);

  it("rotation never changes how much sound there is", () => {
    for (const off of ["1/8", "1/4", "3/8", "1/3", "5/7", "-1/8", "17/8"]) {
      const r = rotate(tresillo(), f(off));
      expect(total(r), off).toEqual(f("1"));
      expect(soundingTime(r), off).toEqual(f("1"));
      expect(validateCell(r), off).toEqual([]);
    }
  });

  it("a note that would cross the end is split and tied, not lost", () => {
    const r = rotate(tresillo(), f("1/8"));
    const tied = r.events.filter((e) => e.tiedToNext);
    expect(tied).toHaveLength(1);
    expect(r.events[0]!.onset).toEqual(ZERO); // the continuation starts the bar
  });

  it("rotating by the whole length is the identity; rotations add up", () => {
    const c = tresillo();
    expect(rotate(c, f("1"))).toEqual(c);
    expect(rotate(rotate(c, f("1/8")), f("1/4"))).toEqual(rotate(c, f("3/8")));
    expect(rotate(rotate(c, f("5/8")), f("3/8"))).toEqual(c);
  });

  it("augmentation and diminution scale every time value exactly", () => {
    const c = tresillo();
    const twice = scaleCell(c, f("2"));
    expect(twice.length).toEqual(f("2"));
    expect(total(twice)).toEqual(f("2"));
    expect(twice.events[1]!.onset).toEqual(f("3/4"));
    expect(scaleCell(twice, f("1/2"))).toEqual(c);
    expect(scaleCell(c, f("2/3")).length).toEqual(f("2/3"));
    expect(() => scaleCell(c, ZERO)).toThrow(MusicTheoryError);
  });

  it("concatenation and repetition keep the timeline continuous and valid", () => {
    const c = subdivisionCell(f("1/4"), 3);
    const four = repeatCell(c, 4);
    expect(four.length).toEqual(f("1"));
    expect(four.events).toHaveLength(12);
    expect(validateCell(four)).toEqual([]);
    const mixed = concatCells([c, subdivisionCell(f("1/4"), 5), c]);
    expect(mixed.length).toEqual(f("3/4"));
    expect(mixed.events).toHaveLength(11);
    expect(validateCell(mixed)).toEqual([]);
  });

  it("absolute placement offsets onsets only", () => {
    const placed = absoluteEvents(subdivisionCell(f("1/4"), 2), f("3/2"));
    expect(placed.map((e) => fstr(e.onset))).toEqual(["3/2", "13/8"]);
  });

  it("accent grouping marks the first event of each group", () => {
    const c = subdivisionCell(f("1"), 7);
    expect(accentsFromGroups(c, [3, 2, 2]).events.map((e) => e.accent)).toEqual([3, 1, 1, 2, 1, 2, 1]);
    expect(() => accentsFromGroups(c, [3, 3])).toThrow(MusicTheoryError);
  });

  it("subdivide validates its input", () => {
    expect(() => subdivide(f("1"), 0)).toThrow(MusicTheoryError);
    expect(() => subdivide(f("1"), 1.5)).toThrow(MusicTheoryError);
    expect(subdivide(f("1"), 1)).toEqual([ZERO]);
  });
});

describe("tempo and metric modulation", () => {
  it("90 BPM → 135 BPM: three quarter-note triplets in two beats, each becomes the new quarter", () => {
    const oneTriplet = tupletDuration(f("1/4"), 3, 2); // a quarter-note triplet = 1/6
    expect(oneTriplet).toEqual(f("1/6"));
    expect(metricModulation({ oldBpm: 90, oldBeat: f("1/4"), span: oneTriplet })).toEqual(f("135"));
  });

  it("the modulation is consistent in real time: 3 old triplets last as long as 3 new beats", () => {
    const span = f("1/6");
    const newBpm = fnum(metricModulation({ oldBpm: 90, oldBeat: f("1/4"), span }));
    const oldSeconds = toSeconds(fmul(span, frac(3)), 90);
    expect(oldSeconds).toBeCloseTo(3 * (60 / newBpm), 12);
  });

  it("other modulations stay exact: dotted quarter → quarter, and results need not be whole", () => {
    expect(metricModulation({ oldBpm: 120, oldBeat: f("1/4"), span: f("3/8") })).toEqual(f("80"));
    expect(metricModulation({ oldBpm: 100, oldBeat: f("1/4"), span: f("3/16") })).toEqual(f("400/3"));
    expect(metricModulation({ oldBpm: f("90"), oldBeat: f("1/4"), span: f("1/4") })).toEqual(f("90")); // identity
  });

  it("converts symbolic time to seconds", () => {
    expect(toSeconds(f("1/4"), 120)).toBeCloseTo(0.5, 12);
    expect(toSeconds(f("1"), 60)).toBeCloseTo(4, 12);
    expect(toSeconds(f("1/8"), 60, f("1/8"))).toBeCloseTo(1, 12); // an eighth at 60 BPM of eighths
    expect(toSeconds(fmul(f("1/6"), frac(3)), 120)).toBeCloseTo(1, 12);
    expect(() => toSeconds(f("1/4"), 0)).toThrow(MusicTheoryError);
    expect(() => toSeconds(f("1/4"), 120, ZERO)).toThrow(MusicTheoryError);
  });

  it("rejects impossible modulations", () => {
    expect(() => metricModulation({ oldBpm: 90, oldBeat: f("1/4"), span: ZERO })).toThrow(MusicTheoryError);
    expect(() => metricModulation({ oldBpm: 0, oldBeat: f("1/4"), span: f("1/6") })).toThrow(MusicTheoryError);
  });
});
