# archive-malformed-v7-magic

**Attacks:** Pre-ustar (v7) header with no magic. Strict parsers reject formats they do not implement instead of guessing.

**Expected:** extraction is rejected with `MALFORMED_ARCHIVE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
