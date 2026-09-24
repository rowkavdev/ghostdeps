# archive-case-collision

**Attacks:** Two entries differing only by case ('A.txt' vs 'a.txt'). On case-insensitive filesystems the second overwrites the first; validators must be at least as strict as the most lenient consumer FS.

**Expected:** extraction is rejected with `DUPLICATE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
