# Corpus data (research only)

This folder holds imported corpora and their generated analyses. Everything here except this file is git-ignored.

- `incoming/` the archives as received (for example `nugget_folk_starter.zip`).
- `normalized/<corpus-id>/` output of `node scripts/corpus.mjs <archive.zip>` (pieces, MusicIR, analyses, aggregate, import report).

**Licence:** the first corpus is the Nottingham Folk Music Database (https://github.com/jukedeck/nottingham-dataset), distributed under GPL-3.0. Individual tunes and transcriptions may carry further rights. It is for development and analysis only: keep it out of commercial releases, and do not reproduce its melodies in generated output, until its licence and intended uses have been reviewed.

Regenerate with `npm run corpus -- data/corpus/incoming/nugget_folk_starter.zip` after `npm run build:engine`.

## Access to the corpus in the app

The corpus is research-only (GPL-3.0). The app reads it from disk through `/api/corpus`, with these limits:

- **Production builds do not serve it** unless `NUGGET_ALLOW_CORPUS=1` is set explicitly. A deployed or commercial copy has no corpus endpoint by default.
- **Requests that came through a proxy or tunnel are refused** (forwarding headers), and the `Host`/`Origin` must name this machine. These are a second layer only, because those headers are supplied by the client.
- **The real boundary is the network binding:** `npm run dev` and `npm start` listen on `127.0.0.1` only. Do not change that, and do not run the corpus-enabled server on a reachable interface.
- Pieces without a MusicIR projection (for example microtonal scores) still open for analysis; playback is shown as unavailable for them.
