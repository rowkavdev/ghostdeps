# GhostDeps CLI

`ghostdeps` is the local interface to GhostDeps. It and the GitHub App are
delivery mechanisms over the same `@ghostdeps/core` analysis engine; there is
no separate CLI implementation of any analysis (ADR 0001, ADR 0002).

## Commands

| Command                          | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `ghostdeps scan [path]`          | Analyse a repository's dependencies (default: `.`)       |
| `ghostdeps inspect <pkg> [path]` | Inspect one dependency in depth                          |
| `ghostdeps graph <pkg> [path]`   | Show the transitive graph for one dependency             |
| `ghostdeps languages [path]`     | List detected languages and package managers             |
| `ghostdeps packages [path]`      | List direct dependencies                                 |
| `ghostdeps explain <pkg> [path]` | Explain the findings and recommendation for a dependency |

Shorthands: `ghostdeps <path>` means `ghostdeps scan <path>`, and
`ghostdeps --json` means `ghostdeps scan --json`.

`ghostdeps fix <pkg>` (patch generation) is planned for a later milestone and
is not in the router yet.

## Output

Human output follows the canonical formats in
[output-formats.md](output-formats.md).

`--json` is a global flag and emits the schema-versioned `AnalysisResult`
from `@ghostdeps/core` (`schemaVersion: 1`). Commands that are not
implemented yet still emit a schema-shaped empty result under `--json`, so
tooling can be built against the contract today.

Analysis is static and works fully offline; registry metadata (when wired
up) flows only through the core metadata service, never from the CLI.

## Exit codes

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 0    | success                                    |
| 1    | unexpected error                           |
| 2    | usage error (unknown command or arguments) |
| 3    | command not implemented yet                |

GhostDeps advises, it does not gate: findings never produce a non-zero exit
on an otherwise successful scan.

## Configuration

Configuration resolves from defaults plus command-line flags; flags always
win. No config file format exists yet. When one is agreed it will slot
between defaults and flags here, and this section will document it.

## Development

```bash
pnpm --filter @ghostdeps/cli build
node packages/cli/dist/main.js --help
```
