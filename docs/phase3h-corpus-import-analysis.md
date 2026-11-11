# Phase 3H.1 + 3H.2: corpus import and musical analysis

Status: importer and analyzer implemented, tested and run on the real first corpus. Not yet done: 3H.3 (explorer UI), 3H.4 (generator comparison), 3H.5 (corpus-informed generation), 3H.6 (listening evaluation). Nothing here has been committed or pushed.

## 1. What the archive actually contained

`data/corpus/incoming/` held **`nugget_folk_musicxml_builder.zip`** (6 KB), not `nugget_folk_starter.zip`. It contained a Python downloader/converter, a Windows launcher and a README, and **no scores**. I read the script (it downloads the public Nottingham ABC files from `jukedeck/nottingham-dataset` and converts them with music21), then ran it in a virtualenv outside the repository, as its README suggests (Python 3.15, music21 10.5.2). It produced `nugget_folk_starter.zip` (59 entries, 24 tunes), now in `data/corpus/incoming/`.

## 2. Import results (measured)

| | |
|---|---|
| Tunes converted by music21 | 24 (0 conversion failures) |
| **Imported as usable compositions** | **23** |
| Refused | 1: *Verdi's Waltz* is written as two-note chords throughout (`[C2E2]`), so it is not monophonic. It is refused with the reason `chord-note`; its top voice is not silently kept. |
| Valid MusicIR projection | 23 / 23 |
| Notes imported | 2,307 (22 tunes match the original ABC note for note) |
| Measures | 531 across the 24 files; every file has chord symbols |
| Pickup (anacrusis) bars | 16 tunes |
| Repeat signs / volta endings | present in 19 / 3 of the 24 files (kept in the record; the score is analysed once as written, not expanded) |
| Ties / tuplets | ties: 4 tunes (joined into one sounding note, parts kept); tuplets: 4 tunes (kept as exact fractions, e.g. 1/12) |
| Grace notes, ornaments, slurs, fermatas | none in this corpus (supported and tested, but not exercised by real data) |
| Meter / key changes | Black Boy changes meter (2/4 → 6/8) and key; Bonny Green Garters changes key |

### Conversion problems found (none silently corrected)

1. **Converter padding rests (important).** Of the 50 rests in the converted MusicXML, only **2 are written in the original ABC** (one tune). music21 pads incomplete measures at strain ends and pickups with rests (43 of the 50 end a measure after notes). An importer that only reads the XML would conclude real folk music has rests; it does not. The importer now aligns the original ABC's notes and rests with the XML's (earliest-match longest common subsequence), flags the surplus rests as `suspect: converter-padding`, reports them, and the analysis **excludes them from silence statistics and phrase evidence** (the time they occupy is kept).
2. **A lost note.** In *Applejack's Reel* the final note of the first strain (`D::`) is replaced by a half rest in the XML (113 notes in the ABC, 112 in the XML). Reported as `note-lost-in-conversion`. It cannot be recovered; that tune's strain-ending data is wrong.
3. **Fake attribution.** The XML credits the composer as "Music21" in every file. It is recorded as a converter artefact; attribution comes from the manifest and catalog.
4. **Untrustworthy durations are not an issue here:** no measure failed to add up, and no written note type contradicted its duration (both are checked and reported when they happen).
5. **Chords:** five kinds occur (major, minor, dominant, augmented, augmented-seventh) plus slash chords in 7 tunes. The existing chord parser has no augmented-seventh or slash chords, so the importer has its own table. The MusicIR chord is projected without its bass note (the IR verifier requires symbol = root + quality); the bass stays in the corpus record.
6. **Non-chord tones.** The IR verifier requires a note outside the chord to carry a melodic role. The importer labels such notes `non-chord-tone` (observed, unclassified); the analysis decides passing, neighbour and so on.

What MusicIR cannot hold from a piece (repeat signs, meter changes after the first, key, ties as parts, tuplet brackets, grace notes, marks) is listed per piece in `import-report.json` under `irLoss`; the notation-faithful `CorpusPiece` keeps it.

## 3. What was built

`packages/musical-engine/src/corpus/` (pure TypeScript, no new dependencies; exposed as `corpus` from the engine):

- `xml.ts` strict XML reader for untrusted input: DOCTYPE with an internal subset (entity bombs, external entities) refused, only the five predefined entities, bounded size, depth and element count.
- `zip.ts` read-only ZIP reader: entry count, size, compression ratio, inflated size counted while streaming, CRC-32 verified, unsafe names (`..`, absolute, drive letters) refused, encrypted/ZIP64/unknown methods reported.
- `musicxml.ts` score-partwise → `CorpusPiece` plus `ImportReport` (issues, unsupported-element counts, counts, IR loss). Exact rational time from `<duration>`; cross-checks type/dots/tuplet against it; pickups; meter and key changes; repeats and endings; ties; tuplets; grace notes; marks; chord symbols.
- `fidelity.ts` the cross-check against the original ABC described above.
- `toIR.ts` MusicIR projection, validated before it is returned.
- `archive.ts` manifest-driven import. The manifest is untrusted too (unsafe ids, escaping paths, duplicates). Failures are per piece; licence, repository, catalog and the original notation are preserved on every piece.
- `analysis/` rhythm, melody, phrases, harmony, aggregate. One view (`MelodyLine`) is built from a corpus piece or from any MusicIR, so real and generated music are measured by identical code. It carries no tonal assumption: key, chords and tuning system are optional.
- `scripts/corpus.mjs` (`npm run corpus -- <zip>`) writes `data/corpus/normalized/<corpus-id>/` (pieces, IR, analysis, aggregate, import report, index). It refuses to write outside `data/corpus/`.

Corpus records are separate from user experiments: they live only under `data/corpus/`, in their own record format.

## 4. What the analysis measures

- **Rhythm** (not a single density): attacks per bar and per beat; streaks of notes with no rest; runs of short notes (≤ half a beat); duration, rest and sustain distributions; metric placement by a weight hierarchy; syncopation (onset weight below the strongest position crossed); repeated rhythmic cells and repeated bars; per-beat density curve; per-bar beat patterns; asymmetric groupings (3+3+2 against 2+2+2+2).
- **Melody:** interval classes (repeat 0, step ≤ 2, skip ≤ 4, leap ≥ 5 semitones, fractional semitones allowed); direction runs and changes; contour class and shape; repeated interval motifs with and without rhythm; transposed sequences; registral trend; gap-fill; scale-degree statistics only when a key exists and tuning is 12-tone.
- **Melody with rhythm:** interval size after long vs short notes; leaps by arrival strength; duration after leaps vs steps; **burst-then-hold** (runs of ≥ 3 short notes and what follows).
- **Phrases:** boundary hypotheses scored by a noisy-OR of eight named evidence kinds (written structure, rest, long note, LBDM, bar/hypermeter position, activity change, recurrence, cadence). Every candidate lists its evidence; three levels (figure ≥ 1 bar, **phrase ≥ 2 bars**, period ≥ 4 bars) are kept side by side because the segmentation is not unique. Each phrase has a profile (activity shape, contour, range, opening, ending, rhythm, intervals); relations between phrases (exact repeat, repeat with modified ending, same rhythm new pitches, ...).
- **Harmony:** only against written chord symbols; roles as semitones above the root; otherwise `present: false`, nothing inferred.

## 5. Notable patterns (23 tunes, 2,307 notes)

Reported as measured; this is a small, stylistically narrow, machine-converted sample.

- **Rhythm is continuous, not sparse.** 65.7% of notes are eighths, 21% quarters; short notes (≤ half a beat) are 70% of notes. 59% of notes sit in runs of four or more short notes and **40% in runs of eight or more** (longest run: 34 notes). "Consecutive eighths" are normal in this repertoire.
- **Silence is almost absent as written notation:** 2 written rests in 23 tunes. This corpus cannot teach how silence is used; sustained notes are the only "rest-like" device it contains.
- **Runs are punctuated, not avoided.** 174 bursts of ≥ 3 short notes: **64%** end on a held note (≥ 1 beat) or a written rest. 44% of phrases end on a note at least 1.5× the phrase's mean length and at least a beat; the median phrase-final note is one beat.
- **Groupings:** 64% of bars have an uneven number of attacks across beats; the commonest bar patterns are `3-3` (jigs), `2-2-2-2`, `1-1-1`. 65% of bars repeat an earlier bar's rhythm. Syncopation is rare (1.7% of notes).
- **Melody moves by step:** repeats 9%, steps 60%, skips (3–4 semitones) 20%, leaps (≥ 5) 11%; mean interval 2.5 semitones. After a leap the line reverses 53% of the time. Leaps arrive on strong positions (weight ≥ 3) in 64% of cases. Sequences (transposed repeats of a unit) average 2.6 per tune.
- **Phrases:** 189 phrase hypotheses, median 2 bars and 11 notes. Phrase contours: arch 52%, valley 23%, ascending 13%, descending 11%. Phrases open on a downbeat 74% of the time. 85% of phrase-to-phrase relations (within four phrases) are "contrast"; repeats with a modified ending are rare (7), exact repeats rarer (5).
- **Harmony:** chord-tone share rises with metric strength: strong 88%, beat 63%, weak 58%. Non-chord tones are mostly passing (329) and neighbour (154) tones; leap-approached ones number 72. 68% of chord changes fall on a downbeat.

Phrase boundaries were checked against the one thing the score states outright: **21 of 22 notated repeat ends were recovered** as phrase boundaries (the missed one lies within two bars of a stronger written boundary in a tune with one-bar repeated sections, and appears at the figure level).

## 6. Verification

- 85 new corpus tests (safety 13, import 21, analysis 26, archive 7, fidelity 9, real corpus 9); expectations were derived by hand from tiny scores, and the real-corpus test pins the measured numbers and skips when the git-ignored archive is absent.
- Four deliberate breakages (CRC check off, internal DOCTYPE allowed, padding rests counted as silence, measure-length check off) were each caught.
- Independent check: imported note counts against the original ABC (22 of 23 exact).
- `npm run verify` result is recorded at the end of this file.

## 7. Limits, stated plainly

- The phrase segmentation is a heuristic whose weights and levels I set; the written-repeat recall is the only external reference. It is not validated against annotated phrases or listeners. Its 2-bar minimum was chosen after seeing 1-bar fragments in these dance tunes, so it embeds an expectation about this repertoire.
- All 24 tunes are machine-converted Nottingham dance tunes (jigs, reels, hornpipes, waltzes, morris, Playford). They cannot represent folk music in general, still less other traditions. I have not listened to any of it.
- Statistics are of the score as written once (repeats not expanded); a performance would repeat sections.
- Whole-piece contour is always "arch" for such long pieces and is not informative; phrase-level contour is.
- Only ABC originals can be cross-checked today. The padding finding is specific to this converter.
- The corpus is GPL-3.0 and research-only here. `data/corpus/` is git-ignored except its README so the melodies cannot be pushed by accident; tell me if you want them tracked.
- Tuning: pitches are stored as (possibly fractional) MIDI with a tuning-system field, so microtonal sources can be represented and are refused by the 12-tone MusicIR projection with a reason. No non-12-tone corpus has been tried.

## 8. `npm run verify`

Run on the working tree after the last change: exit 0. Engine suite 31 files, 800 tests (715 existing + 85 corpus), typecheck, engine build and the Next.js build all pass; Phase 1-3 tests are unchanged and green. The machine has about 1 GB free memory, so tsc/vitest occasionally crash with an out-of-memory error and were simply rerun; no result above comes from a crashed run.

## 9. Stage 3H.3: the Corpus Analysis view (`/corpus`)

Added to the Musical Lab (linked from the Lab and the Phrase Constructor). It reads the imported corpus through `GET /api/corpus` (catalogue, pooled statistics) and `GET /api/corpus?piece=<id>` (notation record, MusicIR, analysis). Because the corpus is GPL-3.0 research data, the route serves it **only to requests whose Host is this machine** (403 otherwise), reads it from `data/corpus/normalized/` at request time (it is never in the app bundle or the repository), validates piece ids against the catalogue, and the page shows the licence notice at all times. With no corpus imported, the page says so and how to import one.

The page lets you: browse and filter the compositions; see the symbolic timeline (chords, bar numbers, repeat signs and endings, phrase units, a piano-roll with notes coloured by length class and edged by metric strength, written rests, suspected padding rests drawn differently, an attacks-per-beat lane); hear the piece through the existing engine renderer and `LabPlayer` (tempo slider, playhead synchronised to the audio clock, sounding notes highlighted, click the timeline to seek to the exact position); read the segmentation as **periods, phrases or figures** and optionally show the weaker candidates; click any boundary to see its evidence; click a phrase for its contour, rhythm strip, activity shape, opening and ending; highlight where a repeated rhythmic cell, motif or sequence occurs; read the rhythm, melody, phrase, harmony and source/import tabs; and **compare two phrases** (pin one as A, select B, in the same piece or another) with a similarity per aspect, an overall figure and the relation between them. `comparePhraseProfiles` lives in the engine and is tested (4 tests).

Verified in headless Chrome with real clicks against a scratch server on another port: 46 checks (catalogue, licence notice, filters, 94 notes drawn for The Cat Walk, levels, boundary evidence, note inspector, phrase panel, pin and compare, highlights, all five tabs, padding rests and the lost note in Applejack's Reel, written rests in Julian's Jig, Play/Pause, a moving playhead, sounding-note highlights, click-to-seek within 5 ms of the exact frame, tempo change re-rendering, a meter-and-key-change tune, a 9/8 tune, and the Phase 2 Lab and Phrase Constructor still loading) with no console errors. The API's guards were also checked directly (non-local Host, unknown ids and path-traversal ids). `npm run verify` after this stage: 31 test files, 804 tests, typecheck and build, with no build warnings.

Limits of this view: it shows one corpus at a time; the compare panel compares profiles (rhythm, intervals, contour, activity, ending, register), not the full notes; "play a phrase" plays the whole piece from the phrase's start (the player loops the piece); I have not listened to the audio, only verified that it renders, plays, and moves in step with the display.

## Follow-up: review fixes

- **Analysis-only pieces.** `index.json` now carries `ir: boolean` per piece. A piece without a MusicIR projection opens in the Explorer for analysis; Play, Loop and Play phrase are disabled and a banner says playback is unavailable (with the import's `irLoss` reasons).
- **Corpus access.** `corpusAccess()` (lib/corpusStore.ts): off in production unless `NUGGET_ALLOW_CORPUS=1`; refuses forwarded requests; Host/Origin must be loopback; dev and start scripts bind to 127.0.0.1.
- **Playback.** One pass by default (stops at the end), a Loop toggle, a real "Play phrase" that plays only that phrase (once, or repeated with Loop), and "Whole piece" to leave the phrase region. Changing piece pauses audio and marks the still-shown piece as stale until the new one arrives.
- **Phrase scores** are called *boundary strength* (heuristic, uncalibrated). They are noisy-OR combinations of boundary evidence, not probabilities, and have not been checked against human-annotated phrases.
