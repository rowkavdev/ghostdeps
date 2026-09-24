# The GhostDeps GitHub App

The GitHub App is the primary interface. Architecture decision: [ADR 0003](adr/0003-github-app-architecture.md). This file is the operational reference.

## Permissions (least privilege)

| Permission          | Access | Why                                                            |
| ------------------- | ------ | -------------------------------------------------------------- |
| Repository contents | Read   | Read manifests, lockfiles and source (codeload tarball + API)  |
| Pull requests       | Read   | Diffs, to analyse dependency changes in the context of the PR  |
| Checks              | Write  | Create check runs and code annotations — the reporting surface |
| Metadata            | Read   | Implicit, granted to every app                                 |

Explicitly **not** requested: `issues`, `actions`, `contents: write`, `pull_requests: write`, administration, secrets, or anything else. M4 remediation PRs will require a deliberate, separately-communicated permission change.

## Webhook events

- `pull_request` (opened, synchronize, reopened)
- `push` (configured branches)
- `check_run` (rerequested: the re-run button on the GhostDeps check)
- `installation`, `installation_repositories` (setup and initial scan)

No other events are subscribed. The manifest ([`packages/github-app/app.yml`](../packages/github-app/app.yml)) lists `pull_request`, `push` and `check_run`. GitHub delivers `installation` and `installation_repositories` to every app automatically, so they cannot be listed. `checks: write` already subscribes the app to `check_run` and `check_suite`; `check_run` is listed anyway because re-runs depend on it, and GitHub sends `rerequested` only to the app that created the run ([GitHub docs](https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run)). `check_suite` is not used: `push` is the push trigger, and using both would double up jobs. A test in `packages/github-app` fails if the manifest and this page drift apart.

## Behaviour

- One `ghostdeps` check run per analysed head SHA; duplicate deliveries collapse idempotently. Jobs are keyed by (repository id, head SHA) only: if the same head is opened against, or retargeted to, a different base, the diff-context analysis from the first base stands until the head moves.
- Conclusions: `success` when nothing notable is found (quiet summary: "No significant dependency issues found."), `neutral` when there are findings worth review. GhostDeps never concludes `failure` — it advises, it does not gate.
- Annotations attach findings to the manifest or source lines they came from.
- PR comments are exceptional, used only when a finding genuinely cannot be expressed as a check annotation.

## Triggers for analysis

Event filtering lives in `packages/github-app/src/events/`. Re-runs bypass the queue's per-SHA duplicate collapse (each click gets its own job key); the reporter still updates the one check run for that SHA. The rules are default-deny: anything not listed here short-circuits quietly with no job and no API calls beyond the changed-file lookup.

| Event                                       | Accepted when                                                                        | Changed files from                                                                   | Result                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------- |
| `pull_request`                              | action is `opened`, `synchronize` or `reopened`                                      | PR files API (first 5 pages / 500 files inside the delivery)                         | job if a manifest/lockfile changed    |
| `push`                                      | branch push to the default branch; not a tag, not a deletion, not a brand-new branch | payload `commits[]` when under 20 commits, otherwise the compare API (capped at 300) | job if a manifest/lockfile changed    |
| `check_run`                                 | action is `rerequested` on the `ghostdeps` check run (the re-run button)             | n/a                                                                                  | job for that head SHA, always         |
| `installation`, `installation_repositories` | always (handled separately)                                                          | n/a                                                                                  | logged no-op in v0.1; full scan later |
| anything else                               | never                                                                                | n/a                                                                                  | skipped                               |

Manifests and lockfiles are matched by file name at any depth: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile`, `Pipfile.lock`, `setup.py`, `setup.cfg`, `requirements*.txt`/`.in`, `requirements/*.txt`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `go.work`.

Renamed files count under both their old and new names. When a file list was capped or the lookup failed, the change is analysed anyway: missing a relevant change is worse than one extra job. The PR file lookup stops after five pages because it runs before the webhook responds and GitHub times deliveries out after 10 seconds. Duplicate deliveries collapse in the job queue (one job per repository id and head SHA).

`check_suite.requested` is deliberately not used as a trigger: `push` already covers it, and using both would double jobs.

## Development

Local development uses [smee.io](https://smee.io) or a tunnel for webhook delivery; credentials come from a development-only GitHub App registration, never the production app. Setup steps will land here with the app skeleton (M0).
