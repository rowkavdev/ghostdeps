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
      - uses: rowkavdev/ghostdeps/packages/action@main
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

The action is pre-release and has no version tags yet: `@main` follows the
latest main. Pin a full commit SHA (`rowkavdev/ghostdeps/packages/action@<sha>`)
for production workflows.

## Inputs

| Input           | Default        | Purpose                                                                                                                                                                                                                                      |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`          | `.`            | Directory to scan                                                                                                                                                                                                                            |
| `fail-on`       | (empty)        | Fail the step when a finding reaches this severity; empty = advisory                                                                                                                                                                         |
| `disable-rule`  | (empty)        | Comma-separated rule ids to turn off                                                                                                                                                                                                         |
| `allowlist`     | (empty)        | Comma-separated `ecosystem:name` entries marked as expected tooling                                                                                                                                                                          |
| `fixture-roots` | (empty)        | Per-run fixture-scope override (#354): bounded schema-versioned JSON with the `.ghostdeps.json` grammar; replaces the committed roots for the run, `'{"schemaVersion":1,"fixtureRoots":[]}'` clears them. Unset = the committed file governs |
| `check-name`    | `ghostdeps`    | Name of the check run                                                                                                                                                                                                                        |
| `node-version`  | `22`           | Node.js for the analysis (engine requires >= 22)                                                                                                                                                                                             |
| `github-token`  | `github.token` | Token used to create the check run                                                                                                                                                                                                           |

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
  The workspace build is cached per action commit + lockfile + runner OS +
  Node version (#347), so repeat runs skip the install and build; the first
  run on a cold cache still pays the full build.
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

## PR comments: Action or App

Both channels support reporting-only PR comments, updated in place on subsequent
runs, including clean results and incomplete-analysis notes. Choose one comment
publisher per repository to avoid two reports; their markers and bot identities
are separate so neither edits the other's comment.

For the Action, opt in with `comment: "true"` and change `pull-requests: read`
to `pull-requests: write` in the workflow permissions. The default remains off.
Comment failures warn without losing the check or changing fail-on behaviour.
Use the default `github.token` for comment ownership (`github-actions[bot]`).
Serialize runs for each PR with workflow `concurrency` to prevent duplicate
creation by simultaneous jobs. Closed PRs and superseded runs skip commenting.
Fork PRs retain the read-only summary/notice fallback, even with commenting on;
use the App for fork comments. Do not execute fork code with a write token.

For the App, set `GHOSTDEPS_PR_REPORT=true` on its deployment and grant
`issues: write` in the App registration and installation. It uses a separate
repository-scoped issues-only token. `.ghostdeps.json` with `commentsOff: true`
opts out. This reporting mode does not activate fix-preview or apply features.
Existing installations must accept the permission update before delivery works.
