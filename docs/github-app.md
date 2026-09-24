# The GhostDeps GitHub App

The GitHub App is the primary interface. Architecture decision: [ADR 0003](adr/0003-github-app-architecture.md). This file is the operational reference.

## Permissions (least privilege)

| Permission | Access | Why |
| --- | --- | --- |
| Repository contents | Read | Read manifests, lockfiles and source (codeload tarball + API) |
| Pull requests | Read | Diffs, to analyse dependency changes in the context of the PR |
| Checks | Write | Create check runs and code annotations — the reporting surface |
| Metadata | Read | Implicit, granted to every app |

Explicitly **not** requested: `issues`, `actions`, `contents: write`, `pull_requests: write`, administration, secrets, or anything else. M4 remediation PRs will require a deliberate, separately-communicated permission change.

## Webhook events

- `pull_request` (opened, synchronize, reopened)
- `push` (configured branches)
- `installation`, `installation_repositories` (setup and initial scan)

No other events are subscribed.

## Behaviour

- One `ghostdeps` check run per analysed head SHA; duplicate deliveries collapse idempotently.
- Conclusions: `success` when nothing notable is found (quiet summary: "No significant dependency issues found."), `neutral` when there are findings worth review. GhostDeps never concludes `failure` — it advises, it does not gate.
- Annotations attach findings to the manifest or source lines they came from.
- PR comments are exceptional, used only when a finding genuinely cannot be expressed as a check annotation.

## Triggers for analysis

- A PR diff touches a dependency manifest or lockfile → diff-context analysis of the changed dependencies.
- A PR adds a dependency → usage analysis of the new dependency within the PR's code changes.
- Installation or explicit request → full repository scan.

## Development

Local development uses [smee.io](https://smee.io) or a tunnel for webhook delivery; credentials come from a development-only GitHub App registration, never the production app. Setup steps will land here with the app skeleton (M0).
