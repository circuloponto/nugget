import { describe, expect, it } from "vitest";
import {
  buildScale,
  CYCLE_IDS,
  cyclePlanToIR,
  DROP_D_TUNING,
  formatPitch,
  makeFretboard,
  planCycleOnGuitar,
  planPerfectCycleLoop,
  STANDARD_TUNING,
  validateMusicIR,
  verifyMusicIRSemantics,
  withDefaults,
  normalizeMusicIR,
  type MusicIR,
} from "../src";

const fb = makeFretboard(STANDARD_TUNING, 22);
const C = withDefaults();
const cMajor = buildScale("C", "major");

type Pos = { string: number; fret: number };
type DPitch = { name: string; midi: number };
type DNote = {
  id: string;
  kind: string;
  voice: string;
  pitch: DPitch;
  onset: string;
  duration: string;
  roles?: Record<string, string>;
  instrument?: Pos;
};
type DChord = {
  id: string;
  onset: string;
  duration: string;
  symbol: string;
  quality: string;
  root: string;
  tones: string[];
  inversion?: number;
  voicing?: { voice: string; pitch: DPitch; instrument?: Pos }[];
};
type Draft = {
  events: DNote[];
  chords: DChord[];
  voices: { id: string; name?: string; instrument?: { name: string; tuning?: string[] } }[];
  constraints: { kind: string; params: Record<string, unknown> }[];
};
/** Same pitch an octave higher (still the same note name and chord tone). */
const octaveUp = (p: DPitch): DPitch => ({ name: p.name.replace(/-?\d+$/, (o) => String(Number(o) + 1)), midi: p.midi + 12 });

/** A valid fretted document from the real planner. */
function guitarDoc(tonic = "C", type: "major" | "naturalMinor" | "harmonicMinor" = "major", length = 4): MusicIR {
  const plan = planCycleOnGuitar(buildScale(tonic, type), 5, fb, { length });
  return cyclePlanToIR(buildScale(tonic, type), 5, plan, { tuning: STANDARD_TUNING, constraints: C });
}
/** Deep copy, then break something. */
function mutate(doc: MusicIR, change: (d: Draft) => void): MusicIR {
  const d = JSON.parse(JSON.stringify(doc)) as Draft;
  change(d);
  return d as unknown as MusicIR;
}
const issues = (doc: unknown) => validateMusicIR(doc).map((i) => `${i.path}: ${i.message}`);
const notes = (d: Draft): DNote[] => d.events.filter((e) => e.kind === "note");

describe("fretted positions must produce the stated pitch under the stated tuning", () => {
  it("accepts documents the planner produced, for every cycle, in several keys", () => {
    for (const id of CYCLE_IDS) {
      for (const [tonic, type] of [["C", "major"], ["F#", "major"], ["Db", "major"], ["A", "harmonicMinor"], ["Eb", "naturalMinor"]] as const) {
        const scale = buildScale(tonic, type);
        const plan = planPerfectCycleLoop(scale, id, fb);
        const ir = cyclePlanToIR(scale, id, plan, { tuning: STANDARD_TUNING, constraints: C });
        expect(verifyMusicIRSemantics(ir), `${tonic} ${type} cycle ${id}`).toEqual([]);
        expect(issues(ir), `${tonic} ${type} cycle ${id}`).toEqual([]);
      }
    }
  });

  it("accepts a hand-written document too (not just ours)", () => {
    expect(issues(handDoc())).toEqual([]);
  });

  it("rejects a fret one too high, naming what it really sounds", () => {
    const bad = mutate(guitarDoc(), (d) => {
      notes(d)[0]!.instrument!.fret += 1;
    });
    const msg = issues(bad).find((m) => m.startsWith("events[0].instrument"));
    expect(msg).toMatch(/sounds MIDI \d+ under tuning \[E2 A2 D3 G3 B3 E4\], but the note is C\d \(MIDI \d+\)/);
  });

  it("rejects the right fret on the wrong string", () => {
    const bad = mutate(guitarDoc(), (d) => {
      const n = notes(d)[0]!;
      n.instrument!.string = (n.instrument!.string + 1) % 6;
    });
    expect(issues(bad).some((m) => /events\[0\]\.instrument: string \d fret \d+ sounds/.test(m))).toBe(true);
  });

  it("checks the chord's own voicing positions as well as the events", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.chords[1]!.voicing![0]!.instrument!.fret += 2;
    });
    const found = issues(bad).filter((m) => m.startsWith("chords[1].voicing[0].instrument"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/but the note is/);
  });

  it("a stated tuning that the frets do not fit is caught (Drop D declared, standard-tuning frets)", () => {
    const scale = buildScale("C", "major");
    const plan = planPerfectCycleLoop(scale, 5, fb);
    const ir = cyclePlanToIR(scale, 5, plan, { tuning: STANDARD_TUNING, constraints: C });
    const lowString = ir.events.filter((e) => e.kind === "note" && e.instrument?.string === 0).length;
    expect(lowString).toBeGreaterThan(0);
    const dropD = DROP_D_TUNING.strings.map(formatPitch);
    const bad = mutate(ir, (d) => {
      for (const v of d.voices) v.instrument!.tuning = dropD;
      d.constraints[0]!.params.tuning = dropD; // keep constraint and voices consistent: only the frets are wrong
    });
    const found = issues(bad).filter((m) => /sounds MIDI/.test(m));
    // exactly the notes on the low string (events and voicing entries) now sound two semitones off
    const voicingLow = ir.chords.flatMap((c) => c.voicing ?? []).filter((v) => v.instrument?.string === 0).length;
    expect(found).toHaveLength(lowString + voicingLow);
    expect(found.every((m) => /string 0 fret/.test(m))).toBe(true);
    // and the correct tuning is of course fine
    expect(issues(ir)).toEqual([]);
  });

  it("refuses to trust a position when no tuning is stated", () => {
    const bad = mutate(guitarDoc(), (d) => {
      for (const v of d.voices) delete v.instrument;
    });
    const found = issues(bad).filter((m) => /states no tuning/.test(m));
    expect(found.length).toBeGreaterThanOrEqual(12); // 4 chords x 3 notes (events) and the voicings
  });

  it("rejects a string that does not exist", () => {
    const bad = mutate(guitarDoc(), (d) => {
      notes(d)[0]!.instrument!.string = 9;
    });
    expect(issues(bad).join("\n")).toMatch(/string 9 does not exist: the tuning has 6 strings/);
  });

  it("holds the document to its own maxFret", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.constraints[0]!.params.maxFret = 2;
    });
    const found = issues(bad).filter((m) => /above the document's own maxFret 2/.test(m));
    expect(found.length).toBeGreaterThan(0);
  });

  it("rejects a voice tuning that disagrees with the playability constraint's tuning", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.voices[0]!.instrument!.tuning = DROP_D_TUNING.strings.map(formatPitch);
    });
    expect(issues(bad).join("\n")).toMatch(/disagrees with the playability constraint's tuning/);
  });

  it("rejects an unparseable tuning name", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.voices[0]!.instrument!.tuning![2] = "H9";
    });
    expect(issues(bad).join("\n")).toMatch(/"H9" is not a pitch name/);
  });

  it("a string cannot sound two notes at once", () => {
    // a fifth voice (so no single-line overlap) plays the same string while it is already sounding
    const bad = normalizeMusicIR(
      mutate(handDoc(), (d) => {
        d.voices.push({ id: "v9", name: "extra", instrument: { name: "guitar", tuning: ["E2", "A2", "D3", "G3", "B3", "E4"] } });
        d.events.push({
          id: "second",
          kind: "note",
          voice: "v9",
          pitch: { name: "C3", midi: 48 },
          onset: "1/8",
          duration: "1/8",
          instrument: { string: 1, fret: 3 }, // the A string is still ringing the C from the first note
        });
      }),
    );
    expect(issues(bad).join("\n")).toMatch(/string 1 is already sounding events\[\d+\]; a string cannot play two notes at once/);
  });

  it("successive notes on the same string are fine (no overlap)", () => {
    expect(issues(handDoc())).toEqual([]);
    const doc = mutate(handDoc(), (d) => {
      const first = d.events[0]!;
      d.events.push({ ...first, id: "again", onset: "1/4", duration: "1/4" });
    });
    expect(issues(doc).filter((m) => /already sounding/.test(m))).toEqual([]);
  });
});

describe("chord annotations must agree with the musical events", () => {
  it("accepts a chord whose notes are its tones, spelled as the chord spells them", () => {
    expect(issues(guitarDoc("Db", "major", 7))).toEqual([]);
    expect(issues(guitarDoc("G#", "harmonicMinor", 7))).toEqual([]);
  });

  it("rejects a harmonic role that names the wrong tone", () => {
    const bad = mutate(guitarDoc(), (d) => {
      notes(d)[0]!.roles = { harmonic: "third" }; // that note is the root
    });
    expect(issues(bad).join("\n")).toMatch(/labelled third of C, but the third is E and the note is C\d/);
  });

  it("rejects a note that is not a chord tone and has no melodic role to explain it", () => {
    const bad = mutate(noPositions(guitarDoc()), (d) => {
      d.chords[0]!.voicing = undefined;
      notes(d)[0]!.pitch = { name: "D3", midi: 50 };
      delete notes(d)[0]!.roles;
    });
    expect(issues(bad).join("\n")).toMatch(/D3 is not a tone of C \(C E G\) and has no melodic role to explain it/);
  });

  it("accepts the same non-chord tone once a melodic role explains it (a passing tone)", () => {
    const base = noPositions(guitarDoc());
    const ok = mutate(base, (d) => {
      d.chords[0]!.voicing = undefined;
      notes(d)[0]!.pitch = { name: "D3", midi: 50 };
      notes(d)[0]!.roles = { melodic: "passing" };
    });
    expect(issues(ok).filter((m) => /is not a tone of/.test(m))).toEqual([]);
  });

  it("rejects an enharmonic misspelling: same sound, wrong note name (G# over an Ab chord)", () => {
    const doc = noPositions(guitarDoc("Db", "major", 3));
    const ab = notes(JSON.parse(JSON.stringify(doc)) as Draft).findIndex((n) => n.pitch.name.startsWith("Ab"));
    expect(ab).toBeGreaterThanOrEqual(0);
    const bad = mutate(doc, (d) => {
      const n = notes(d)[ab]!;
      n.pitch = { name: n.pitch.name.replace("Ab", "G#"), midi: n.pitch.midi };
    });
    expect(issues(bad).join("\n")).toMatch(/G#\d is spelled differently from the chord's Ab/);
  });

  it("rejects an inversion that does not match the lowest note", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.chords[0]!.inversion = 1; // C/E: but the bass is C
    });
    expect(issues(bad).join("\n")).toMatch(/inversion 1 puts E in the bass, but the lowest note is MIDI \d+/);
  });

  it("rejects an impossible inversion number", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.chords[0]!.inversion = 5;
    });
    expect(issues(bad).join("\n")).toMatch(/inversion 5 is impossible for a chord of 3 tones/);
  });

  it("rejects a quality that contradicts the tones, and a symbol that contradicts root + quality", () => {
    const badQ = mutate(guitarDoc(), (d) => {
      d.chords[0]!.quality = "minor";
    });
    expect(issues(badQ).join("\n")).toMatch(/quality says minor, but the tones C E G form a major triad/);
    const badS = mutate(guitarDoc(), (d) => {
      d.chords[1]!.symbol = "Gm7";
    });
    expect(issues(badS).join("\n")).toMatch(/symbol "Gm7" does not match root G \+ quality major \(expected "G"\)/);
  });

  it("rejects a root that is not the first tone", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.chords[0]!.root = "E";
    });
    expect(issues(bad).join("\n")).toMatch(/root E is not the first chord tone \(C\)/);
  });

  it("rejects a voicing entry that is not a chord tone", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.chords[0]!.voicing![1]!.pitch = { name: "D3", midi: 50 };
      delete d.chords[0]!.voicing![1]!.instrument;
    });
    expect(issues(bad).join("\n")).toMatch(/chords\[0\]\.voicing\[1\]: D3 is not a tone of C/);
  });

  it("rejects a note that is a chord tone but is not in the chord's stated voicing", () => {
    const bad = mutate(noPositions(guitarDoc()), (d) => {
      // move voice 1's note up an octave: still a C, spelled right, but not the note that was voiced
      const n = notes(d)[0]!;
      n.pitch = octaveUp(n.pitch);
    });
    expect(issues(bad).join("\n")).toMatch(/C\d in voice "v1" is not part of C's stated voicing/);
  });

  it("handles chords of more than three tones (a seventh) and non-triad harmonic roles", () => {
    expect(issues(handDoc({ seventh: true }))).toEqual([]);
    const bad = mutate(handDoc({ seventh: true }), (d) => {
      const n = notes(d).find((x) => x.pitch.name === "B3")!;
      n.pitch = { name: "Bb3", midi: 58 };
      n.roles = { harmonic: "seventh" };
      delete n.instrument;
      d.chords[0]!.voicing = d.chords[0]!.voicing!.filter((v) => v.pitch.name !== "B3");
    });
    expect(issues(bad).join("\n")).toMatch(/Bb3 is not a tone of Cmaj7/);
  });
});

describe("semantic checks do not replace structural ones", () => {
  it("only run on a structurally valid document, and the structural errors come first", () => {
    const broken = mutate(guitarDoc(), (d) => {
      notes(d)[0]!.onset = "not a fraction";
      notes(d)[1]!.instrument!.fret += 1; // would be a semantic error
    });
    const found = issues(broken);
    expect(found.some((m) => /exact fraction/.test(m))).toBe(true);
    expect(found.some((m) => /sounds MIDI/.test(m))).toBe(false); // not reported until the structure is fixed
  });

  it("a malformed chord voicing is a structural error", () => {
    const bad = mutate(guitarDoc(), (d) => {
      d.chords[0]!.voicing![0]!.voice = "ghost";
    });
    expect(issues(bad).join("\n")).toMatch(/chords\[0\]\.voicing\[0\]: unknown voice/);
  });
});

// ── fixtures ───────────────────────────────────────────────────────────────
/** The same document without fret positions (so spelling/role checks can be isolated). */
function noPositions(doc: MusicIR): MusicIR {
  return mutate(doc, (d) => {
    for (const e of d.events) delete e.instrument;
    for (const c of d.chords) for (const v of c.voicing ?? []) delete v.instrument;
  });
}

/** C major (or Cmaj7) written by hand: root-position open chord, with correct frets and stated tuning. */
function handDoc(opts: { seventh?: boolean } = {}): MusicIR {
  const open = ["E2", "A2", "D3", "G3", "B3", "E4"];
  // A string fret 3 = C3, D string fret 2 = E3, G string open = G3, B string open = B3
  const base = [
    { voice: "v1", pitch: { name: "C3", midi: 48 }, instrument: { string: 1, fret: 3 }, role: "root" },
    { voice: "v2", pitch: { name: "E3", midi: 52 }, instrument: { string: 2, fret: 2 }, role: "third" },
    { voice: "v3", pitch: { name: "G3", midi: 55 }, instrument: { string: 3, fret: 0 }, role: "fifth" },
    ...(opts.seventh ? [{ voice: "v4", pitch: { name: "B3", midi: 59 }, instrument: { string: 4, fret: 0 }, role: "seventh" }] : []),
  ];
  const voices = base.map((b, i) => ({ id: b.voice, name: `voice ${i + 1}`, instrument: { name: "guitar", tuning: open } }));
  return {
    version: 1,
    id: "hand-written",
    voices,
    events: base.map((b, i) => ({
      id: `n${i}`,
      kind: "note",
      voice: b.voice,
      pitch: b.pitch,
      onset: "0",
      duration: "1/4",
      roles: { harmonic: b.role },
      instrument: b.instrument,
    })),
    chords: [
      {
        id: "c0",
        onset: "0",
        duration: "1/4",
        symbol: opts.seventh ? "Cmaj7" : "C",
        quality: opts.seventh ? "major7" : "major",
        root: "C",
        tones: opts.seventh ? ["C", "E", "G", "B"] : ["C", "E", "G"],
        inversion: 0,
        voicing: base.map((b) => ({ voice: b.voice, pitch: b.pitch, instrument: b.instrument })),
      },
    ],
    relations: [],
    constraints: [],
    transformations: [],
  } as unknown as MusicIR;
}
