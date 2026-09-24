# repo-lockfile-mismatch

**Attacks:** Manifest and lockfile disagree: left-pad declared but absent from package-lock.json; stray-package locked but never declared. Graph facts must flag the skew instead of picking a silent winner.

**Expected:**

- **parse.mustNotCrash**: Skewed manifests/lockfiles are normal in real repos.
- **limitations.includes** "lockfile": The graph cannot be authoritative when manifest and lockfile disagree.
