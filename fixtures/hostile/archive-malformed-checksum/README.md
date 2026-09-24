# archive-malformed-checksum

**Attacks:** Header with a corrupted checksum. Strict framing checks stop bit-flipped archives from being interpreted.

**Expected:** extraction is rejected with `MALFORMED_ARCHIVE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
