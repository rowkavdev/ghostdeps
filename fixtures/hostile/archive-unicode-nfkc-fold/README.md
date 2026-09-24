# archive-unicode-nfkc-fold

**Attacks:** Filename containing U+FF0F FULLWIDTH SOLIDUS, which NFKC-folds to '/'. Validators that normalise after checking (or consumers that fold) turn it into traversal.

**Expected:** extraction is rejected with `UNICODE_PATH_FOLDING` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
