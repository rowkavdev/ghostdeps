# repo-deps-file-link

**Attacks:** Local protocol dependencies: file:, link: and portal:. These point at paths, not packages; analysis must not invent registry facts for them.

**Expected:**

- **dependencies.includes** (shared): Declared and used.
- **limitations.includes** "file:": Local path deps have no registry metadata.
