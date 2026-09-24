# repo-no-js-source

**Attacks:** package.json with real dependencies but zero JS/TS source files (docs-only repo). Detection must stay below threshold: package.json present but no meaningful JS means no JS analysis (architecture pipeline step 2).

**Expected:**

- **detection.excludes**: No meaningful JS/TS source; the adapter must not fire on a manifest alone.
