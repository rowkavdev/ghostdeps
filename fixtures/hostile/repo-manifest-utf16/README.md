# repo-manifest-utf16

**Attacks:** package.json encoded UTF-16 LE with BOM. Not valid JSON by spec; parser must not crash and must not silently read garbage.

**Expected:**

- **parse.mustNotCrash**: Encoding tricks are parser hardening cases (security model rule 3).
- **limitations.includes** "package.json": If the manifest cannot be decoded, say so.
