# repo-import-dynamic-variable

**Attacks:** Dynamic import with a computed specifier: import(process.env.PLUGIN). Static analysis cannot know the target; the dependency must not be called unused, and the limitation must be named.

**Expected:**

- **limitations.includes** "dynamic import": Dynamic imports prevent complete analysis; say so (architecture: evidence or silence).
- **unused.excludes** (plugin-loader): A computed import can target anything; conservative design forbids an unused verdict.
