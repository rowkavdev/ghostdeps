# GhostDeps

[![CI](https://github.com/rowkavdev/ghostdeps/actions/workflows/ci.yml/badge.svg)](https://github.com/rowkavdev/ghostdeps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/ghost-deps)](https://www.npmjs.com/package/ghost-deps)
[![npm downloads/week](https://img.shields.io/npm/dw/ghost-deps)](https://www.npmjs.com/package/ghost-deps)
[![npm downloads/month](https://img.shields.io/npm/dm/ghost-deps)](https://www.npmjs.com/package/ghost-deps)
[![yearly downloads](https://img.shields.io/npm/dy/ghost-deps)](https://www.npmjs.com/package/ghost-deps)

GhostDeps reads your manifests, lockfiles and source code and tells you which declared dependencies your code does not actually need, with the evidence and confidence behind every claim. It runs as a check on your pull requests (GitHub App or Action) and as a local CLI, and it never executes your code.

## Quickstart

The CLI is on npm as `ghost-deps` and needs Node 22 or newer:

```bash
npx ghost-deps scan .
```

Scanning this repository's own `fixtures/js/basic-unused` fixture prints (ghost-deps 0.1.6):

```text
GhostDeps

Languages:
  JavaScript/TypeScript

Package managers:
  none detected

Direct dependencies:
  1

Transitive dependencies:
  unknown

Findings:
  1 unused
  1 info

Verdicts:
  unused:
    left-pad - left-pad is declared but never used (medium confidence, rule: unused)
      - no import, require or dynamic import of left-pad found
      - no script, bin or config reference to left-pad found
      - left-pad is not on the dev-tooling allowlist

Notes:
    (repository-wide) - unused confidence capped pending corpus validation (high confidence, rule: unused-confidence-capped)
      - 1 unused finding(s) capped at medium confidence
```

Every verdict names the package, the rule, the evidence and a confidence level. Read the evidence before touching a dependency - a finding is not a command to remove a package.

Two things the output never means:

- **No findings is not an all-clear.** It means nothing was reported in the analysed scope. An incomplete scan says what it could not verify instead of guessing.
- **A `neutral` check is not `success`.** On GitHub, `neutral` can mean there are verdicts worth reviewing or that analysis was incomplete. The App never concludes `failure`; read the check title and notes.

To install instead of running through npx: `npm install --global ghost-deps`, then `ghostdeps scan .`.

## Use it as a GitHub Action

```yaml
name: ghostdeps
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read # actions/checkout
  checks: write # create the ghostdeps check run
  pull-requests: read # added-line lookup for PR annotations

jobs:
  ghostdeps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rowkavdev/ghostdeps/packages/action@main
        with:
          path: "."
          # fail-on: high   # opt in to gating; advisory by default
```

The action runs the analysis inside your job; there is no external service to install. It reports through GitHub: a `ghostdeps` check run on your own branches, or workflow annotations and the job summary on fork pull requests, where `GITHUB_TOKEN` is read-only. `@main` follows the latest main - pin a full commit SHA (`rowkavdev/ghostdeps/packages/action@<sha>`) for production workflows. Full input list and the known trade-offs versus the App: [GitHub Action](docs/github-action.md).

## Options and configuration

`scan` is the working command today. The CLI router also lists `inspect`, `graph`, `languages`, `packages` and `explain`, but those are planned routes and currently answer "not implemented yet" (exit 3); `fix` is a later milestone. Everything below applies to `scan`.

### Scan flags

| Flag                              | Default           | Effect                                                                          |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `scan [path]`                     | `.`               | Directory to analyse.                                                           |
| `--json`                          | Off               | Print the complete schema-versioned result; never filtered.                     |
| `--fail-on <severity>`            | Unset (advisory)  | Exit 1 when any verdict finding reaches the threshold. Evaluates all verdict findings, even ones hidden by the display filter. |
| `--severity <severity>`           | Unset (show all)  | Filter the human display only; cannot be combined with `--json`.                |
| `--disable-rule <id>`             | None              | Turn one recommendation rule off for the run; repeatable.                       |
| `--downgrade <rule>=<confidence>` | None              | Cap a rule's confidence at `high`, `medium` or `low`; repeatable, never raises it. |
| `--allowlist <ecosystem>:<name>`  | None              | Mark expected tooling; a trailing `*` matches a name prefix; repeatable.        |
| `--fixture-roots <json>`          | Unset             | Per-run fixture-scope override with the `.ghostdeps.json` grammar; replaces committed roots for the run. |

An unknown rule id or ecosystem is a usage error that names the known values, never a silent no-op. Full semantics: [CLI](docs/cli.md).

### Gating with `--fail-on`

GhostDeps is advisory by default: findings never fail a successful scan unless you set `--fail-on`. One caveat matters for adopters today: `unused` confidence and severity are capped at **medium** pending 14 consecutive green nightly corpus runs, so `--fail-on high` cannot catch a current `unused` finding, while `--fail-on medium` can. Verified against ghost-deps 0.1.6: scanning the `js/basic-unused` fixture exits 0 with `--fail-on high` and 1 with `--fail-on medium`. Info notes (scan-completeness, no-recommendations) are always severity `info` and cannot trip any threshold above `info`.

### Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | Success; with `--fail-on`, no finding reached the threshold      |
| 1    | `--fail-on` threshold met or exceeded                            |
| 2    | Usage error, or the scan itself failed (no usable result)        |
| 3    | Command not implemented yet                                      |

### Repository config: `.ghostdeps.json`

The only repository config file declares fixture-only roots to leave out of dependency analysis. Commit it at the repository root:

```json
{
  "schemaVersion": 1,
  "fixtureRoots": ["fixtures"]
}
```

Roots are exact, repository-relative directory paths - no globs, negation or `..`. Exclusion is always disclosed in the output's `Scan scope` record, never silent, and a run that excluded files caps absence-based verdicts. A malformed config fails the scan with a named error. Beyond scan scope there is no general config file yet: configuration resolves from defaults plus flags, and flags always win. Full grammar and limits: [Configuration](docs/configuration.md).

## False positives and limits

GhostDeps is a static analyzer. It parses source, manifests and lockfiles but never installs dependencies, runs build scripts, executes your code or runs your tests. That is a deliberate safety posture, and it sets the honest limits:

- **It cannot see runtime behavior.** Dynamic imports, plugin systems, convention-based loading (frameworks, test runners, bundler config) and packages consumed by external tools can make a genuinely used package look unreferenced.
- **It does not certify removal.** Even a high-confidence finding means the stated evidence and coverage conditions were met - not that deletion preserves behavior. A package with no finding has not been certified necessary either.
- **Incomplete analysis stays visible.** Skipped files, unsupported capabilities, timeouts and missing lockfiles are reported as notes, lower confidence or a withheld verdict, not filled in with a guess. Transitive counts without a usable lockfile are `unknown`, not zero.

Before removing a flagged package, validate manually:

1. Search the repo for dynamic or runtime references: `import(`, `require(` with a computed name, plugin registries, and script, bin and config references in `package.json`, CI and tooling config.
2. Remove the package in a scratch branch and update the lockfile with your package manager.
3. Run your full build and test suite - only your own tests can prove removal is safe, and GhostDeps does not run them.

How verdicts, confidence, notes and package facts work: [Interpreting results](docs/interpreting-results.md).

## Status

Early development. JavaScript/TypeScript, Python, Rust and Go are wired end to end; findings are advisory, and `unused` confidence and severity stay capped at medium pending 14 consecutive green nightly corpus runs. GhostDeps says what it could not verify instead of guessing.

## What the check looks like

Findings land on a `ghostdeps` check run with an advisory conclusion: `success` (quiet) or `neutral`, never a blocking failure. Annotations appear only on high-confidence findings whose evidence points at a line the PR added. Every finding carries its evidence, a confidence level and stated limitations, and an incomplete scan says what it could not verify rather than calling packages unused. How to read verdict kinds, confidence levels and notes: [Interpreting results](docs/interpreting-results.md).

## Documentation

**Use GhostDeps**

- [GitHub App](docs/github-app.md) and [self-hosting it](docs/deployment.md)
- [GitHub Action](docs/github-action.md)
- [CLI](docs/cli.md), [configuration](docs/configuration.md) and [output formats](docs/output-formats.md)
- [Interpreting results](docs/interpreting-results.md)

**How it works**

- [Architecture](docs/architecture.md) and [analysis engine](docs/analysis-engine.md)
- [Recommendation policy](docs/recommendation-policy.md)
- [Security model](docs/security-model.md) - static analysis only, untrusted input, no code execution

**Build and contribute**

- [Development](docs/development.md) and [contributing adapters](docs/contributing-adapters.md)
- [Decisions (ADRs)](docs/adr/)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
