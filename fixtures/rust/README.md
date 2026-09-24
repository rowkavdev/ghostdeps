# fixtures/rust

Cargo scenarios for the rust adapter (`packages/adapters/rust`). See
fixtures/README.md for conventions. Nothing here is built; the lockfiles are
hand-written in Cargo's v4 format.

| Scenario                 | What it tests                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `single-crate`           | runtime/dev/build tables, a renamed dependency, one unused dependency                |
| `workspace`              | virtual root, glob members + exclude, `workspace = true` inheritance, path deps      |
| `feature-conditional`    | optional deps via `dep:`, `dep/feature`, implicit features, weak `?/`; target tables |
| `workspace-auto-members` | path deps of members outside `members` join the workspace (#226), transitively       |
| `malformed-manifest`     | invalid TOML degrades detection instead of failing                                   |

`expected.json` blocks asserted by the adapter's fixture test: `detection`,
`dependencies`, `conditions` (feature/target evidence, matched by kind and
statement) and `detectionEvidence` (evidence kinds that must appear).
`findings`/`mustNotFind` are consumed as the engine stages land.
