# repo-symlink-tree

**Attacks:** A checkout containing symlinks: an internal link, a broken link, and a link cycle. Analysis over the tree must not follow links into loops or off the tree.

**Expected:**

- **parse.mustNotCrash**: Broken links and link loops in a valid checkout must not wedge the scanner.
