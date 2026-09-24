# repo-symlink-tree

**Attacks:** A checkout containing symlinks: an internal link, a broken link, and a link cycle. Analysis over the tree must not follow links into loops or off the tree.

**POSIX-only.** The tree is committed with mode-120000 symlinks; on Windows
with the default `core.symlinks=false` they check out as small text files
and the fixture silently stops testing symlinks. Suites that cannot create
symlinks must skip it.

**Expected:**

- **parse.mustNotCrash**: Broken links and link loops in a valid checkout must not wedge the scanner.
