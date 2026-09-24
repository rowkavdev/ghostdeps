# archive-symlink-absolute

**Attacks:** Symlink entry pointing at an absolute target ('/etc/passwd'). Extraction must record it as metadata and never materialise it, so nothing can ever be followed out of the checkout.

**Expected:** extraction succeeds (undefined files, 1 symlink).

Regenerate with `node fixtures/hostile/generate.mjs`.
