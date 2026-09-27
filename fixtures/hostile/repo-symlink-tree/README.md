# repo-symlink-tree

**Attacks:** A checkout containing symlinks: an internal link, a broken link, and a link cycle. Analysis over the tree must not follow links into loops or off the tree.

**POSIX-only.** None of the three links is committed - the test harness
creates them all at test time, because the Actions runner's action-download
staging follows symlinks while extracting the repo tarball: a committed
dangling link fails with "Could not find file" and a committed link cycle
with "Too many levels of symbolic links", killing every external consumer
of the ghostdeps action at Set up job. Suites that cannot create symlinks
must skip the fixture.

**Expected:**

- **parse.mustNotCrash**: Broken links and link loops in a valid checkout must not wedge the scanner.
