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
- If the analysis queue is full, the job is dropped and GitHub will not redeliver. GhostDeps then writes a completed `neutral` run titled "GhostDeps was busy" that asks for a new push, at most one per repository per minute. Writing check runs needs the app id (`APP_ID`).
- Annotations attach findings to the manifest or source lines they came from.
- PR comments are exceptional, used only when a finding genuinely cannot be expressed as a check annotation.

## Triggers for analysis

Event filtering lives in `packages/github-app/src/events/`. Re-runs bypass the queue's per-SHA duplicate collapse (each click gets its own job key); the reporter still updates the one check run for that SHA. The rules are default-deny: anything not listed here short-circuits quietly with no job and no API calls beyond the changed-file lookup.

| Event                                       | Accepted when                                                                        | Changed files from                                                                   | Result                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `pull_request`                              | action is `opened`, `synchronize` or `reopened`                                      | PR files API (first 5 pages / 500 files inside the delivery)                         | job if a manifest/lockfile changed; with the source trigger on (default), also if an analysable source file changed |
| `push`                                      | branch push to the default branch; not a tag, not a deletion, not a brand-new branch | payload `commits[]` when under 20 commits, otherwise the compare API (capped at 300) | job if a manifest/lockfile changed                                                                                  |
| `check_run`                                 | action is `rerequested` on the `ghostdeps` check run (the re-run button)             | n/a                                                                                  | job for that head SHA, always                                                                                       |
| `installation`, `installation_repositories` | always (handled separately)                                                          | n/a                                                                                  | logged no-op in v0.1; full scan later                                                                               |
| anything else                               | never                                                                                | n/a                                                                                  | skipped                                                                                                             |

Manifests and lockfiles are matched by file name at any depth: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile`, `Pipfile.lock`, `setup.py`, `setup.cfg`, `requirements*.txt`/`.in`, `requirements/*.txt`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `go.work`.

**Source trigger (on by default).** Source-only pull requests are analysed too, because removing the last import of a dependency is what makes it unused (#101). Set `GHOSTDEPS_SOURCE_PR_TRIGGER=false` (or `0`, or the app option `sourcePrTrigger: false`) to go back to manifest/lockfile-only triggers. Analysable source files (pull requests only) are the extensions an adapter scans for imports: `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` (JS/TS today, `.d.ts` included). Paths under core's excluded directories (`node_modules`, `dist`, `build`, `vendor` and the rest) and generated bundles (`*.min.js`, `*.map`) don't count. The analysis is PR-scoped through `pullRequestChanges`, so a source-only PR passes an empty change list, never a full-repository verdict, and quiet PRs keep the quiet success check. When the PR's diff was read in full, the worker also passes `extractDependencyChanges(...).sourceLineChanges` as core's `pullRequestSourceChanges`. The adapter reports removed usages from those lines, and core's policy turns a removed last usage into the removed-last-usage verdict. If the diff can't be read in full, a PR that changed a manifest or lockfile (or whose file list was capped, or a re-run without a file list) is analysed in full as before. A PR whose complete file list was source-only stays PR-scoped with an empty change list and a quiet check, so it never gets repository-wide verdicts, but it also gets no removed-last-usage. Pushes stay manifest/lockfile-only. One job per head SHA, as before.

Renamed files count under both their old and new names. When a file list was capped or the lookup failed, the change is analysed anyway: missing a relevant change is worse than one extra job. The PR file lookup stops after five pages because it runs before the webhook responds and GitHub times deliveries out after 10 seconds. Duplicate deliveries collapse in the job queue (one job per repository id and head SHA).

`check_suite.requested` is deliberately not used as a trigger: `push` already covers it, and using both would double jobs.

## Analysis worker

`packages/github-app/src/worker/` turns each queued job into a check run:

1. Mint an installation token scoped to the one repository and to `contents: read` + `checks: write` (the worker never sees the private key).
2. Claim the SHA through the reporter. A SHA that already has our run is skipped; re-runs (`check_run.rerequested`) always get a fresh run.
3. Ask the API for the tarball and follow the redirect only to `https://codeload.github.com`. The body is streamed under a 512 MiB compressed ceiling and a 5 minute timeout.
4. Extract only through core `extractTarball` (no git, no hooks, nothing executed; see the security model).
5. Run `analyseRepositoryIsolated` with the JS/TS adapter in a worker thread (#112). If the checkout scan was truncated or skipped paths, the worker passes core's scan-completeness notes (`scanCompleteness`, plus `scanIncomplete`). Core adds the notes to the result and caps absence findings, so a partial checkout never gets an "unused" verdict and the app never edits the result itself (#136, #161).
6. Verdicts come from core's default recommendation policy (`createDefaultPolicy()`, the same default the CLI scan uses). `unused` findings are capped at medium severity and medium confidence until the corpus check stays green (#173, #178), and never appear on a partial checkout. Set `GHOSTDEPS_RECOMMENDATIONS=false` (or the app option `recommendations: false`) to report facts only.
7. Complete the run. Any failure ends as a `neutral` run titled "GhostDeps could not run" with a plain reason, never a crash or a silent drop. The checkout directory is always removed.

For pull request jobs (and re-runs GitHub links to a same-repo PR), the worker also reads the PR's dependency changes (#115). It fetches the `base...head` compare diff (the same token, `contents: read` only), reads each changed `package.json` at both SHAs as raw text, parses it statically with the JS/TS adapter, and runs core `extractDependencyChanges`. The result goes to core as `AnalyseOptions.pullRequestChanges`, so the policy scopes findings to the dependencies the PR touched, and annotations go only on lines the PR adds. If any part of that can't be read (diff too large, malformed or unreadable manifest), the worker analyses the full repository instead: scoping to a partial list could hide a finding. Fork re-runs carry no PR link and get a full analysis.

## Development

Local development uses [smee.io](https://smee.io) or a tunnel for webhook delivery; credentials come from a development-only GitHub App registration, never the production app. Setup steps will land here with the app skeleton (M0).
