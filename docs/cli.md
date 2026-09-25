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
`FsRepositoryHandle`, runs the JavaScript/TypeScript, Rust, Go and Python adapters
offline, and reports skipped files as scan-incompleteness `info`
findings. `--json` prints the schema-stable `AnalysisResult`; without it, scan
prints the canonical repository summary from docs/output-formats.md (#39,
renderer from #109). Core's default recommendation policy (#136) turns the
facts into verdicts; conservative rules mean a dependency is only called
`unused` when usage and script/config references were fully analysed -
anything less becomes a low-confidence info note, never a verdict. A golden file (`packages/cli/test/golden/`) pins the JSON for
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

## Flags

`--json` is global; the rest apply to `ghostdeps scan` only.

| Flag                              | Meaning                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `--json`                          | Emit the schema-versioned `AnalysisResult`; never filtered         |
| `--fail-on <min>`                 | Exit 1 when any finding reaches the severity threshold (CI gating) |
| `--severity <min>`                | Filter the human display to findings at or above `<min>`           |
| `--disable-rule <id>`             | Turn a recommendation rule off for the run (repeatable)            |
| `--downgrade <rule>=<confidence>` | Cap a rule's confidence at high, medium or low - never raises it   |
| `--allowlist <ecosystem>:<name>`  | Mark expected tooling; a trailing `*` makes the name a prefix      |

The policy flags are validated loudly: an unknown rule id or ecosystem is a
usage error (exit 2) that names the known values, so a typo can never read as
"rule matched nothing".

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
threshold above `info`). Until the pinned corpus check (#172) has been
green for 14 consecutive days, `unused` findings are capped at `medium`
severity (#173), so they cannot trip `--fail-on high` either. Policy behaviour is adjustable per run (repeatable flags): `--disable-rule
<id>` turns a rule off, `--downgrade <rule>=<confidence>` caps a rule's
confidence (never raises it), and `--allowlist <ecosystem>:<name>` marks a
tooling package as expected (trailing `*` for a prefix). These mirror core's
PolicyConfig (#136); there is still no config file.

`--severity <min>` only filters the human display
(filtered findings are counted under the summary, never silently dropped);
`--json` always prints the complete result, so `--severity` with `--json`
is a usage error rather than a silent lie. `--fail-on` evaluates all counted
findings, shown or not; awareness and factual health observations do not count.

Contract change in #155: scan errors moved from exit 1 to exit 2 (1 is now
dedicated to the `--fail-on` threshold), and usage and scan errors share 2.

## Configuration

Configuration resolves from defaults plus command-line flags; flags always
win. No config file format exists yet. When one is agreed it will slot
between defaults and flags here, and this section will document it.

## Development

```bash
pnpm --filter @ghostdeps/cli build
node packages/cli/dist/main.js --help
```
