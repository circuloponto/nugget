# Phase 3 revision: generation diversity

Implementation report. Everything below was measured on this code; numbers are reproducible with the seeds named.

## 1. The original convergence problem

**Symptom.** Asked for more phrases, the generator returned the same idea again.

**Measured on the default request** (Dm7 – G7 – Cmaj7, arrive on the 3rd of Cmaj7, `generatePhrase`):

| | 5 requested | 40 requested |
|---|---|---|
| distinct target degrees | 1 (the 3rd) | 1 |
| target pitch | E4 ×3, E5 ×2 | E4 ×37, E5 ×3 |
| embellishment | "chromatic enclosure" ×5 | "chromatic enclosure from below" ×37 |
| outline | "down 3" ×2, "mixed 4" ×3 | "down 3" ×29 |
| phrases containing a rest | 0 | 22 |
| score range | 0.926 – 0.941 | 0.926 – 0.941 |

The generator had examined 2,970 combinations; the problem was what it did with them. Causes, in the code:

1. **One dimension of choice.** `generatePhrase` fixes the target, then varies only the arpeggio shape and the rhythm plan for it. There was no notion of a different target, register, melodic strategy, contour or length.
2. **A saturating scalar rank.** Every component of the score (strong beats on chord tones, step share, final step into the target, variety, fingering cost) is near its ceiling for well-formed material, so all candidates scored within 0.015 of each other. Ties then fell to a lexicographic key: the same material won every time.
3. **A top-400 cut before diversity.** Selection only saw the 400 best-scoring candidates, which are the same pitch material with different rhythm plans.
4. **A similarity measure blind to what matters.** `similarity` was 0.5 × (share of equal pitches at the same index) + 0.5 × (same rhythm plan id). A rhythm-only change scored 0.5 similar, an octave change of the same line scored 0, and the penalty (0.25 × similarity) was too small to matter against a 0.015 score spread.
5. **Rhythm chosen from a ranked list of 30 plans per note count**, ordered by distance from a density/syncopation target, so the same first gestures ("dotted-eighth") led every list.
6. **Octave never a decision.** Both octaves of the target were enumerated, but the register-wide ranking preferred the middle one.

## 2. The new generation algorithm (`src/grammar/explore.ts`)

`explorePhrases(GenerationSpace)` changes the question from "the best few ways to reach this target" to "a few contrasting phrases over this harmony".

**`GenerationSpace`** has independent dimensions; locking one is giving it one value.

| Dimension | Values (defaults) |
|---|---|
| target | **Explore**: every chord tone and natural extension of the last chord (Cmaj7: C E G B, 9th D, 13th A). **Focus**: one degree. |
| octave band | low 52–63, mid 64–75, high 76–87 (12 semitones each, so a degree has at most one pitch per band) |
| melodic / harmonic strategy | 11, all built from grammar operations: arpeggio (up, down, mixed, up-down) with chromatic or diatonic enclosure or approach; shell tones 1-3-7; upper structure 3-5-7-9; guide tones 3-7; scale run (`connect`); enclosure alone; two-chord lines (ii arpeggio then V arpeggio) |
| contour | any, ascending, descending, arch, valley |
| rhythmic character | flowing, dotted, syncopated, triplet, with rests, delayed resolution, dense, broad |
| density | sparse, medium, busy (sets how many notes the strategy needs) |
| phrase length | short (2 beats), standard (1 bar), long (1½ bars, two chords) |

**Pipeline.**

1. *Seeded balanced sampling.* Intentions are cells of the space. Target slots (degree × band) are visited in a seeded shuffle; every other dimension uses `pickBalanced`: the least-used value so far, ties broken by the seeded stream (mulberry32). Every value of every dimension is therefore visited about equally, in an order fixed by the seed. The seed never touches what a phrase *is*, only which intentions are visited.
2. *Realisation by the existing grammar.* Each intention becomes a narrowed `PhraseSpec` (one target pitch in its band, one strategy, one rhythmic character) and goes through `generatePhrase`, keeping at most two candidates. This needed four additions to the grammar, each tested: a target **range** (octave), a **lead arpeggio** over the earlier chord, a **scale run** embellishment built with `connect`, and a hard **contour** filter. A segment's notes must sound during its own chord (an arpeggio of G7 belongs over G7).
3. *Rhythm is part of the intention.* A rhythmic character is a **hard requirement** on the plan (tags it must or must not contain; silence before the target; silence at the start), applied while plans are enumerated for exactly the notes the pitch material needs. "Triplet" phrases contain triplets; "delayed resolution" phrases end in a rest. Accent comes from the metric position the rhythm produces, and the pitch material is judged against it.
4. *Verification before ranking.* Every candidate is built into a MusicIR document and validated, and the hard constraints are re-measured independently (register, leap, exact arrival, no gap or overlap from the start to the arrival). `rejectedInvalid` is reported; it was 0 in every run.

Yield: about 40 of 100 intentions are reachable (a "valley" contour, a triplet requirement and a short phrase often cannot all hold); unreachable ones are reported, not retried.

## 3. Diversity-aware selection

1. Exact duplicates (same pitches, same onsets and lengths) are removed.
2. **Distance** between two phrases is a weighted sum over seven independent aspects, each 0–1, computed from traits **measured from the phrase** (not from what was asked for):

   | aspect | weight | how |
   |---|---|---|
   | target | 0.20 | different degree 1; same degree, different octave 0.5 |
   | register | 0.08 | adjacent band 0.5, two apart 1 |
   | structure | 0.20 | Jaccard distance of {strategy family, harmonic strategy, embellishment, gesture kinds} |
   | contour | 0.14 | 0.6 × class differs + 0.4 × normalised edit distance of the up/down shapes |
   | rhythm | 0.22 | 0.5 × Jaccard of onsets + 0.3 × of rhythmic gestures + 0.2 × of rhythm tags |
   | pitch material | 0.10 | Jaccard distance of pitch-class sets |
   | density/length | 0.06 | mismatch |

   A rhythm-only change moves only the rhythm term; an octave change moves target and register but not contour or rhythm (both asserted in the tests).
3. **Near duplicates**: a candidate whose distance to an already chosen one is below τ = 0.22 is dropped for good.
4. **Greedy, coverage-first choice.** The best-scoring candidate first (quality floor: within 0.25 of the best); then repeatedly the candidate maximising `distance to the nearest chosen + 0.08 × (new target / register / strategy / rhythm / contour / length / density values it brings) + 0.5 × (score − best)`.
5. **Never padded.** If no remaining candidate is at least τ from the chosen ones, selection stops and `stats.note` says how many genuinely distinct phrases exist. Default count is 7 (the UI offers 3 to 12).

## 4. How diversity was measured

`measureDiversity` reports the minimum and mean pairwise distance and the number of distinct values per dimension. These are in `ExploreStats` and shown on the page.

| | old generator, 7 phrases | new, default, C major seed 1 | new, 12 keys × seeds 1–3 (36 runs) |
|---|---|---|---|
| distinct target degrees | 1 | 6 (of C E G B D A) | 5.7 average |
| distinct target pitches | 2 | 7 | |
| octave bands | (E4/E5 only) | 3 | 2.9 |
| strategy families | 1 embellishment | 7 | 6.6 |
| rhythmic characters | 1 first gesture | 7 | 7.0 |
| contours | not measured | 5 | 4.9 |
| lengths | 1 | 3 | 3.0 |
| closest pair (distance) | not defined | 0.615 | **0.582** minimum over all 36 runs |
| mean pairwise distance | not defined | 0.785 | 0.770 |
| phrases returned | 7 | 7 | 7.0 |
| time | ~0.5 s | ~1.6 s | ~0.9 s average |

The old generator has no traits, so its distance is not computed; its row counts distinct values only. The new closest pair (0.582) is far above the near-duplicate threshold (0.22).

**Regression tests** (`test/grammar.explore.test.ts`, 40 tests; `grammar.request.test.ts`, 11):

- the original convergence is pinned (one target, one embellishment) so a regression to it is caught;
- the acceptance scenario: 6–8 phrases, targets among C E G B D A with at least five distinct, at least three chord tones and at least one extension, at least 2 registers, 3 contours, 4 strategies, 4 rhythmic characters, 2 lengths, exact arrival on the downbeat of Cmaj7, no near duplicates, 0 rejected;
- the same seed reproduces everything byte for byte; four different seeds give four different sets, each sound and diverse;
- all 12 major keys, the minor ii–V–i, a four-chord vi–ii–V–I, a bare V–I (long phrases and two-chord lines correctly not offered), and a one-chord progression (refused);
- Focus mode, and locks on target, rhythm, contour, strategy and register, individually and combined;
- fewer, not padded: an over-constrained space returns fewer and says so; τ = 0.45 returns fewer than τ = 0.22, which returns fewer than τ = 0;
- rhythm delivered as asked: triplet, delayed resolution, rests, dotted, syncopated, flowing;
- the verifier catches tampering.

**Mutation checks**: six deliberate breakages (near-duplicate removal off; selection by score only; sampler always takes the first value; rhythm requirements ignored; target octave range ignored; contour-shape lock ignored) were each caught.

## 5. Controls

The Phrase Constructor (`/phrase`) has **Explore** and **Focus** target modes; each other dimension is "explore all" or one chosen value; a seed with "Another set (next seed)"; and for the selected phrase a **Develop** panel with check-boxes for keeping its target (degree and octave), register, strategy, exact rhythm, exact contour shape, density or length, then "Develop variations" (the seed advances). Locks applied from a developed phrase are shown in a banner and can be cleared (a bug found by the browser run: they were invisible and silently carried into later explorations). Every card shows its measured traits as chips, what sets it apart from the others returned with it, its construction, and the reason for its score. A request saved in a document restores the mode, dimensions, seed and locks; requests saved by the earlier build migrate to Focus.

Verified in headless Chrome with real clicks: 35 checks (6–8 phrases; five or more target degrees from C E G B D A; three registers; five contours; seven strategy families; reproduction by seed; next seed differs; rhythm lock gives only triplet phrases; Focus keeps E; Develop keeps the chosen target and every onset and length exactly; contour lock keeps the contour; over-constraint returns fewer and says so; impossible register fails with a reason; save, load, corrupt and non-JSON files) with no console errors. The Phase 2 Lab still passes its 33 checks.

## 6. Limits, stated plainly

- The distance is a heuristic for "different", with hand-set weights and threshold; it has not been validated against listeners. I have not listened to any of the output.
- A phrase's rhythm chip is the union of its gestures' tags, so it can read "dotted + syncopated + rests + late entry"; accurate but wordy.
- Contour is a hard class filter per intention, so some intentions are unreachable; the seeded sampler compensates by trying up to twice as many.
- Strategies are 11 grammar compositions chosen to span melodic and harmonic ideas; more can be added as data in `STRATEGIES`. None is a stored phrase.
- A phrase still ends on one target. Chained targets and phrases longer than 1½ bars are not generated.
- Exploration runs on the main thread (about a second).
- `generatePhrase` is unchanged in behaviour and still available; exploration calls it per intention.
