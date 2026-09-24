# archive-pax-path-override

**Attacks:** Innocent ustar name, hostile pax 'path' override ('../evil.txt'). Extractors that validate the ustar name but write the pax name get slipped.

**Expected:** extraction is rejected with `PATH_TRAVERSAL` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
