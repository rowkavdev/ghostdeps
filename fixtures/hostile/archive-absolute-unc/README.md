# archive-absolute-unc

**Attacks:** UNC path '//server/share/payload'. Windows treats it as a network absolute path.

**Expected:** extraction is rejected with `ABSOLUTE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
