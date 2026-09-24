# GhostDeps fixtures

Representative test repositories. Every adapter's tests and the shared
contract tests run against these. Fixtures are excluded from lint/format.

## Layout

```text
fixtures/
  js/         JavaScript/TypeScript projects (npm, pnpm, yarn, bun variants)
  python/     Python projects (pip, poetry, uv, pipenv variants)
  rust/       Cargo projects (single crate, workspace)
  go/         Go module projects (single module, multi-module)
  polyglot/   Repositories mixing ecosystems (frontend TS + api Python + agent Rust)
  monorepo/   Workspace/monorepo layouts per ecosystem
  hostile/    Attacker-controlled inputs (see docs/security-model.md)
```

## Conventions

- One directory per scenario, named for what it tests: `js/basic-unused`,
  `js/native-replaceable-axios`, `python/uv-workspace`.
- Every fixture carries `expected.json`: the findings a correct analysis must
  produce (or explicitly must not produce), so tests assert behaviour, not snapshots.
  Adapters may add machine-checkable blocks consumed by their own suites -
  the JS/TS adapter asserts optional `detection` (confidence range, project
  roots) and `dependencies` (name/kind/constraint/declaredIn) blocks, while
  `findings`/`mustNotFind` are consumed as the engine stages land.
- Keep fixtures minimal. A fixture demonstrates exactly one scenario.
- Fixtures are data. Nothing in `fixtures/` is ever installed, built, or executed.
- Hostile fixtures document the attack they carry in their own README.
