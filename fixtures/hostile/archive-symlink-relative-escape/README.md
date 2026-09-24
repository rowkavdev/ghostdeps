# archive-symlink-relative-escape

**Attacks:** Symlink whose relative target climbs out of the root ('../../../etc').

**Expected:** extraction is rejected with `LINK_ESCAPE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
