# archive-traversal-nested

**Attacks:** Traversal hidden inside a plausible tree path: 'repo/src/../../../etc/cron.d/ghost'. Naive join-and-write extractors write outside the root.

**Expected:** extraction is rejected with `PATH_TRAVERSAL` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
