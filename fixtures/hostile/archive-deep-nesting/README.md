# archive-deep-nesting

**Attacks:** Path nested far past reasonable depth (run with a low maxDepth). Depth ceilings bound recursion in downstream consumers.

**Expected:** extraction is rejected with `TOO_DEEP` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
