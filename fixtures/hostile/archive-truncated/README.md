# archive-truncated

**Attacks:** Archive cut off mid-file (gzip stream severed at 50%). Extraction must fail loudly, never emit a partial checkout that looks valid.

**Expected:** extraction is rejected with `TRUNCATED_ARCHIVE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
