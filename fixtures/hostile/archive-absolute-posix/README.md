# archive-absolute-posix

**Attacks:** Absolute POSIX path '/etc/passwd'. Extractors that honour it overwrite system files.

**Expected:** extraction is rejected with `ABSOLUTE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
