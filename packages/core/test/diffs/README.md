# Recorded diffs

Real `git diff` output used by the diff parser tests. Treat them as data:
edit by regenerating from a scratch repository, not by hand.

- `js-add-axios.diff` - adds `axios`, bumps `lodash`, drops the `vitest` dev
  dependency, updates `pnpm-lock.yaml` and imports axios in `src/index.js`.
  Also covers a quoted UTF-8 path, a deleted file, a binary file, a rename
  with spaces and a missing trailing newline.
