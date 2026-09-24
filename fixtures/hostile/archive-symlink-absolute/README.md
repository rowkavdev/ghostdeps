# archive-symlink-absolute

**Attacks:** Symlink entry pointing at an absolute target ('/etc'). A following consumer that reads through the link escapes the checkout.

**Expected:** extraction is rejected with `ABSOLUTE_PATH` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
