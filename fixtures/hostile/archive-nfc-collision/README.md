# archive-nfc-collision

**Attacks:** Same filename in NFC and NFD Unicode normalisation. Normalising filesystems (APFS) see one file; byte-wise validators see two and miss the collision.

**Expected:** extraction is rejected with `DUPLICATE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
