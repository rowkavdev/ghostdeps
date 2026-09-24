# archive-symlink-shallow-target-escape

**Attacks:** A link sitting deeper than its target (a/b/c/L points at the root) lets a later target 'L/../..' climb out of the root when '..' is applied lexically instead of physically. This bypassed the first version of the extractor (independent-review PoC on PR #81).

**Expected:** extraction is rejected with `LINK_ESCAPE` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
