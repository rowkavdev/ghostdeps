# archive-clean-control

**Attacks:** Nothing. Control: a valid codeload-shaped archive (pax global header, long pax path, UTF-8 names, internal symlink) MUST extract cleanly. Guards against false positives in the validator.

**Expected:** extraction succeeds (4 files, 1 symlink).

Regenerate with `node fixtures/hostile/generate.mjs`.
