# archive-fifo

**Attacks:** FIFO entry (typeflag 6). Special files must never be materialised from an archive.

**Expected:** extraction is rejected with `UNSUPPORTED_ENTRY` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
