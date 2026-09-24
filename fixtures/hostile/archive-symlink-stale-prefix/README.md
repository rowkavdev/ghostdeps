# archive-symlink-stale-prefix

**Attacks:** A link target's meaning changes as later links land: L points at x/y/z, then x becomes a link to '.', then M -> L/../../.. climbs out of the root when L is resolved against the new x. This escaped the second, creation-time-resolution extractor (independent-review re-review PoC on PR #81); recording links as metadata removes resolution entirely.

**Expected:** extraction succeeds (undefined files, 3 symlink).

Regenerate with `node fixtures/hostile/generate.mjs`.
