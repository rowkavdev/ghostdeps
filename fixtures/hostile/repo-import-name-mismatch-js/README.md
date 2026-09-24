# repo-import-name-mismatch-js

**Attacks:** Import specifier != package name: scoped packages, subpath imports ('lodash/map' comes from package 'lodash'), and package.json exports maps hiding real paths.

**Expected:**

- **unused.excludes** (lodash): 'lodash/map' is usage of package lodash.
- **unused.excludes** (@scope/toolkit): Subpath imports still count as package usage.
