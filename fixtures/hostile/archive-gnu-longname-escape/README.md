# archive-gnu-longname-escape

**Attacks:** GNU '@LongLink' name extension carrying a traversal path. Validators must validate the *effective* name, not the truncated ustar one.

**Expected:** extraction is rejected with `PATH_TRAVERSAL` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
