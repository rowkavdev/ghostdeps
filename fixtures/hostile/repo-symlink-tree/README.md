# repo-symlink-tree

**Attacks:** A checkout containing symlinks: an internal link, a broken link, and a link cycle. Analysis over the tree must not follow links into loops or off the tree.

**POSIX-only.** The internal link and the link cycle are committed; the
broken link (`src/broken.js -> does-not-exist.js`) is NOT committed - the
test harness creates it at test time, because a committed dangling symlink
breaks the Actions runner's action-download staging for external consumers
of the ghostdeps action. On Windows with the default `core.symlinks=false`
the committed links check out as small text files and the fixture silently
stops testing symlinks. Suites that cannot create symlinks must skip it.

**Expected:**

- **parse.mustNotCrash**: Broken links and link loops in a valid checkout must not wedge the scanner.
