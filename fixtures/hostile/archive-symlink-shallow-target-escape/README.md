# archive-symlink-shallow-target-escape

**Attacks:** A link sitting deeper than its target (a/b/c/L points at the root) lets a later target 'L/../..' climb out of the root when '..' is applied lexically instead of physically. This escaped the first, materialising extractor (independent-review PoC on PR #81); with links recorded as metadata there is nothing to follow.

**Expected:** extraction succeeds (undefined files, 2 symlink).

Regenerate with `node fixtures/hostile/generate.mjs`.
