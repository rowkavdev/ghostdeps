# archive-total-size-bomb

**Attacks:** Many files each under the per-file ceiling, together over the total-bytes ceiling (run with low limits). Aggregate ceilings stop zip-bomb style exhaustion.

**Expected:** extraction is rejected with `TOTAL_SIZE_EXCEEDED` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
