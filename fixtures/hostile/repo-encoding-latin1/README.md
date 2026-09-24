# repo-encoding-latin1

**Attacks:** Python source with latin-1 bytes and a coding cookie, plus a UTF-8 file containing invalid byte sequences. Usage scanners must not crash on undecodable source.

**Expected:**

- **parse.mustNotCrash**: Encoding tricks are parser hardening cases.
- **unused.excludes** (requests): Genuinely imported; encoding must not hide usage.
