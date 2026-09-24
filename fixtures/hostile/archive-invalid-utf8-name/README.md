# archive-invalid-utf8-name

**Attacks:** Entry name with lone 0xFF bytes (invalid UTF-8). Lenient decoders smuggle names past validators via replacement characters.

**Expected:** extraction is rejected with `INVALID_ENCODING` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
