# archive-base256-size

**Attacks:** GNU base-256 binary size field. Parsers that misread the encoding compute wrong body offsets and desynchronise.

**Expected:** extraction is rejected with `MALFORMED_ARCHIVE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
