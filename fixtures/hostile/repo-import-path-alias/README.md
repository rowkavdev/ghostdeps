# repo-import-path-alias

**Attacks:** tsconfig paths alias @app/* -> src/*. Imports of '@app/util' must resolve to local files, not to a phantom dependency named '@app'.

**Expected:**

- **dependencies.excludes** (@app): @app is a path alias for local source, not a package.
- **unused.excludes** (left-pad): Actually imported.
