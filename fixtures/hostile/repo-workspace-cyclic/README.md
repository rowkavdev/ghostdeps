# repo-workspace-cyclic

**Attacks:** pnpm workspace where package a depends on b and b depends on a. Graph construction must terminate and report the cycle, not hang or recurse forever.

**Expected:**

- **parse.mustNotCrash**: Cycles must not hang graph construction.
- **limitations.includes** "cycle": A cyclic workspace graph should be surfaced, not silently truncated.
