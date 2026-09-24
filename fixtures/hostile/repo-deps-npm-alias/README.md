# repo-deps-npm-alias

**Attacks:** npm alias: "my-alias": "npm:real-package@^1.0.0". Code imports 'my-alias'; the real package is 'real-package'. Usage and identity must resolve through the alias.

**Expected:**

- **unused.excludes** (my-alias): Imported under the alias name; matching import to declared dependency requires alias resolution.
