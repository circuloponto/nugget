# @musical-lab/engine

Deterministic music-theory and guitar-realization engine. TypeScript, zero
runtime dependencies, no UI, no AI. Same input → same output.

Two layers, one direction of dependency (`instrument` → `theory`, never back):

| Layer | Knows about | Does **not** know about |
|---|---|---|
| `src/theory/` | spelled pitch, scales, triads, inversions, the six cycles | guitars, strings, frets |
| `src/instrument/` | tunings, fretboard, playability, voice leading | key signatures or spelling (it only matches MIDI numbers; spelling travels with the abstract voicing) |

```
npm test               # 255 tests
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

## Known limits (deliberate, for this phase)

- Triads only (3 voices); close-position voicings are generated, but any 3-voice pitch set can be realized.
- 12-TET and heptatonic scales (major, natural minor, harmonic minor). No melodic minor or modes yet.
- No capo, no muted-string voicings, no barre geometry beyond finger counting.
- Cycles 2/7's reference voice-leading tables are not the smoothest possible (4 scale steps of total motion vs 1 for cycles 3/6). They are kept for fidelity to the reference.
