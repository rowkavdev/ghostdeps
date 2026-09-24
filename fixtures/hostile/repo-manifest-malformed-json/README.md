# repo-manifest-malformed-json

**Attacks:** package.json that is not valid JSON (trailing comma, unterminated string). The manifest parser must degrade to reduced confidence, never crash.

**Expected:**

- **parse.mustNotCrash**: Malformed input produces a finding of reduced confidence, not a crash (security model rule 3).
- **limitations.includes** "package.json": The manifest could not be parsed; dependency facts from it are missing.
- **confidence.atMost**: Unparseable manifest means declared dependencies are unknown.
