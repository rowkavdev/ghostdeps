# archive-huge-declared-file

**Attacks:** One file declaring a 5 GiB body in its header. Must be rejected from the header alone, before any body bytes are read.

**Expected:** extraction is rejected with `FILE_TOO_LARGE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
