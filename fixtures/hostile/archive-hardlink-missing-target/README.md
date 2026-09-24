# archive-hardlink-missing-target

**Attacks:** Hardlink to a path never extracted as a regular file. On-disk link creation must not reach outside the checkout.

**Expected:** extraction is rejected with `LINK_TARGET_MISSING` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
