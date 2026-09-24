# archive-entry-flood

**Attacks:** Hundreds of tiny entries (kept small on disk; tests re-run with a low maxEntries ceiling). Entry-count ceilings stop metadata-flood disk exhaustion.

**Expected:** extraction is rejected with `TOO_MANY_ENTRIES` and nothing is left on disk.

Regenerate with `node fixtures/hostile/generate.mjs`.
