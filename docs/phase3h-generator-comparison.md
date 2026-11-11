# Phase 3H.4: Nugget's generator against the corpus

Everything here is measured by `npm run compare -- data/corpus/incoming/nugget_folk_starter.zip` (writes `data/corpus/normalized/<id>/comparison.json`, shown at `Generator vs corpus` in the app). The comparison is reproducible: the same archive, keys and seeds give the same file.

## What was compared

- **Generator:** 252 phrases from 36 runs of the Phase 3 explorer, by the same path the Workbench uses (`PhraseRequest → explorePhrases → phraseToIR`): 12 major keys × seeds 1–3, the default seven contrasting phrases per run, every phrase in 4/4 over a ii–V–I.
- **Corpus:** 189 phrases (the primary reading of the phrase analysis) from 23 folk dance tunes. Also reported for the 7 tunes in 4/4 only, and for a fixed development / held-out split (15 / 8 tunes, stratified by category and a hash of the id) that stage 3H.5 will use.
- **Method:** each phrase is cut out as its own line and measured by the identical rhythm, melody and phrase analyses. Every metric is also computed per corpus tune and per generator run; a generator value counts as **outside the corpus's range** only if it lies outside the 10th–90th percentile of the individual tunes. That is a statement about how far the value is from how much real tunes differ from each other, not a statement about quality.

## Result: 17 of 40 metrics are outside the corpus's range

| | generator | corpus | corpus 4/4 | |
|---|---|---|---|---|
| notes per phrase (median) | 5 | 11 | 12 | below |
| attacks per beat | 0.75 | 1.64 | 1.39 | below |
| held notes (≥ 2 beats) | 25.6% | 2.7% | 4.2% | above |
| notes in runs of 8+ short notes | 0.0% | 34.5% | 45.0% | within |
| bursts that end held or on a rest | 97.7% | 51.3% | 86.2% | within |
| distinct note lengths per phrase | 3.55 | 2.56 | 2.38 | above |
| phrases with a repeated rhythmic cell | 4.4% | 37.0% | 28.6% | below |
| phrases with a repeated melodic motif | 0.8% | 19.6% | 28.6% | within |
| syncopated notes | 12.6% | 1.7% | 3.0% | above |
| phrases containing a written rest | 55.2% | 1.1% | 0.0% | above (see limits) |
| steps / skips / leaps | 66 / 24 / 8% | 60 / 21 / 10% | 64 / 19 / 12% | within |
| mean interval size | 2.34 | 2.39 | 2.49 | within |
| line reverses after a leap | 41% | 55% | 57% | within |
| arch / valley contours | 26 / 14% | 52 / 23% | 43 / 25% | within |
| ascending / level contours | 25 / 14% | 13 / 1% | 18 / 0% | above |
| opens on a strong position | 71% | 85% | 81% | below |
| last note length (median, beats) | 4 | 1 | 1 | above |
| phrase decelerates into its end | 100% | 44% | 52% | above |
| ends on a strong position | 100% | 55% | 48% | above |
| difference between phrases (mean) | 0.57 | 0.45 | 0.44 | above |

All 40 metrics, their spreads and the distributions are in `comparison.json` and on the page.

## What the comparison does and does not say

1. **Melodic intervals are not where the difference is.** Steps, skips, leaps, mean interval size and the tendency to turn back after a leap all sit inside the range of real tunes.
2. **The user's complaint about "too many consecutive notes" is not borne out by these measures.** The generator has *fewer* long runs than the corpus: no note in a run of eight or more short notes (the corpus: a third), and a longest run of 2.2 notes (the corpus: 6.3). What it has instead is a different shape: **every generated phrase ends on a 4-beat note** (the target held for its whole bar), after only about four notes of approach. The corpus's median final note is one beat and 56% of its phrases do not decelerate at all. So "burst, then hold" is 98% of the generator's bursts, against 51–86% in the corpus: the pattern exists in real tunes but is not universal there, and in the generator it is the only ending there is.
3. **Plausible explanations in the generator's design (not tested):**
   - the target is held until the end of its chord, so the arrival is always long and always on a strong position;
   - phrases are 1–1½ bars and built from an outline plus an embellishment, so they are short (5 notes against 11) and contain no repeated motif;
   - the explorer is built to return *contrasting* phrases, so repetition within a phrase and similarity between phrases are both low (difference between phrases 0.57 against 0.45): the selection that keeps results distinct also removes the repetition that real tunes lean on;
   - rhythm plans are drawn from a catalogue of gestures including dotted and syncopated figures, which gives more distinct note lengths per phrase (3.6 against 2.6) and about seven times the syncopation of the corpus;
   - the contour filter includes "level" and the strategies include ones that end on the starting pitch, hence the level contours.
4. These are hypotheses for stage 3H.5 to act on, not defects: the corpus is folk dance music in mostly compound and triple meter; the generator writes jazz-style lines over changes.

## Limits

- **Silence cannot be judged from this corpus.** It contains only 2 written rests (the rest of the converted file's rests are converter padding, excluded). The generator's 55% of phrases with a rest is therefore "outside the range" only because the range is almost zero; the corpus gives no evidence that this is wrong.
- Phrase length differs (1–1½ bars against about 2) and so does meter (all 4/4 against mostly 6/8, 9/8, 3/4). Measures are per beat and the 4/4-only column controls for meter, not for length.
- Corpus phrase boundaries are hypotheses (see the phrase analysis); the generator's phrases are exactly what it was asked to build.
- 23 tunes, one repertoire, machine-converted. The spread across tunes is wide for rare events (a metric measured over a few phrases per tune), so many "within" verdicts mean "the corpus cannot tell".
- I have not listened to any phrase from either side. The page draws example phrases (twelve, chosen at even intervals, not picked); listening is stage 3H.6.

## Tests

`test/corpus.compare.test.ts` (13 tests): slicing a phrase from a line (exact times, edge rests, padding rests), the stratified, order-independent development / held-out split, reproducible generator sampling by key and seed, and the comparison itself on fabricated phrases with a known property (every one ends on a whole note): the verdict, the distributions summing to one, determinism, and failed runs being counted. Two deliberate breakages (verdict always "within"; edge rests not taken with the phrase) were each caught.
