# repo-monorepo-nested

**Attacks:** Nested projects: a sub-package with its own package.json, plus a vendored third-party tree with its own package.json that must be excluded as vendor/generated.

**Expected:**

- **projects.includes**: Workspace members are separate projects (monorepo-native results).
- **projects.excludes**: Vendor/generated directories are skipped (pipeline step 1).
