# Corpus data (research only)

This folder holds imported corpora and their generated analyses. Everything here except this file is git-ignored.

- `incoming/` the archives as received (for example `nugget_folk_starter.zip`).
- `normalized/<corpus-id>/` output of `node scripts/corpus.mjs <archive.zip>` (pieces, MusicIR, analyses, aggregate, import report).

**Licence:** the first corpus is the Nottingham Folk Music Database (https://github.com/jukedeck/nottingham-dataset), distributed under GPL-3.0. Individual tunes and transcriptions may carry further rights. It is for development and analysis only: keep it out of commercial releases, and do not reproduce its melodies in generated output, until its licence and intended uses have been reviewed.

Regenerate with `npm run corpus -- data/corpus/incoming/nugget_folk_starter.zip` after `npm run build:engine`.
