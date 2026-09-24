# archive-symlink-loop

**Attacks:** Symlink loop (a -> b, b -> a) plus a write through the loop. Resolvers must be loop-capped, not recursive-forever.

**Expected:** extraction is rejected with `LINK_LOOP` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
