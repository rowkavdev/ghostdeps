# archive-device-node

**Attacks:** Block/character device entries (typeflags 3/4). Extracting device nodes as root is a classic container-escape primitive.

**Expected:** extraction is rejected with `UNSUPPORTED_ENTRY` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
