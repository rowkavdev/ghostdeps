# archive-duplicate-path

**Attacks:** Two entries for the same path. Classic parser-differential: validator checks entry one, extractor writes entry two.

**Expected:** extraction is rejected with `DUPLICATE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
