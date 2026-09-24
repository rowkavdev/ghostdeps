# archive-symlink-loop

**Attacks:** Symlink loop (a -> b, b -> a) plus an entry under the loop. A materialising extractor needs loop-capped resolution; a recording extractor is immune by construction.

**Expected:** extraction succeeds (1 files, 2 symlink).

Regenerate with `node fixtures/hostile/generate.mjs`.
