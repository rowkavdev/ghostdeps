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
`ghostdeps --json` means `ghostdeps scan --json`. A bare first word counts
as a path only when it contains `/` or `.` or exists on disk; anything else
is reported as an unknown command with a suggestion. To scan a directory
that shares a name with a command, say `ghostdeps scan <dir>`.

`--` ends option parsing, so paths starting with `-` can be scanned:
`ghostdeps scan -- -strange-dir`.

`ghostdeps fix <pkg>` (patch generation) is planned for a later milestone and
is not in the router yet.

## Output

Human output follows the canonical formats in
[output-formats.md](output-formats.md).

`--json` is a global flag. On success it emits the schema-versioned
`AnalysisResult` from `@ghostdeps/core`, serialised by core's stable JSON
reporter (canonical ordering, escaping) - the CLI has no second JSON writer.

Implementation status: `ghostdeps scan` runs the engine today. It calls
core's `analyseDirectory`, which scans the directory through the inert
`FsRepositoryHandle`, runs the JavaScript/TypeScript adapter (the only one
wired so far) offline, and reports skipped files as scan-incompleteness `info`
findings. `--json` prints the schema-stable `AnalysisResult`; without it, scan
prints the canonical repository summary from docs/output-formats.md (#39,
renderer from #109). No recommendation policy exists yet, so every scan also
carries one `info` finding (`recommendation-policy-missing`) saying no
dependency judgements were made. An empty `findings` list must never be read as
an all-clear. A golden file (`packages/cli/test/golden/`) pins the JSON for
`fixtures/js/basic-unused`. Regenerate it with `UPDATE_GOLDEN=1` when adapter
output changes on purpose.

On failure, `--json` emits an error object instead, and never an
`AnalysisResult`:

```json
{
  "error": { "code": "not-implemented", "message": "..." }
}
```

`code` is one of `usage`, `not-implemented`, `error`; the exit code carries
the same information (usage 2, not-implemented 3, error 2). A clean-looking empty result would be
a false all-clear, which is worse than no output.

Analysis is static and works fully offline; registry metadata (when wired
up) flows only through the core metadata service, never from the CLI.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | success; with `--fail-on`, no finding at or above the threshold |
| 1    | scan `--fail-on` threshold met or exceeded                      |
| 2    | usage error, or the scan itself failed (no usable result)       |
| 3    | command not implemented yet                                     |

GhostDeps advises, it does not gate: without `--fail-on`, findings never
produce a non-zero exit on an otherwise successful scan. `ghostdeps scan
--fail-on high` opts into gating for CI: the report prints as usual and the
exit code becomes 1 when any finding reaches the threshold. Severity derives
from finding kind + confidence (`severityOf` in core). Info findings - the
scan-completeness notes from #110 and the no-recommendations notice - are
always severity `info`, so they cannot trip `--fail-on high` (or any
threshold above `info`). `--severity <min>` only filters what is shown;
`--fail-on` always evaluates every finding, shown or not.

## Configuration

Configuration resolves from defaults plus command-line flags; flags always
win. No config file format exists yet. When one is agreed it will slot
between defaults and flags here, and this section will document it.

## Development

```bash
pnpm --filter @ghostdeps/cli build
node packages/cli/dist/main.js --help
```
