# @musical-lab/engine

Deterministic music-theory and guitar-realization engine. TypeScript, zero
runtime dependencies, no UI, no AI. Same input → same output.

Layers (`instrument` → `theory`; `ir` reads both; `time` and `audio` stand alone):

| Layer | Knows about | Does **not** know about |
|---|---|---|
| `src/theory/` | spelled pitch, scales, triads, inversions, the six cycles | guitars, strings, frets |
| `src/instrument/` | tunings, fretboard, playability, voice leading | key signatures or spelling (it only matches MIDI numbers; spelling travels with the abstract voicing) |
| `src/time/` | exact rational time, meter, tuplets, polyrhythm, polymeter, phase, metric modulation | pitch, instruments |
| `src/ir/` | MusicIR v1: events, voices, chords, relations, constraints, transformations; adapters from the engine; validation; (de)serialization; scheduling | how any of it was computed |
| `src/audio/` | plucked-string synthesis as pure `Float32Array` functions | Web Audio, any player |

```
npm test               # 382 tests
npm run build          # ESM + CJS + .d.ts into dist/
```

## Quick use

```ts
import { buildScale, planCycleOnGuitar, makeFretboard, STANDARD_TUNING } from "@musical-lab/engine";

const scale = buildScale("A", "harmonicMinor");          // A B C D E F G#
const { cycle, path } = planCycleOnGuitar(scale, 5, makeFretboard(STANDARD_TUNING), {
  inversion: 0, length: 7, anchorFret: 5,
});
if (path.ok) for (const s of path.steps) console.log(s.voicing.triad.symbol, s.guitar.notes);
else console.warn(path.reason);                           // never silently wrong
```

## API map

**Theory** — `parseNote/parsePitch/formatPitch`, `midi`, `addInterval`
(letter-correct spelling), `buildScale(tonic, "major" | "naturalMinor" |
"harmonicMinor")`, `pitchAtStep`, `triadAt/diatonicTriads` (quality, roman
numeral and symbol are *derived*), `closeVoicing`, `inversionOfSteps`,
`CYCLES` / `generateCycle(scale, 2..7, opts)` / `verifyCycleDefinition`.

**Instrument** — `makeFretboard`, `STANDARD_TUNING`, `DROP_D_TUNING`,
`midiAt`, `positionsForMidi`, `validateVoicing` (returns coded violations),
`realizePitches/realizeVoicing/findTriadVoicings`, `transitionCost`,
`planGuitarPath` (globally optimal, Viterbi), `planCycleOnGuitar`.

**`octaveShift: "sweep"`** runs a cycle the way it really moves: the voicing keeps
its octave from chord to chord, so you hear the cycle's own voice leading as it
travels along the neck and changes string sets. When the next chord has no
playable position left, the whole voicing wraps to the far end (the top of the
neck for descending cycles 2, 3, 5; the bottom for ascending cycles 4, 6, 7, see
`cycleDrift`) and continues. `PlannedStep.wrapped` marks each wrap. Slow cycles
(3, 6) need ~70 chords before they run out of neck; cycle 5 wraps about every 27.

**`planPerfectCycleLoop(scale, cycle, fretboard, opts)`** is a sweep that closes
on itself and never stops. The cycle keeps its real pitches and true next triad
the whole way: it runs along the neck changing string sets, wraps to the far end
whenever the next triad has no room left, and carries on with the *next triad of
the cycle* (it never jumps back to chord 1). It ends when the triad after the last
chord is the first triad again, in the same place, so playing on repeats the loop.

Closing exactly needs the run to land on the first chord at a wrap or by simple
continuation. Landing as high as possible rarely does that by chance (only ~30% of
cases), so the search is free to pick the first chord's start among its highest
placements and, if needed, which high octave a wrap lands in; it prefers the
highest start, then the highest landings, then the shortest loop. Every
cycle/inversion/start degree/key tried closes, in 21 or 42 chords with 1 or 2
wraps. Result: `length`, `laps`, `wraps`, `startOctavesFromEdge`,
`restartJumpOctaves` (0 = plain continuation, otherwise the last wrap lands on the
first chord) and the usual `path` (with `closingCost`).

Planner options worth knowing: `octaveShift` (`"sweep"` | `"whole-voicing"` | `"none"`),
`anchorFret` (where the first chord sits), and `loop: true`, which treats the
cycle as a circuit. In loop mode the last→first transition is optimized with the
rest, so the planner may change string set or fold octaves at the wrap;
`closingCost` reports that move. `spellMidiInScale` labels any fret in a key's
own spelling.

## Conventions you must know

- **String index 0 is the lowest-pitched string** (guitar "6th"). `guitarStringNumber()` converts. Fret 0 is open.
- **Scale steps** are absolute: 0 = tonic, 7 = tonic an octave up, −1 = the note below.
- **Octaves follow the letter**: B#3 = MIDI 60, Cb4 = MIDI 59.
- **Fret span** = highest fretted fret − lowest fretted fret; open strings don't count. Default limit 4; configurable.
- `GuitarNote.pitch` keeps the scale's spelling (Gb stays Gb, never F#).

## The cycles

Cycle *N* moves a diatonic triad so its root rises *N − 1* scale degrees, with a
fixed per-role voice-leading table. `verifyCycleDefinition` proves every table
against all 7 degrees × 3 inversions. Facts established by the tests:

- The triad sequence repeats every **7** steps; the *voicing* (with inversion) every **21**.
- No voice moves more than 2 scale steps per chord, and voices never cross.
- Every cycle drifts in pitch (cycles 3 and 6 slowly, 5 moderately, 2, 4 and 7 fast:
  cycle 7 climbs ~3 octaves in 14 chords). Long runs must be folded onto the fretboard: `octaveShift: "whole-voicing"` (default) moves a
  whole chord by octaves, keeping spelling and inversion, and **reports every shift**
  in `PlannedStep.octaveShift`. `octaveShift: "none"` instead fails loudly.

## Differences from the reference (`triad_playground`)

The reference was used as a source of algorithms, not as ground truth. Changed:

1. Sharps-only note table → spelled pitches (F# major has E#, G# harmonic minor has F##).
2. Hard-coded `major`/`minor` triad quality → derived from stacked thirds; adds harmonic minor (III+, vii°).
3. Pitch-class matching → exact MIDI pitches, so inversions are verifiable on the fretboard.
4. Contradictory string-index conventions → one explicit convention.
5. Mixed inclusive/exclusive fret spans and magic numbers (2/3/4/5) → one span definition.
6. Greedy next-position search with area heuristics (its own guide says it rejects valid positions) → dynamic programming over the whole sequence.
7. Cycle tables kept, but proven rather than trusted.

## Temporal engine (`src/time/`)

All symbolic time is an exact fraction of a whole note (`frac(1, 4)` = a quarter).
Floats appear only in `toSeconds`, at the playback edge. So a triplet is exactly
1/3 of its span, and 3/4 against 4/4 provably realign after 12 beats.

- `rational.ts`: `frac`, `fadd`/`fmul`/`fdiv`, `fcmp`, `fmod`, `lcmFractions`, `parseFraction`/`fstr`. Normalized, overflow-checked (throws rather than wrong), BigInt comparison.
- `meter.ts`: `parseMeter("7/8", [2, 2, 3])`, `barLength`, `pulsePositions`, `groupStarts`, `accentProfile` (downbeat 3 > group start 2 > pulse 1).
- `rhythm.ts`: cells (`makeCell`/`validateCell`), `subdivide`, `tupletCell`/`tupletDuration`, nested tuplets (`nestedSubdivision`, `subdivideEvent`), `polyrhythm`, `polymeterRealignment`, `rotate` (phase; splits and ties notes that cross the bar, additive), `scaleCell` (augmentation/diminution), `concatCells`, `accentsFromGroups`.
- `tempo.ts`: `toSeconds`, `metricModulation` (exact: 90 BPM with a quarter-note triplet becoming the beat is 135 BPM).

## MusicIR v1 (`src/ir/`)

A versioned, JSON-native document that can hold what `TriadVoicing` cannot: any
number of voices, chord annotations, relations, constraints and the transformations
that produced the material. **Existing engine objects map into it; they are not
replaced by it.**

- Times are exact fraction strings (`"3/8"`); pitches carry spelled name and MIDI (checked to agree); every entity has a unique id; provenance is `observed | inferred | generated | user`.
- Adapters: `triadVoicingToIR`, `cycleToIR`, `cyclePlanToIR` (works with `planCycleOnGuitar` and `planPerfectCycleLoop`), and `irChordPitches` to read pitches back (tests prove they equal what the harmonic engine played).
- `validateMusicIR(unknown)` reports every problem with a path and never throws: version, unique ids, unknown references, bad fractions, pitch/MIDI mismatch, canonical event order, overlap inside a single-line voice, chord segments, tempo/meter. `normalizeMusicIR` sorts; `serializeMusicIR`/`parseMusicIR` round-trip to byte-identical text.
- `scheduleFromIR`/`chordTimeline` turn it into seconds through the temporal engine.

## Audio (`src/audio/`)

`synthesizePluck(midi)` / `synthesizeChord(midis)` produce Karplus-Strong plucked-string
samples as plain `Float32Array`s: deterministic, and tuned with a fractional-delay
all-pass to well under 1 cent over the whole guitar range (tested to 3). The Lab wraps
them in Web Audio; any other player can do the same.

Tone is three parameters (all 0..1 except `attackSeconds`):

| Parameter | Effect | Lower means |
|---|---|---|
| `damping` | loop low-pass (symmetric 3-tap, so tuning never moves) | brighter, more strident |
| `hardness` | how raw the initial noise burst is | rounder, less "pluck" |
| `decay` | loop gain | shorter ring, less resonance |
| `attackSeconds` | fade-in | n/a (higher = softer start) |

`PLUCK_TONES` names three settings: `bright` (the original sound), `mellow` (the default:
about 30% less bright, half the pluck spike, 35-45% shorter ring) and `soft` (no pluck
spike, rings about half as long as the original). Measured, and locked in by tests.

## About "playable"

`validateVoicing` is an **approximation**: it checks that strings exist and are not
reused, string order and adjacency, exact pitches, the fret stretch (open strings
excluded) and an estimated finger count. A shape that passes is *valid under the
configured constraints*. That is not a guarantee it is comfortable or possible for
every hand. The Lab and the exported MusicIR both say so.

## Known limits (deliberate, for this phase)

- The harmonic engine is triads only (3 voices) and heptatonic scales (major, natural minor, harmonic minor). Seventh chords, extensions, melodic gestures and generalized events are **not** forced into `TriadVoicing`: they belong in MusicIR, with new voicing/adapters beside the existing ones.
- Rhythm exists as an engine and in MusicIR, but the cycles still play one chord per beat; no rhythmic phrasing is generated yet.
- 12-TET only. Audio is a plucked-string model, not a sampled guitar.
- No capo, no muted-string voicings, no barre geometry beyond finger counting.
- Cycles 2/7's reference voice-leading tables are not the smoothest possible (4 scale steps of total motion vs 1 for cycles 3/6). They are kept for fidelity to the reference.
