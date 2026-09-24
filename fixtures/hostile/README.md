# fixtures/hostile

Attacker-controlled inputs, per docs/security-model.md rule 7: traversal
archives, hostile symlinks, giant files, malformed manifests and
Unicode tricks are first-class tests here. Fixtures are data - nothing in
this tree is ever installed, built, or executed.

## Archive attack classes (`archive-*`)

Each directory is one attack class against the inert extraction helper
(`packages/core/src/checkout`, issue #8):

- `archive.tar.gz` - the hostile codeload-shaped archive
- `expected.json` - the contract: rejection code or clean-extract counts,
  plus any extraction limits the scenario needs
- `README.md` - what it attacks and why it matters

Regenerate all archives after changing the generator:

```bash
node fixtures/hostile/generate.mjs
```

`packages/core/src/checkout/hostile-fixtures.test.ts` runs every
`archive-*` fixture in CI. `archive-clean-control` is the control case: a
valid archive that must always extract, guarding against a validator that
rejects everything.

Symlink entries are never rejected and never materialised: extraction
records them as metadata (`summary.links`) and the harness asserts no
symlink exists on disk for every extract case (security-model rule 2).
The symlink fixtures - absolute target, relative escape, loop,
shallow-target escape and stale-prefix re-meaning - pin that contract,
including both escapes the independent review reproduced on PR #81.

Current classes: path traversal (dots, nested, backslash), absolute paths
(POSIX, Windows drive, UNC), pax path override, GNU longname escape,
symlink absolute/relative escape, symlink loop, symlink shallow-target
escape, symlink stale-prefix re-meaning, hardlink to missing
target, duplicate paths, device node, fifo, sparse file, huge declared
file, entry flood, total-size bomb, deep nesting, corrupt checksum, v7
magic, base-256 size, truncation, NFKC Unicode folding, invalid UTF-8
names, case and NFC normalisation collisions - plus the clean control.

## Parser-hostile repository fixtures (`repo-*`)

Planned next under issue #22: malformed manifests, package.json with no
JS source, lockfile mismatches, dynamic/conditional/aliased imports,
git/path dependencies, cyclic workspaces, weird encodings, and
import-name != package-name cases. Each carries `expected.json` describing
what a correct analysis must (or must not) report, so adapter lanes can
wire them into their suites.
