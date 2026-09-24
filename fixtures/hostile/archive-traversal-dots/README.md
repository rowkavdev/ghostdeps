# archive-traversal-dots

**Attacks:** Classic zip-slip: entries whose names contain '..' segments, escaping the extraction root on naive extractors.

**Expected:** extraction is rejected with `PATH_TRAVERSAL` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
