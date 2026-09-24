# fixtures/python

Python adapter scenarios. See fixtures/README.md for conventions.

Each scenario's `expected.json` is checked by `packages/adapters/python/src/fixtures.test.ts`:

- `detection`: confidence bounds, project roots and package managers.
- `dependencies`: direct dependencies (name, kind, and optionally constraint, declaredIn and declaredLine; `null` means no line is offered).
- `imports`: import path -> resolved distribution, per project root.
- `usage`: dependency -> the exact `file:line` usages findUsage reports.
- `graph`: lockfile graph shape, per project root.
- `findings`: the exact findings from analyseDirectory with the default policy. Each entry matches on `kind`, plus `rule`, `dependency`, a `minConfidence` floor and an `evidence` kind when given (run notes such as scan-incomplete have no rule). `[]` means no findings at all.
- `mustNotFind`: findings that must never appear, matched the same way.
- `policy`: `noFindingsFor` dependencies and `noRules` rules.

M2 Python does usage analysis only, so no fixture expects an `unused` finding.
