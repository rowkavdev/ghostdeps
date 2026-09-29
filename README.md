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

## Status

Early development. JavaScript/TypeScript, Python, Rust and Go are wired end to end; findings are advisory, and `unused` confidence and severity stay capped at medium pending 14 consecutive green nightly corpus runs. GhostDeps says what it could not verify instead of guessing - see [Interpreting results](docs/interpreting-results.md) before acting on a finding.

## What the check looks like

Findings land on a `ghostdeps` check run with an advisory conclusion: `success` (quiet) or `neutral`, never a blocking failure. Annotations appear only on high-confidence findings whose evidence points at a line the PR added. Every finding carries its evidence, a confidence level and stated limitations, and an incomplete scan says what it could not verify rather than calling packages unused. How to read verdict kinds, confidence levels and notes: [Interpreting results](docs/interpreting-results.md).

## Documentation

**Use GhostDeps**

- [GitHub App](docs/github-app.md) and [self-hosting it](docs/deployment.md)
- [GitHub Action](docs/github-action.md)
- [CLI](docs/cli.md) and [output formats](docs/output-formats.md)
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
