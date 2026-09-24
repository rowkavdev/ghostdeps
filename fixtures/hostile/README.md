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

Small repository trees attacking the *parsers and detectors* rather than
the extractor: malformed manifests (broken JSON, duplicate keys, BOM,
UTF-16), package.json with no JS source, lockfile/manifest skew, dynamic
and conditional imports, tsconfig path aliases, git/file/link/npm-alias
dependencies, cyclic workspaces, nested monorepos with vendored trees,
symlinked trees, and import-name != package-name (JS subpaths, Python
PIL/bs4/yaml).

Each directory is a scenario with `expected.json` describing what a
correct analysis must (or must not) report, using a small assertion
vocabulary:

- `parse.mustNotCrash` - malformed input degrades confidence, never crashes
- `detection.excludes <ecosystem>` - adapter must stay below threshold
- `dependencies.includes/excludes <name>` - dependency model facts
- `unused.excludes <name>` - must never be reported unused
- `projects.includes/excludes <path>` - monorepo project discovery
- `limitations.includes "<text>"` - the analysis must say what it could not do
- `confidence.atMost <level>` - verdict confidence ceiling

Adapter lanes wire these into their test suites as their parsers land;
an expectation that cannot be checked yet is still the documented
contract.
