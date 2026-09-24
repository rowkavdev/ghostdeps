# archive-symlink-relative-escape

**Attacks:** Symlink whose relative target climbs out of the root ('../../../etc'). Recorded, never created - the escape only exists if links are materialised.

**Expected:** extraction succeeds (undefined files, 1 symlink).

Regenerate with `node fixtures/hostile/generate.mjs`.
