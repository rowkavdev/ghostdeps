# GhostDeps as a GitHub Action (#318)

The Action is the second distribution channel for GhostDeps, after the GitHub
App (ADR-0003: the app is primary). It exists for teams that refuse external
services: nothing leaves the runner, no app installation, no webhook endpoint.
The CLI does the analysis; the action posts one `ghostdeps` check run with the
same conclusions, summaries and annotations the app would produce.

## Usage

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
      - uses: rowkavdev/ghostdeps/packages/action@v1
        with:
          path: "."
          # fail-on: high   # opt in to gating; advisory by default
```

The check is advisory: conclusions are `success` (quiet) or `neutral`, never
`failure`. Annotations appear only on high-confidence findings whose evidence
points at a line the PR added, capped at 50 per run - identical to the app.
The `--json` output is never filtered, so there is no `severity` input: the
check renderer already groups findings by confidence.

The check run labels the commit the workflow analysed (`GITHUB_SHA`). With
the default `actions/checkout` on `pull_request` that is the merge ref, so
the run sits on the merge commit like any other CI check. To analyse the PR
head instead, check out `${{ github.event.pull_request.head.sha }}`
explicitly.

## Inputs

| Input          | Default        | Purpose                                                              |
| -------------- | -------------- | -------------------------------------------------------------------- |
| `path`         | `.`            | Directory to scan                                                    |
| `fail-on`      | (empty)        | Fail the step when a finding reaches this severity; empty = advisory |
| `disable-rule` | (empty)        | Comma-separated rule ids to turn off                                 |
| `allowlist`    | (empty)        | Comma-separated `ecosystem:name` entries marked as expected tooling  |
| `check-name`   | `ghostdeps`    | Name of the check run                                                |
| `node-version` | `22`           | Node.js for the analysis (engine requires >= 22)                     |
| `github-token` | `github.token` | Token used to create the check run                                   |

Outputs: `conclusion` (the posted check conclusion), `scan-exit` (the CLI's
exit code).

## Known feature losses versus the GitHub App

Choosing the Action means accepting these. They are structural to running as
a workflow, not bugs.

- **Fork pull requests get no check run.** On `pull_request` events from a
  fork, `GITHUB_TOKEN` is read-only and cannot create check runs. The action
  still reads the PR's added lines (read access works) and degrades to
  workflow-command annotations on those lines (at most 10 notices, GitHub's
  per-step cap) plus the job summary. Install the GitHub App for full fork-PR
  coverage.
- **No re-run button semantics.** The app's check runs can be re-run in
  isolation. A workflow's "Re-run jobs" re-runs the whole workflow - checkout,
  build, scan and all - and the check run exists only as output of that run.
- **No cross-run result cache.** The app serves repeat analyses of an
  unchanged head SHA from a cache (#174). The action analyses on every run.
  The workspace build (`pnpm install` + package builds) is also uncached, so
  budget a few minutes of cold-start per run.
- **No installation model.** There is nothing to install and nothing that
  watches your repo: no push handling outside the workflows you write, no
  org-wide rollout, no per-installation settings. Configuration is the
  action's inputs, per workflow.
- **Actions minutes are yours.** Every run consumes your repo's Actions
  minutes, billed on private repositories. The app absorbs that cost instead.

## How it works

`action.yml` is a composite action: it installs pnpm and Node 22, builds
`@ghostdeps/cli` and `@ghostdeps/action` from the pinned ref, runs
`ghostdeps scan --json` against your checkout, and hands the result to a small
poster that creates one completed check run through the Checks API with the
workflow's `GITHUB_TOKEN`. Rendering comes from `@ghostdeps/checks-renderer`,
the same package the app uses, so conclusions and annotation text cannot drift
between the two channels.
