# repo-manifest-bom

**Attacks:** package.json starting with a UTF-8 BOM. Strict JSON.parse rejects it; a manifest parser must strip the BOM or report reduced confidence.

**Expected:**

- **parse.mustNotCrash**: BOM-prefixed manifests are common in the wild.
- **dependencies.includes** (left-pad): BOM must not make a valid manifest unreadable.
