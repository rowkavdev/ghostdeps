# archive-traversal-backslash

**Attacks:** Backslash separators: '..\evil.txt'. Legal filename on Linux, traversal on Windows consumers of the tree. Validators must treat both separators as path boundaries.

**Expected:** extraction is rejected with `PATH_TRAVERSAL` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
