# Slice-2 evidence fixtures

Four tiny, canonical npm v3 snapshots for the **dry-run** `previewNpmRemoval` API. A synthetic adapter in `packages/core/src/engine/fix-evidence.test.ts` keeps the assertions about core's policy and state binding, not JS parser coverage. `eligible` is a valid leaf with no use. `stale-source` changes only an unrelated source byte: it must generate a different key rather than reusing the previous proposal. `declined` adds an `.npmrc` to make the edit unsafe; scan analysis must still run and the original bytes must stay put. `usage-revalidated` has the same manifest/lockfile bytes as eligible, but a second adapter run reports an observed use: the prior preview is not authority to edit.

No fixture represents an actual GitHub PR head, comment, permission, installation token or live ref. Those gates are outside slice 2 and must be tested in the later App/runner slices. This directory does not authorize dispatch or commit.
