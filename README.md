# GhostDeps

[![CI](https://github.com/rowkavdev/ghostdeps/actions/workflows/ci.yml/badge.svg)](https://github.com/rowkavdev/ghostdeps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

GhostDeps reads your manifests, lockfiles and source code and tells you which declared dependencies your code does not actually need, with the evidence and confidence behind every claim. It runs as a check on your pull requests (GitHub App or Action) and as a local CLI, and it never executes your code.

## Status

Early development. JavaScript/TypeScript, Python, Rust and Go are wired end to end; findings are advisory, and `unused` verdicts stay severity-capped until the nightly corpus check has been green for 14 consecutive days. GhostDeps says what it could not verify instead of guessing - see [Interpreting results](docs/interpreting-results.md) before acting on a finding.

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

The action posts one `ghostdeps` check run, and everything stays inside the job - no external service, nothing leaves the runner. Full input list and the known trade-offs versus the App: [GitHub Action](docs/github-action.md).

## Use the CLI

The CLI is not on npm yet; build it from source (Node 22+, pnpm via corepack):

```bash
git clone https://github.com/rowkavdev/ghostdeps.git
cd ghostdeps
corepack enable && pnpm install && pnpm build
node packages/cli/dist/main.js scan .
```

`scan` prints findings with evidence and confidence. `--json` emits the schema-versioned result; `--fail-on high` opts into a non-zero exit for CI gating. Commands, flags and exit codes: [CLI](docs/cli.md).

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
