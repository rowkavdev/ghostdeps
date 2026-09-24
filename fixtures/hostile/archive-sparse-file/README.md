# archive-sparse-file

**Attacks:** GNU sparse file (typeflag S): gigabytes of apparent content in kilobytes of archive. A disk-fill bomb against naive extractors.

**Expected:** extraction is rejected with `UNSUPPORTED_ENTRY` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
