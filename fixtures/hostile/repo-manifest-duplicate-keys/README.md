# repo-manifest-duplicate-keys

**Attacks:** package.json with the same key twice ("dependencies" appears twice with different contents). JSON.parse silently keeps the last; the first set of deps must not vanish without a limitation note.

**Expected:**

- **parse.mustNotCrash**: Duplicate keys are legal-ish JSON in practice and must be handled deliberately.
- **limitations.includes** "duplicate": Silently dropping one dependencies block fabricates dependency facts.
