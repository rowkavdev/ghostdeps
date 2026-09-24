# archive-absolute-windows

**Attacks:** Windows absolute and drive-relative paths: 'C:\Windows\System32\drivers\etc\hosts'. A validator that only checks '/' misses these.

**Expected:** extraction is rejected with `ABSOLUTE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
